"""State of the runtime request a connector process is serving (one at a time in protocol v1)."""

import asyncio
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol

from scantor.errors import ScantorError

RequestKind = Literal["describe", "schedule", "run"]


class Cancelled(BaseException):
    """Raised inside synchronous connector waits once the request was cancelled.

    A BaseException, like `asyncio.CancelledError`, so that `except Exception` in task code does not
    swallow it.
    """


@dataclass(frozen=True)
class Limits:
    """The limits announced in `welcome` (defaults: protocol v1 and `.env.example`)."""

    max_line_bytes: int = 8 * 1024 * 1024
    max_result_bytes: int = 1024 * 1024
    max_analysis_config_bytes: int = 64 * 1024
    max_file_bytes: int = 1024 * 1024 * 1024
    max_files_per_analysis: int = 100

    @classmethod
    def from_welcome(cls, limits: Mapping[str, Any]) -> Limits:
        default = cls()

        def pick(key: str, fallback: int) -> int:
            value = limits.get(key)
            return value if isinstance(value, int) and not isinstance(value, bool) else fallback

        return cls(
            max_line_bytes=pick("maxLineBytes", default.max_line_bytes),
            max_result_bytes=pick("maxResultBytes", default.max_result_bytes),
            max_analysis_config_bytes=pick("maxAnalysisConfigBytes", default.max_analysis_config_bytes),
            max_file_bytes=pick("maxFileBytes", default.max_file_bytes),
            max_files_per_analysis=pick("maxFilesPerAnalysis", default.max_files_per_analysis),
        )


class Wire(Protocol):
    """What request-scoped helpers (ctx.files, template streams) need from the connector."""

    @property
    def limits(self) -> Limits: ...

    def send(self, message: Mapping[str, Any]) -> None: ...

    def send_line(self, line: bytes) -> None: ...

    def next_call_id(self) -> str: ...

    def register_call(self, call_id: str, handler: CallHandler) -> None: ...

    def unregister_call(self, call_id: str) -> None: ...


class CallHandler(Protocol):
    """Receives the runtime's replies to one connector-initiated request (`file`, `template`)."""

    def on_reply(self, message: Mapping[str, Any]) -> None: ...

    def on_closed(self) -> None: ...


class CancelScope:
    """Cancellation of one request: the `cancel` message or the connector's own deadline timer.

    Synchronous code observes `cancelled`; an async call bound with `bind` is cancelled at its next await.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._event = threading.Event()
        self._reason: str | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._task: asyncio.Task[Any] | None = None

    @property
    def reason(self) -> str | None:
        return self._reason

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def cancel(self, reason: str) -> None:
        with self._lock:
            if self._reason is not None:
                return
            self._reason = reason
            self._event.set()
            loop, task = self._loop, self._task
        if loop is not None and task is not None and not loop.is_closed():
            loop.call_soon_threadsafe(task.cancel)

    def bind(self, task: asyncio.Task[Any]) -> None:
        """Attach the asyncio task running the request; cancels it at once if already cancelled."""
        with self._lock:
            self._loop = task.get_loop()
            self._task = task
            cancelled = self._reason is not None
        if cancelled:
            task.cancel()

    def unbind(self) -> None:
        with self._lock:
            self._loop = None
            self._task = None

    def wait(self, timeout: float) -> bool:
        """Block up to `timeout` seconds; True when the request was cancelled."""
        return self._event.wait(timeout)

    def raise_if_cancelled(self) -> None:
        if self._event.is_set():
            raise Cancelled(self._reason)


class ActiveRequest:
    """One runtime request (`describe`, `schedule` or `run`) while it is being served.

    Messages that name the request as `parent` go through `send_scoped`, and the final reply through
    `end`, under one lock: once the reply is written, no message refers to the request any more
    (the runtime treats that as a protocol violation).
    """

    def __init__(self, wire: Wire, request_id: str, kind: RequestKind, ctx: Mapping[str, Any]) -> None:
        self.wire = wire
        self.id = request_id
        self.kind: RequestKind = kind
        self.ctx = ctx
        self.scope = CancelScope()
        self._lock = threading.Lock()
        self._scope_lock = threading.Lock()
        self._open = True
        self._file_names: set[str] = set()
        self._file_counter = 0
        self._template_calls: list[TemplateCallLike] = []
        self._timer: threading.Timer | None = None

    @property
    def deadline(self) -> float | None:
        deadline_ms = self.ctx.get("deadlineMs")
        if isinstance(deadline_ms, int | float) and not isinstance(deadline_ms, bool):
            return deadline_ms / 1000.0
        return None

    @property
    def files_dir(self) -> Path | None:
        files_dir = self.ctx.get("filesDir")
        return Path(files_dir) if isinstance(files_dir, str) and files_dir else None

    @property
    def is_open(self) -> bool:
        return self._open

    def start_deadline_timer(self) -> None:
        deadline = self.deadline
        if deadline is None:
            return
        self._timer = threading.Timer(max(0.0, deadline - time.time()), self.scope.cancel, ("deadline",))
        self._timer.daemon = True
        self._timer.start()

    def send_scoped(self, message: Mapping[str, Any]) -> bool:
        """Send a message that refers to this request; False (nothing sent) once it has ended."""
        with self._scope_lock:
            if not self._open:
                return False
            self.wire.send(message)
            return True

    def end(self, reply: bytes) -> None:
        """Write the request's final reply line; later scoped messages are no longer sent."""
        with self._scope_lock:
            self._open = False
            self.wire.send_line(reply)

    def reserve_file(self, name: str) -> int:
        """Reserve a unique file name within the execution; returns a unique on-disk index."""
        limit = self.wire.limits.max_files_per_analysis
        with self._lock:
            if name in self._file_names:
                raise ScantorError("validation", f"file name {name!r} is already used by this analysis")
            if len(self._file_names) >= limit:
                raise ScantorError(
                    "validation", f"an analysis can store at most {limit} files; {name!r} is one too many"
                )
            self._file_names.add(name)
            index = self._file_counter
            self._file_counter += 1
            return index

    def release_file(self, name: str) -> None:
        with self._lock:
            self._file_names.discard(name)

    def track_template_call(self, call: TemplateCallLike) -> None:
        with self._lock:
            self._template_calls.append(call)

    def finish(self) -> None:
        """Stop the deadline timer and end every template stream still open (before the reply)."""
        if self._timer is not None:
            self._timer.cancel()
        with self._lock:
            calls = list(self._template_calls)
        for call in calls:
            call.close()


class TemplateCallLike(Protocol):
    def close(self) -> None: ...
