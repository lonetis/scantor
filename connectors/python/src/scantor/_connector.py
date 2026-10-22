"""The connector side of the protocol: transport, routing and the request loop (docs/protocol.md).

Threads: a reader thread reads fd 3 continuously (so `cancel` and template items arrive while a write
blocks) and only routes messages; the main thread runs the handshake and serves one request at a time,
running async task code on a persistent event loop. Writes to fd 4 are synchronous and serialised.
"""

import asyncio
import itertools
import json
import os
import platform
import queue
import sys
import threading
from collections.abc import Awaitable, Mapping
from typing import Any, BinaryIO

from scantor._json import describe_exception, encode_line
from scantor._request import ActiveRequest, CallHandler, Limits
from scantor._version import __version__

PROTOCOL_MIN = 1
PROTOCOL_MAX = 1

_REPLY_TYPES = frozenset(("fileRef", "templateItem", "templateDone"))


def is_request_id(value: object) -> bool:
    return (
        isinstance(value, str)
        and 1 <= len(value) <= 64
        and all(char.isascii() and (char.isalnum() or char in "._:-") for char in value)
    )


class Connector:
    """Transport plus routing; implements the `Wire` interface used by ctx.files and templates."""

    def __init__(self, reader: BinaryIO, out_fd: int) -> None:
        self._reader = reader
        self._out_fd = out_fd
        self._write_lock = threading.Lock()
        self._limits = Limits()
        self._call_ids = itertools.count(1)
        self._calls: dict[str, CallHandler] = {}
        self._calls_lock = threading.Lock()
        self._inbox: queue.SimpleQueue[dict[str, Any] | None] = queue.SimpleQueue()
        self._active: ActiveRequest | None = None
        self._active_lock = threading.Lock()
        self._handshake_done = False
        self._loop: asyncio.AbstractEventLoop | None = None

    @classmethod
    def open(cls, in_fd: int, out_fd: int) -> Connector:
        # Child processes of task code (browsers, tools) must not inherit the protocol pipes.
        os.set_inheritable(in_fd, False)
        os.set_inheritable(out_fd, False)
        return cls(os.fdopen(in_fd, "rb", buffering=1 << 16), out_fd)

    # Wire interface -------------------------------------------------------------------------------

    @property
    def limits(self) -> Limits:
        return self._limits

    def send(self, message: Mapping[str, Any]) -> None:
        self.send_line(encode_line(message))

    def send_line(self, line: bytes) -> None:
        with self._write_lock:
            view = memoryview(line)
            while view:
                written = os.write(self._out_fd, view)
                view = view[written:]

    def next_call_id(self) -> str:
        return f"c{next(self._call_ids)}"

    def register_call(self, call_id: str, handler: CallHandler) -> None:
        with self._calls_lock:
            self._calls[call_id] = handler

    def unregister_call(self, call_id: str) -> None:
        with self._calls_lock:
            self._calls.pop(call_id, None)

    # Reader thread --------------------------------------------------------------------------------

    def start_reader(self) -> None:
        threading.Thread(target=self._read_loop, name="scantor-protocol-reader", daemon=True).start()

    def _read_loop(self) -> None:
        try:
            for line in self._reader:
                try:
                    message = json.loads(line)
                except ValueError:
                    self.log_internal("warning", "ignoring a protocol line that is not valid JSON")
                    continue
                if isinstance(message, dict):
                    self._route(message)
        except OSError as exc:
            self.log_internal("error", f"reading the protocol input failed: {exc}")
        finally:
            self._on_input_closed()

    def _route(self, message: dict[str, Any]) -> None:
        kind = message.get("type")
        message_id = message.get("id")
        if kind == "cancel":
            reason = message.get("reason")
            self._cancel(message_id, reason if isinstance(reason, str) else "stop")
            return
        if kind in _REPLY_TYPES or (kind == "error" and self._handshake_done):
            with self._calls_lock:
                handler = self._calls.get(message_id) if isinstance(message_id, str) else None
            # Replies for streams that already ended (items after templateCancel) are dropped.
            if handler is not None:
                handler.on_reply(message)
            return
        self._inbox.put(message)

    def _cancel(self, request_id: object, reason: str) -> None:
        with self._active_lock:
            active = self._active
        if active is not None and active.id == request_id:
            active.scope.cancel(reason)

    def _on_input_closed(self) -> None:
        self._inbox.put(None)
        with self._calls_lock:
            handlers = list(self._calls.values())
        for handler in handlers:
            handler.on_closed()
        with self._active_lock:
            active = self._active
        if active is not None:
            active.scope.cancel("stop")

    def log_internal(self, level: str, message: str) -> None:
        """A connector log line outside any request (worker log only)."""
        try:
            self.send({"type": "log", "parent": None, "level": level, "message": message})
        except OSError:
            print(f"scantor: {message}", file=sys.stderr)

    # Main thread ----------------------------------------------------------------------------------

    def handshake(self) -> int | None:
        """Send `hello` and wait for `welcome`; returns an exit code when the process must stop."""
        self.send(
            {
                "type": "hello",
                "id": "hello",
                "protocol": {"min": PROTOCOL_MIN, "max": PROTOCOL_MAX},
                "connector": {
                    "language": "python",
                    "version": __version__,
                    "runtime": f"{sys.implementation.name} {platform.python_version()}"[:64],
                },
                "pid": os.getpid(),
            }
        )
        message = self._inbox.get()
        if message is None:
            return 0
        if message.get("type") == "error":
            return 1
        version = message.get("protocolVersion")
        if message.get("type") != "welcome" or not (
            isinstance(version, int) and PROTOCOL_MIN <= version <= PROTOCOL_MAX
        ):
            self.send(
                {
                    "type": "error",
                    "id": "hello",
                    "error": {
                        "type": "validation",
                        "message": f"expected welcome with protocol {PROTOCOL_MIN}..{PROTOCOL_MAX}, "
                        f"got {message.get('type')!r} with protocol {version!r}",
                    },
                }
            )
            return 1
        limits = message.get("limits")
        self._limits = Limits.from_welcome(limits if isinstance(limits, dict) else {})
        self._handshake_done = True
        return None

    def next_request(self) -> dict[str, Any] | None:
        """The next runtime request, or None once the input is closed."""
        return self._inbox.get()

    def activate(self, request: ActiveRequest) -> None:
        with self._active_lock:
            self._active = request

    def deactivate(self) -> None:
        with self._active_lock:
            self._active = None

    def run_async[T](self, request: ActiveRequest, awaitable: Awaitable[T]) -> T:
        """Run task code's awaitable on the connector's event loop, cancellable through the request."""
        # A plain loop rather than asyncio.Runner: the runner traps SIGINT while it runs, and connectors
        # keep the default signal dispositions (docs/protocol.md §11).
        if self._loop is None:
            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)

        async def guarded() -> T:
            task = asyncio.current_task()
            if task is not None:
                request.scope.bind(task)
            try:
                return await awaitable
            finally:
                request.scope.unbind()

        return self._loop.run_until_complete(guarded())

    def close(self) -> None:
        """Close the event loop: cancel what task code left running and finalise async generators."""
        loop, self._loop = self._loop, None
        if loop is None:
            return
        try:
            pending = asyncio.all_tasks(loop)
            for task in pending:
                task.cancel()
            loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            loop.run_until_complete(loop.shutdown_asyncgens())
        finally:
            asyncio.set_event_loop(None)
            loop.close()

    def reply_error(self, request_id: str, error: Mapping[str, Any]) -> None:
        self.send({"type": "error", "id": request_id, "error": dict(error)})

    def internal_error(self, request_id: str, exc: BaseException) -> None:
        self.reply_error(
            request_id, {"type": "taskError", "message": f"internal connector error: {describe_exception(exc)}"}
        )
