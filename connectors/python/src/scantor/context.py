"""The per-call context passed to `schedule` and `run`."""

import asyncio
import concurrent.futures
import json
import math
import os
import pathlib
import shutil
import tempfile
import time
from collections.abc import Mapping
from typing import Any, Literal

import pydantic

from scantor._json import truncate
from scantor._request import ActiveRequest
from scantor.errors import ScantorError
from scantor.models import FileRef

LogLevel = Literal["debug", "info", "warning", "error"]

_LOG_LEVELS = frozenset(("debug", "info", "warning", "error"))
_MAX_LOG_MESSAGE = 16384
_MAX_LOG_FIELDS = 16384
_MAX_PROGRESS_MESSAGE = 256
_MAX_FILE_NAME = 255
_MAX_CONTENT_TYPE = 255

FileData = bytes | bytearray | memoryview | str | os.PathLike[str]


class Files:
    """Stores files with the current analysis (`ctx.files`); only available in `run`."""

    def __init__(self, request: ActiveRequest) -> None:
        self._request = request

    def put(self, name: str, data: FileData, content_type: str | None = None) -> FileRef:
        """Store `data` as file `name` and return its `FileRef` for use in the result.

        `data` is the content (`bytes`, or `str` as UTF-8 text) or the path of an existing file
        (`os.PathLike`). The content is copied at once, so later changes to a path do not matter. Files
        are uploaded only after `run` succeeded. `content_type` defaults to `application/octet-stream`;
        pass it explicitly for images to be shown inline. A name or content type that breaks the rules
        (1-255 characters each) raises a `ScantorError` of type `validation` before anything is stored.
        """
        request = self._request
        if request.kind != "run":
            raise ScantorError("validation", "files are only available in run")
        _check_file_name(name)
        _check_content_type(name, content_type)
        files_dir = request.files_dir
        if files_dir is None:
            raise ScantorError("validation", "the runtime provided no files directory for this run")
        index = request.reserve_file(name)
        try:
            path = files_dir / f"{index}-{_safe_file_component(name)}"
            _write_file(path, data, request.wire.limits.max_file_bytes, name)
            return self._register(name, path, content_type)
        except BaseException:
            request.release_file(name)
            raise

    async def aput(self, name: str, data: FileData, content_type: str | None = None) -> FileRef:
        """`put` for async code: copies and registers the file without blocking the event loop."""
        return await asyncio.to_thread(self.put, name, data, content_type)

    def _register(self, name: str, path: pathlib.Path, content_type: str | None) -> FileRef:
        request = self._request
        wire = request.wire
        call_id = wire.next_call_id()
        reply = _FileReply()
        wire.register_call(call_id, reply)
        try:
            sent = request.send_scoped(
                {
                    "type": "file",
                    "id": call_id,
                    "parent": request.id,
                    "name": name,
                    "path": str(path),
                    "contentType": content_type,
                }
            )
            if not sent:
                raise ScantorError("validation", "the run has ended; files can only be stored during run")
            return reply.future.result()
        finally:
            wire.unregister_call(call_id)


class _FileReply:
    def __init__(self) -> None:
        self.future: concurrent.futures.Future[FileRef] = concurrent.futures.Future()

    def on_reply(self, message: Mapping[str, Any]) -> None:
        if self.future.done():
            return
        if message.get("type") == "fileRef":
            try:
                self.future.set_result(FileRef.model_validate(message.get("fileRef")))
            except pydantic.ValidationError as exc:
                self.future.set_exception(ScantorError("platform", f"invalid fileRef from the runtime: {exc}"))
            return
        error = message.get("error")
        error_map: Mapping[str, Any] = error if isinstance(error, Mapping) else {}
        self.future.set_exception(
            ScantorError(
                str(error_map.get("type", "platform")),
                str(error_map.get("message", "file registration failed")),
                retryable=bool(error_map.get("retryable", False)),
            )
        )

    def on_closed(self) -> None:
        if not self.future.done():
            self.future.set_exception(ScantorError("platform", "the runtime closed the connection", retryable=True))


def _check_file_name(name: str) -> None:
    if not isinstance(name, str) or not 1 <= len(name) <= _MAX_FILE_NAME:
        raise ScantorError("validation", f"file name {name!r} must be 1-255 characters long")
    if "/" in name or "\\" in name or "\x00" in name:
        raise ScantorError("validation", f"file name {name!r} must not contain '/', '\\' or NUL")


def _check_content_type(name: str, content_type: object) -> None:
    # The runtime treats a `file` message that breaks its schema as a protocol violation and kills the
    # process, so a value from a scanned server (a Content-Type header) must fail here, catchable.
    if content_type is None:
        return
    if not isinstance(content_type, str):
        raise ScantorError(
            "validation", f"file {name!r}: the content type must be a str or None, not {type(content_type).__name__}"
        )
    if not 1 <= len(content_type) <= _MAX_CONTENT_TYPE:
        raise ScantorError(
            "validation",
            f"file {name!r}: the content type must be 1-255 characters long, not {len(content_type)}; "
            "pass None for application/octet-stream",
        )


def _safe_file_component(name: str) -> str:
    # The on-disk name only has to be unique and valid; keep it readable but within 200 bytes.
    return name.encode("utf-8")[:200].decode("utf-8", errors="ignore") or "file"


def _write_file(path: pathlib.Path, data: FileData, max_bytes: int, name: str) -> None:
    if isinstance(data, str):
        data = data.encode("utf-8")
    if isinstance(data, bytes | bytearray | memoryview):
        size = memoryview(data).nbytes
        _check_size(name, size, max_bytes)
        path.write_bytes(data)
        return
    if isinstance(data, os.PathLike):
        source = pathlib.Path(os.fspath(data))
        if not source.is_file():
            raise ScantorError("validation", f"file {name!r}: {source} is not a regular file")
        _check_size(name, source.stat().st_size, max_bytes)
        shutil.copyfile(source, path)
        _check_size(name, path.stat().st_size, max_bytes)
        return
    raise TypeError(f"file data must be bytes, str or os.PathLike, not {type(data).__name__}")


def _check_size(name: str, size: int, max_bytes: int) -> None:
    if size > max_bytes:
        raise ScantorError("validation", f"file {name} is {size} bytes; the limit is {max_bytes}")


class Context:
    """The context of one `schedule` or `run` call. It is passed per call, never global."""

    def __init__(self, request: ActiveRequest) -> None:
        self._request = request
        ctx = request.ctx
        self.scan_id: str = str(ctx.get("scanId", ""))
        """The scan id (`local` in `scantor dev run`, the test-run id in test runs)."""
        self.analysis_id: str | None = _optional_str(ctx.get("analysisId"))
        """`<scanId>-<seq>`; `None` in `schedule`."""
        self.seq: int | None = _optional_int(ctx.get("seq"))
        """The analysis seq (0-based position in the schedule stream); `None` in `schedule`."""
        attempt = _optional_int(ctx.get("attempt"))
        self.attempt: int = attempt if attempt is not None else 1
        """1-based attempt of this run; in `schedule` the scheduler start count."""
        self.deadline: float | None = request.deadline
        """Epoch seconds at which the call ends, or `None` (schedule, `scantor dev debug`)."""
        self.tmp_dir: pathlib.Path = pathlib.Path(str(ctx.get("tmpDir") or tempfile.gettempdir()))
        """An empty directory private to this call; deleted afterwards."""
        self.files: Files = Files(request)
        """Stores files with the analysis (only in `run`)."""

    @property
    def cancelled(self) -> bool:
        """True once the call was cancelled (deadline reached or the worker is stopping).

        Async code receives `asyncio.CancelledError` at its next await instead; synchronous code should
        check this flag in long loops and stop by raising.
        """
        return self._request.scope.cancelled

    def remaining(self) -> float | None:
        """Seconds until the deadline (never negative), or `None` without a deadline."""
        if self.deadline is None:
            return None
        return max(0.0, self.deadline - time.time())

    def log(self, level: LogLevel, message: str, **fields: Any) -> None:
        """Write a structured log line to the analysis log (`[level] message key=value ...`)."""
        if level not in _LOG_LEVELS:
            raise ValueError(f"log level must be one of debug, info, warning, error, not {level!r}")
        payload: dict[str, Any] = {
            "type": "log",
            "parent": self._request.id,
            "level": level,
            "message": truncate(str(message), _MAX_LOG_MESSAGE),
        }
        if fields:
            try:
                encoded = json.dumps(fields, default=str, allow_nan=False, separators=(",", ":"))
            except ValueError:  # NaN or infinity somewhere: keep every value readable as text
                encoded = json.dumps({key: str(value) for key, value in fields.items()}, separators=(",", ":"))
            if len(encoded) <= _MAX_LOG_FIELDS:
                payload["fields"] = json.loads(encoded)
            else:
                payload["message"] = truncate(payload["message"] + " [fields truncated]", _MAX_LOG_MESSAGE)
        if not self._request.send_scoped(payload):
            # Logged from a thread that outlived its call: the line goes to the worker log only.
            self._request.wire.send({**payload, "parent": None})

    def progress(self, fraction: float | None = None, message: str | None = None) -> None:
        """Report progress of the running analysis (0…1, `None` = unknown); ignored in `schedule`."""
        if self._request.kind != "run":
            return
        value: float | None = None
        if fraction is not None and not math.isnan(fraction):
            value = min(1.0, max(0.0, float(fraction)))
        self._request.send_scoped(
            {
                "type": "progress",
                "parent": self._request.id,
                "fraction": value,
                "message": None if message is None else truncate(str(message), _MAX_PROGRESS_MESSAGE),
            }
        )


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _optional_int(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None
