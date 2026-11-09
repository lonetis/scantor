"""The data a script reads: scans, typed analyses with their files, and the outputs of runs."""

import datetime
import hashlib
import io
import json
import os
import pathlib
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, BinaryIO, Generic, Literal, TypeVar, cast, overload

import pydantic
from pydantic.alias_generators import to_camel

from scantor.models import FileRef
from scantor.script._errors import ScriptError
from scantor.script._http import HttpClient, UrlExpiredError

AnalysisStatus = Literal["pending", "retrying", "succeeded", "failed", "lost", "cancelled"]
ANALYSIS_STATUSES: tuple[AnalysisStatus, ...] = ("pending", "retrying", "succeeded", "failed", "lost", "cancelled")

R = TypeVar("R", default=dict[str, Any])
"""The result type of an analysis stream (`result=`); untyped results are dicts."""
C = TypeVar("C", default=dict[str, Any])
"""The analysis-config type of an analysis stream (`analysis_config=`)."""
M = TypeVar("M", bound=pydantic.BaseModel)

_CHUNK_BYTES = 1024 * 1024
FileSelector = FileRef | Mapping[str, Any] | str
"""A file of an analysis: its FileRef (from the result), a FileRef dict, or its id or name."""


class FileAccess:
    """Reading presigned file URLs and presigning them again; one per process.

    Analyses and outputs refer to the access of the process they are in: pickled into a worker
    process, they use that process's access (`__reduce__`).
    """

    def __init__(self, client: HttpClient) -> None:
        self.client = client

    def __reduce__(self) -> tuple[Callable[[], FileAccess], tuple[()]]:
        return (process_file_access, ())

    def analysis_file_url(self, analysis_id: str, file_id: str) -> str:
        reply = self.client.call("GET", f"/analyses/{analysis_id}/files/{file_id}")
        return str(reply["url"])

    def output_url(self, output_id: str) -> str:
        reply = self.client.call("GET", f"/outputs/{output_id}")
        return str(reply["url"])

    def read(self, url: str | None, refresh: Callable[[], str]) -> bytes:
        """The bytes at `url` (presigned at once when None); an expired URL is presigned again once."""
        try:
            return self.client.get_file(url or refresh())
        except UrlExpiredError:
            return self.client.get_file(refresh())

    def open(self, url: str | None, refresh: Callable[[], str]) -> io.BufferedReader:
        try:
            return self.client.open_file(url or refresh())
        except UrlExpiredError:
            return self.client.open_file(refresh())


_process_access: FileAccess | None = None
_process_access_lock = threading.Lock()


def set_process_file_access(access: FileAccess) -> None:
    global _process_access  # noqa: PLW0603 - one access per process, set at bootstrap or worker start
    with _process_access_lock:
        _process_access = access


def process_file_access() -> FileAccess:
    if _process_access is None:
        raise ScriptError("file access is only available inside a script run", code="configuration")
    return _process_access


def _verified(data: bytes, ref: FileRef | None, sha256: str, name: str, *, verify: bool) -> bytes:
    if verify and hashlib.sha256(data).hexdigest() != sha256:
        what = f"file {ref.name!r}" if ref is not None else f"output {name!r}"
        raise ScriptError(f"{what}: the content does not match its SHA-256 {sha256}", code="integrity")
    return data


# ── analyses ─────────────────────────────────────────────────────────────────────────────────────────


class _Base(pydantic.BaseModel):
    model_config = pydantic.ConfigDict(
        frozen=True,
        extra="ignore",
        alias_generator=to_camel,
        validate_by_name=True,
        validate_by_alias=True,
        serialize_by_alias=True,
    )


class AnalysisError(_Base):
    """Why an analysis failed (a platform ScantorError)."""

    type: str
    message: str
    retryable: bool = False
    phase: str | None = None
    attempt: int | None = None
    stack: str | None = None
    details: dict[str, Any] | None = None
    at: datetime.datetime | None = None


class Attempt(_Base):
    """One attempt of an analysis (in `fields="all"`)."""

    attempt: int
    round: int = 0
    execution_id: str | None = None
    worker_id: str | None = None
    node_id: str | None = None
    started_at: datetime.datetime | None = None
    finished_at: datetime.datetime | None = None
    duration_ms: int | None = None
    error: AnalysisError | None = None
    log_tail: str = ""


class Timings(_Base):
    scheduled_at: datetime.datetime | None = None
    started_at: datetime.datetime | None = None
    finished_at: datetime.datetime | None = None
    duration_ms: int | None = None


class Analysis(_Base, Generic[R, C]):
    """One analysis of a scan, with its typed result and config.

    `result` is set for succeeded analyses, `error` for failed ones. Files are read through the
    analysis: `analysis.read_json(analysis.result.report)` takes a FileRef of the result, a FileRef dict
    or a file id or name, and only files of this analysis.
    """

    id: str
    """`<scanId>-<seq>`"""
    seq: int
    status: AnalysisStatus
    attempt: int = 0
    round: int = 0
    config: C | None = None
    result: R | None = None
    error: AnalysisError | None = None
    files: list[FileRef] = pydantic.Field(default_factory=list[FileRef])
    log_tail: str | None = None
    """only with `fields="all"` or `fields=[..., "logTail"]`"""
    attempts: list[Attempt] | None = None
    timings: Timings | None = None

    _urls: dict[str, str] = pydantic.PrivateAttr(default_factory=dict[str, str])
    _access: FileAccess | None = pydantic.PrivateAttr(default=None)

    @pydantic.computed_field(alias="scanId")
    @property
    def scan_id(self) -> str:
        return self.id.rsplit("-", 1)[0]

    def file(self, selector: FileSelector) -> FileRef:
        """The FileRef of one of this analysis's files, by FileRef, FileRef dict, id or name."""
        if isinstance(selector, FileRef):
            wanted, by_name = selector.id, False
        elif isinstance(selector, Mapping):
            wanted, by_name = str(cast(Mapping[str, Any], selector).get("id", "")), False
        elif isinstance(selector, str):
            wanted, by_name = selector, True
        else:
            raise TypeError(f"a file is a FileRef, a FileRef dict, an id or a name, not {type(selector).__name__}")
        for ref in self.files:
            if ref.id == wanted:
                return ref
        if by_name:
            named = [ref for ref in self.files if ref.name == wanted]
            if len(named) == 1:
                return named[0]
            if len(named) > 1:
                raise ScriptError(f"analysis {self.id} has {len(named)} files named {wanted!r}; use the FileRef")
        hint = "" if self.files else " (it has none; were the files requested? fields must include files)"
        raise ScriptError(f"{wanted!r} is not a file of analysis {self.id}{hint}", code="notFound")

    def read_bytes(self, selector: FileSelector, *, verify: bool = True) -> bytes:
        """The content of a file; `verify` checks its SHA-256 (`ScriptError` code `integrity`)."""
        ref = self.file(selector)
        data = self._file_access().read(self._urls.get(ref.id), lambda: self._presign(ref))
        return _verified(data, ref, ref.sha256, ref.name, verify=verify)

    def read_text(self, selector: FileSelector, encoding: str = "utf-8") -> str:
        return self.read_bytes(selector).decode(encoding)

    @overload
    def read_json(self, selector: FileSelector, model: None = None) -> Any: ...
    @overload
    def read_json(self, selector: FileSelector, model: type[M]) -> M: ...
    def read_json(self, selector: FileSelector, model: type[M] | None = None) -> Any:
        """A JSON file, parsed, or validated as `model`."""
        data = self.read_bytes(selector)
        return json.loads(data) if model is None else model.model_validate_json(data)

    def open(self, selector: FileSelector) -> BinaryIO:
        """A file as a binary stream (not verified; use `read_bytes` or `download` for a checked copy)."""
        ref = self.file(selector)
        return cast(BinaryIO, self._file_access().open(self._urls.get(ref.id), lambda: self._presign(ref)))

    def download(self, selector: FileSelector, path: str | os.PathLike[str]) -> pathlib.Path:
        """Stream a file to `path` and check its SHA-256; returns the path."""
        ref = self.file(selector)
        target = pathlib.Path(path)
        digest = hashlib.sha256()
        with self.open(ref) as source, target.open("wb") as sink:
            while chunk := source.read(_CHUNK_BYTES):
                digest.update(chunk)
                sink.write(chunk)
        if digest.hexdigest() != ref.sha256:
            target.unlink(missing_ok=True)
            raise ScriptError(f"file {ref.name!r}: the content does not match its SHA-256", code="integrity")
        return target

    def _presign(self, ref: FileRef) -> str:
        url = self._file_access().analysis_file_url(self.id, ref.id)
        self._urls[ref.id] = url
        return url

    def _file_access(self) -> FileAccess:
        return self._access if self._access is not None else process_file_access()


def bind_analysis(analysis: Analysis[Any, Any], urls: Mapping[str, str] | None, access: FileAccess | None) -> None:
    """Attach the presigned URLs sent next to an analysis (never part of its fields)."""
    analysis._urls = dict(urls) if urls else {}
    analysis._access = access


def convert_file_refs(result: object, paths: Sequence[str]) -> None:
    """Replace FileRef dicts at the JSON pointers `paths` (`*` = every item) of an untyped result in place."""
    for path in paths:
        segments = [part.replace("~1", "/").replace("~0", "~") for part in path.split("/")[1:]]
        _convert_at(result, segments)


def _convert_at(value: object, segments: list[str]) -> None:
    if not segments:
        return
    head, rest = segments[0], segments[1:]
    if isinstance(value, dict):
        mapping = cast(dict[str, Any], value)
        keys = list(mapping) if head == "*" else [head] if head in mapping else []
        for key in keys:
            if rest:
                _convert_at(mapping[key], rest)
            else:
                mapping[key] = _as_file_ref(mapping[key])
    elif isinstance(value, list):
        items = cast(list[Any], value)
        indexes = range(len(items)) if head == "*" else [int(head)] if head.isdigit() and int(head) < len(items) else []
        for index in indexes:
            if rest:
                _convert_at(items[index], rest)
            else:
                items[index] = _as_file_ref(items[index])


def _as_file_ref(value: object) -> object:
    if isinstance(value, dict):
        try:
            return FileRef.model_validate(value)
        except pydantic.ValidationError:
            return value
    return value


# ── scans ────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ScanCounts:
    """Analyses of a scan by status, at the start of the run (`hint`: approximate, the scan was running)."""

    total: int = 0
    pending: int = 0
    retrying: int = 0
    succeeded: int = 0
    failed: int = 0
    lost: int = 0
    cancelled: int = 0
    hint: bool = False


@dataclass(frozen=True)
class Scan:
    """A scan the run reads (`ctx.scans`), as it was at the start of the run."""

    id: str
    name: str
    """the scan's name, its id when it has none"""
    state: str
    task_name: str
    revision_number: int
    max_seq: int | None
    """highest seq of the scan's analyses, None without analyses"""
    counts: ScanCounts
    result_schema: dict[str, Any] | None
    analysis_config_schema: dict[str, Any] | None
    created_at: datetime.datetime | None
    completed_at: datetime.datetime | None
    file_ref_paths: tuple[str, ...] = field(default=(), repr=False)
    """JSON pointers of the FileRefs in the task's result"""


class _TaskRef(_Base):
    id: str = ""
    name: str = ""


class _RevisionRef(_Base):
    id: str = ""
    number: int = 0


class _Schemas(_Base):
    analysis_config: dict[str, Any] | None = None
    result: dict[str, Any] | None = None


class _Counts(_Base):
    total: int = 0
    pending: int = 0
    retrying: int = 0
    succeeded: int = 0
    failed: int = 0
    lost: int = 0
    cancelled: int = 0
    hint: bool = False


class BootstrapScan(_Base):
    id: str
    name: str | None = None
    state: str = ""
    task: _TaskRef = pydantic.Field(default_factory=_TaskRef)
    revision: _RevisionRef = pydantic.Field(default_factory=_RevisionRef)
    created_at: datetime.datetime | None = None
    completed_at: datetime.datetime | None = None
    max_seq: int | None = None
    counts: _Counts = pydantic.Field(default_factory=_Counts)
    schemas: _Schemas = pydantic.Field(default_factory=_Schemas)
    file_ref_paths: list[str] = pydantic.Field(default_factory=list[str])

    def to_scan(self) -> Scan:
        return Scan(
            id=self.id,
            name=self.name or self.id,
            state=self.state,
            task_name=self.task.name,
            revision_number=self.revision.number,
            max_seq=self.max_seq,
            counts=ScanCounts(**self.counts.model_dump(by_alias=False)),
            result_schema=self.schemas.result,
            analysis_config_schema=self.schemas.analysis_config,
            created_at=self.created_at,
            completed_at=self.completed_at,
            file_ref_paths=tuple(self.file_ref_paths),
        )


# ── outputs ──────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Output:
    """A stored output file of this run (`ctx.outputs`) or of the run it resumes (`ctx.resume_outputs`)."""

    id: str
    name: str
    size: int
    sha256: str
    content_type: str
    _access: FileAccess | None = field(default=None, repr=False, compare=False)

    def read_bytes(self, *, verify: bool = True) -> bytes:
        data = self._file_access().read(None, lambda: self._file_access().output_url(self.id))
        return _verified(data, None, self.sha256, self.name, verify=verify)

    def open(self) -> BinaryIO:
        access = self._file_access()
        return cast(BinaryIO, access.open(None, lambda: access.output_url(self.id)))

    def _file_access(self) -> FileAccess:
        return self._access if self._access is not None else process_file_access()


class OutputInfo(_Base):
    id: str
    name: str
    size: int = 0
    sha256: str = ""
    content_type: str = "application/octet-stream"

    def to_output(self, access: FileAccess | None) -> Output:
        return Output(self.id, self.name, self.size, self.sha256, self.content_type, access)


# ── bootstrap ────────────────────────────────────────────────────────────────────────────────────────


class _Resources(_Base):
    cpus: float | None = None
    memory_mib: int | None = pydantic.Field(default=None, alias="memoryMiB")


class _Settings(_Base):
    timeout_ms: int | None = None
    resources: _Resources = pydantic.Field(default_factory=_Resources)
    limit: int | None = None


class BootstrapRun(_Base):
    id: str
    script_id: str = ""
    script_name: str = ""
    config: dict[str, Any] = pydantic.Field(default_factory=dict[str, Any])
    secrets: dict[str, str] = pydantic.Field(default_factory=dict[str, str])
    settings: _Settings = pydantic.Field(default_factory=_Settings)
    cpus: float | None = None
    started_at: datetime.datetime | None = None
    deadline: datetime.datetime | None = None


class BootstrapResume(_Base):
    run_id: str
    checkpoint: Any = None
    outputs: list[OutputInfo] = pydantic.Field(default_factory=list[OutputInfo])


class BootstrapLimits(_Base):
    max_result_bytes: int = 1024 * 1024
    max_checkpoint_bytes: int = 1024 * 1024
    max_outputs: int = 100
    max_output_bytes: int | None = None
    part_bytes: int = 16 * 1024 * 1024
    file_url_ttl_seconds: int | None = None
    max_streams: int = 4
    progress_interval_ms: int = 1000
    checkpoint_interval_ms: int = 10_000


class Bootstrap(_Base):
    """The answer of `GET /api/script-runtime/bootstrap`."""

    script_run: BootstrapRun
    scans: list[BootstrapScan] = pydantic.Field(default_factory=list[BootstrapScan])
    resume: BootstrapResume | None = None
    limits: BootstrapLimits = pydantic.Field(default_factory=BootstrapLimits)
    s3_origin: str | None = None
