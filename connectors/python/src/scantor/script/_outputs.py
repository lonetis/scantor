"""`ctx.outputs`: files a script run stores, uploaded in parts while they are written."""

import contextlib
import hashlib
import io
import mimetypes
import os
import pathlib
from collections.abc import Iterator
from typing import Any, BinaryIO, Literal, TextIO, cast, overload

from scantor._json import describe_exception
from scantor.script._errors import ScriptError
from scantor.script._http import HttpClient, UrlExpiredError
from scantor.script._models import FileAccess, Output, OutputInfo
from scantor.script._stream import warn

OutputData = bytes | bytearray | memoryview | str | os.PathLike[str]
MAX_NAME = 255
MAX_CONTENT_TYPE = 255
PARTIAL_SUFFIX = ".partial"


def check_name(name: object) -> str:
    if not isinstance(name, str) or not 1 <= len(name) <= MAX_NAME:
        raise ValueError(f"output name {name!r} must be a str of 1-255 characters")
    if "/" in name or "\\" in name or "\x00" in name:
        raise ValueError(f"output name {name!r} must not contain '/', '\\' or NUL")
    return name


def partial_name(name: str) -> str:
    return name[: MAX_NAME - len(PARTIAL_SUFFIX)] + PARTIAL_SUFFIX


def _content_type(name: str, content_type: object) -> str:
    if content_type is None:
        return mimetypes.guess_type(name, strict=False)[0] or "application/octet-stream"
    if not isinstance(content_type, str) or not 1 <= len(content_type) <= MAX_CONTENT_TYPE:
        raise ValueError(f"output {name!r}: the content type must be a str of 1-255 characters or None")
    return content_type


class Outputs:
    """Files this run stores (`ctx.outputs`), downloadable from the run page, the CLI and MCP.

    `put` stores a whole value or file, `open` streams: parts of `partBytes` are uploaded while the
    file is written, so an output never has to fit in memory or on disk. Names are unique per run.
    """

    def __init__(self, client: HttpClient, access: FileAccess | None, part_bytes: int) -> None:
        self._client = client
        self._access = access
        self._part_bytes = part_bytes

    def put(self, name: str, data: OutputData, content_type: str | None = None) -> Output:
        """Store `data` (bytes, `str` as UTF-8, or the path of a file) as output `name`.

        `content_type` defaults to the type of the name's extension (`report.csv`: text/csv), else
        application/octet-stream.
        """
        writer = _OutputWriter(self, check_name(name), _content_type(name, content_type))
        if isinstance(data, str):
            data = data.encode("utf-8")
        if isinstance(data, bytes | bytearray | memoryview):
            writer.write(data)
        elif isinstance(data, os.PathLike):
            with pathlib.Path(os.fspath(data)).open("rb") as source:
                while chunk := source.read(self._part_bytes):
                    writer.write(chunk)
        else:
            raise TypeError(f"output data must be bytes, str or os.PathLike, not {type(data).__name__}")
        return writer.complete()

    @overload
    def open(
        self,
        name: str,
        mode: Literal["w"] = "w",
        *,
        encoding: str = "utf-8",
        newline: str | None = "",
        content_type: str | None = None,
    ) -> contextlib.AbstractContextManager[TextIO]: ...
    @overload
    def open(
        self,
        name: str,
        mode: Literal["wb"],
        *,
        encoding: str = "utf-8",
        newline: str | None = "",
        content_type: str | None = None,
    ) -> contextlib.AbstractContextManager[BinaryIO]: ...
    def open(
        self,
        name: str,
        mode: Literal["w", "wb"] = "w",
        *,
        encoding: str = "utf-8",
        newline: str | None = "",
        content_type: str | None = None,
    ) -> contextlib.AbstractContextManager[Any]:
        """Write output `name` as a file: `with ctx.outputs.open("report.csv") as file: ...`.

        Text mode (`"w"`, the default) encodes with `encoding` and does not translate newlines
        (`newline=""`, what `csv.writer` expects); `"wb"` takes bytes. The output is stored when the
        block ends; when it ends with an exception (or `Cancelled`), the bytes written so far are stored
        as `<name>.partial` and the exception propagates.
        """
        if mode not in {"w", "wb"}:
            raise ValueError(f"output mode must be 'w' or 'wb', not {mode!r}")
        writer = _OutputWriter(self, check_name(name), _content_type(name, content_type))
        return self._writing(writer, mode, encoding, newline)

    @contextlib.contextmanager
    def _writing(self, writer: _OutputWriter, mode: str, encoding: str, newline: str | None) -> Iterator[Any]:
        stream: Any = writer if mode == "wb" else io.TextIOWrapper(writer, encoding=encoding, newline=newline)
        try:
            yield stream
            stream.flush()
        except BaseException:
            writer.store_partial(stream)
            raise
        writer.complete()

    def _created(self, name: str, content_type: str) -> str:
        reply = self._client.call("POST", "/outputs", {"name": name, "contentType": content_type})
        part_bytes = reply.get("partBytes")
        if isinstance(part_bytes, int) and part_bytes > 0:
            self._part_bytes = part_bytes
        return str(reply["output"]["id"])


class _OutputWriter(io.BufferedIOBase):
    """Buffers up to one part and uploads full parts; `complete` uploads the rest and stores the output.

    Parts are uploaded as copies and leave the buffer only once uploaded, so after a failed upload the
    buffer still holds every byte that is not stored yet. The SHA-256 covers the uploaded bytes.
    """

    def __init__(self, outputs: Outputs, name: str, content_type: str) -> None:
        super().__init__()
        self._outputs = outputs
        self._client = outputs._client  # the writer belongs to Outputs
        self.name = name
        self._content_type = content_type
        self._output_id = outputs._created(name, content_type)
        self._part_bytes = outputs._part_bytes
        self._buffer = bytearray()
        self._uploaded_digest = hashlib.sha256()
        self._uploaded_bytes = 0
        self._parts: list[dict[str, Any]] = []
        self._size = 0
        self._finished = False

    def writable(self) -> bool:
        return True

    def write(self, data: Any) -> int:
        if self._finished:
            raise ValueError(f"output {self.name!r} is already stored")
        view = memoryview(data).cast("B")
        self._buffer += view
        self._size += len(view)
        while len(self._buffer) >= self._part_bytes:
            self._upload(bytes(self._buffer[: self._part_bytes]))
            del self._buffer[: self._part_bytes]
        return len(view)

    def close(self) -> None:
        # Closing the stream (directly, or through a TextIOWrapper) does not store the output; the end
        # of the `with` block decides between the output and `<name>.partial`.
        if not self.closed:
            super().close()

    def complete(self, *, as_name: str | None = None) -> Output:
        if self._finished:
            raise ValueError(f"output {self.name!r} is already stored")
        self._finished = True
        if self._size == 0:
            raise ValueError(f"output {self.name!r} is empty; an output holds at least one byte")
        self._upload_rest()
        return self._complete_parts(as_name)

    def store_partial(self, stream: Any) -> None:
        """Store what was written as `<name>.partial`; failures are logged (an exception is propagating).

        While no part is uploaded yet, the bytes go into a new output of that name (the pending upload of
        `<name>` is dropped when the run ends); otherwise the upload is completed under the new name, with
        only the parts already uploaded when the rest cannot be uploaded. Nothing raised here replaces the
        propagating exception.
        """
        with contextlib.suppress(Exception):
            stream.flush()
        if self._finished or self._size == 0:
            return
        self._finished = True
        try:
            output = self._store_as(partial_name(self.name))
        except Exception as exc:
            warn(f"could not store the partial output {self.name!r}: {describe_exception(exc)}")
            return
        warn(f"stored the incomplete output {self.name!r} as {output.name!r} ({output.size} bytes)")

    def _store_as(self, name: str) -> Output:
        if not self._parts:
            partial = _OutputWriter(self._outputs, name, self._content_type)
            partial.write(bytes(self._buffer))
            return partial.complete()
        try:
            self._upload_rest()
        except Exception as exc:
            warn(
                f"output {self.name!r}: the last {len(self._buffer)} bytes could not be uploaded "
                f"({describe_exception(exc)}); storing the {self._uploaded_bytes} bytes uploaded before"
            )
        return self._complete_parts(name)

    def _upload_rest(self) -> None:
        if self._buffer:
            self._upload(bytes(self._buffer))
            self._buffer.clear()

    def _complete_parts(self, as_name: str | None) -> Output:
        body: dict[str, Any] = {"parts": self._parts, "sha256": self._uploaded_digest.hexdigest()}
        if as_name is not None:
            body["name"] = as_name
        reply = self._client.call("POST", f"/outputs/{self._output_id}/complete", body)
        info = OutputInfo.model_validate(reply["output"])
        return info.to_output(self._outputs._access)

    def _upload(self, data: bytes) -> None:
        number = len(self._parts) + 1
        etag = self._put_part(number, data)
        self._parts.append({"partNumber": number, "etag": etag})
        self._uploaded_digest.update(data)
        self._uploaded_bytes += len(data)

    def _put_part(self, number: int, data: bytes) -> str:
        path = f"/outputs/{self._output_id}/parts"
        for attempt in range(2):
            presigned = self._client.call("POST", path, {"partNumber": number, "size": len(data)})
            headers = cast(dict[str, str], presigned.get("headers") or {})
            try:
                return self._client.put_file(str(presigned["url"]), data, headers)
            except UrlExpiredError:
                if attempt == 1:
                    raise ScriptError(
                        f"output {self.name!r}: the file store rejected part {number} twice (403)", code="fileStore"
                    ) from None
        raise AssertionError("unreachable")
