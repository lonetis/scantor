"""`ctx.analyses(...)`: the analyses of a scan as a typed stream that resumes after interruptions."""

import functools
import sys
import time
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from typing import Any, Generic, Literal, cast

import pydantic
from pydantic.alias_generators import to_camel

from scantor.script._errors import CancelState, ScriptError
from scantor.script._http import HttpClient, Lines, TransientError
from scantor.script._models import Analysis, C, FileAccess, R, Scan, bind_analysis, convert_file_refs

InvalidPolicy = Literal["raise", "skip"]
_ALWAYS_FIELDS = ("id", "seq", "status", "attempt", "round")
_LOGGED_SKIPS = 10


def warn(message: str) -> None:
    """A line of the SDK in the run log (stderr)."""
    print(f"scantor: {message}", file=sys.stderr, flush=True)


def first_error(error: pydantic.ValidationError) -> str:
    """The first issue of a validation error, `path: message`, for one log line."""
    issues = error.errors(include_url=False, include_input=False)
    if not issues:
        return str(error)
    location = ".".join(str(part) for part in issues[0]["loc"])
    more = f" (and {len(issues) - 1} more)" if len(issues) > 1 else ""
    return f"{location}: {issues[0]['msg']}{more}"


class _Model(pydantic.BaseModel):
    model_config = pydantic.ConfigDict(extra="ignore", alias_generator=to_camel)


class _Checkpoint(_Model):
    after_seq: int


class _End(_Model):
    after_seq: int
    count: int = 0
    limited: bool = False


class _ErrorLine(_Model):
    code: str = "stream"
    message: str = "the stream failed"
    retryable: bool = False


class _Head(_Model):
    id: str
    seq: int


class _Control(_Model):
    """Any line, with only the identity of an analysis (worker processes validate the rest)."""

    analysis: _Head | None = None
    checkpoint: _Checkpoint | None = None
    end: _End | None = None
    error: _ErrorLine | None = None


class _Line(_Model, Generic[R, C]):  # noqa: UP046 - R and C (with defaults) are shared with Analysis
    analysis: Analysis[R, C] | None = None
    urls: dict[str, str] | None = None
    checkpoint: _Checkpoint | None = None
    end: _End | None = None
    error: _ErrorLine | None = None


_CONTROL = pydantic.TypeAdapter(_Control)


@functools.cache
def _line_adapter(result_type: Any, config_type: Any) -> pydantic.TypeAdapter[_Line[Any, Any]]:
    result = dict[str, Any] if result_type is None else result_type
    config = dict[str, Any] if config_type is None else config_type
    return pydantic.TypeAdapter(cast(Any, _Line)[result, config])


@dataclass(frozen=True)
class LineDecoder:
    """Validates analysis lines with the stream's models; picklable for worker processes."""

    result_type: type[Any] | None
    config_type: type[Any] | None
    file_ref_paths: tuple[str, ...]
    invalid: InvalidPolicy

    @property
    def adapter(self) -> pydantic.TypeAdapter[_Line[Any, Any]]:
        return _line_adapter(self.result_type, self.config_type)

    def decode(self, raw: bytes, access: FileAccess | None) -> Analysis[Any, Any]:
        """The analysis of a raw analysis line (`pydantic.ValidationError` when it does not match)."""
        return self.finish(self.adapter.validate_json(raw), access)

    def finish(self, line: _Line[Any, Any], access: FileAccess | None) -> Analysis[Any, Any]:
        """The validated analysis of a line, with FileRefs in untyped results and its file URLs."""
        analysis = line.analysis
        if analysis is None:
            raise ScriptError("expected an analysis line", code="stream")
        if self.result_type is None and self.file_ref_paths and analysis.result is not None:
            convert_file_refs(analysis.result, self.file_ref_paths)
        bind_analysis(analysis, line.urls, access)
        return analysis


@dataclass(frozen=True)
class RawAnalysis:
    """An analysis line in seq order: validated (`parsed`), failed validation (`invalid`), or raw only."""

    seq: int
    id: str
    line: bytes
    parsed: _Line[Any, Any] | None = None
    invalid: pydantic.ValidationError | None = None


class AnalysisStream(Generic[R, C]):  # noqa: UP046 - R and C (with defaults) are shared with Analysis
    """The analyses of one scan in seq order (`ctx.analyses(...)`); iterate it once.

    A dropped connection or a retryable error line is resumed after the last analysis or checkpoint,
    so an analysis is never delivered twice and never skipped. `watermark` is the highest seq up to
    which every matching analysis has been delivered: store it in a checkpoint and pass it back as
    `after_seq` to continue there.
    """

    def __init__(
        self,
        *,
        client: HttpClient,
        cancel: CancelState,
        access: FileAccess | None,
        scan: Scan,
        decoder: LineDecoder,
        status: Sequence[str] | None,
        filter: dict[str, Any] | None,  # noqa: A002 - the documented keyword
        fields: Sequence[str] | Literal["all"] | None,
        after_seq: int | None,
        until_seq: int | None,
        file_urls: bool,
        limit: int | None,
    ) -> None:
        self.scan = scan
        self._client = client
        self._cancel = cancel
        self._access = access
        self.decoder = decoder
        self._body = _request_body(status, filter, fields, until_seq, file_urls=file_urls)
        self._until_seq = until_seq
        self._position = -1 if after_seq is None else after_seq
        self._limit = limit
        self._started = False
        self.count = 0
        """analyses received so far (skipped ones included)"""
        self.skipped = 0
        """analyses skipped because they failed validation (`invalid="skip"`)"""
        self.limited = False
        """True when the run's sample limit (`settings.limit`) ended the stream early"""
        self.complete = False
        """True once the stream reached its end"""

    @property
    def watermark(self) -> int:
        """Highest seq up to which every matching analysis has been delivered (-1: none yet)."""
        return self._position

    def __iter__(self) -> Iterator[Analysis[R, C]]:
        for item in self._lines(validate=True):
            if item.invalid is not None:
                if self.decoder.invalid == "raise":
                    note = f"analysis {item.id} of scan {self.scan.name!r} does not match the stream's models"
                    item.invalid.add_note(note)
                    raise item.invalid
                self.note_skipped(item.id, first_error(item.invalid))
            elif item.parsed is not None:
                yield self.decoder.finish(item.parsed, self._access)

    def note_skipped(self, analysis_id: str, reason: str) -> None:
        self.skipped += 1
        if self.skipped <= _LOGGED_SKIPS:
            warn(f"skipped analysis {analysis_id}: {reason}")
        elif self.skipped == _LOGGED_SKIPS + 1:
            warn("skipping more invalid analyses; the count is logged at the end of the stream")

    def raw(self) -> Iterator[RawAnalysis]:
        """The analysis lines unvalidated, in seq order (worker processes validate them)."""
        return self._lines(validate=False)

    def _lines(self, *, validate: bool) -> Iterator[RawAnalysis]:
        if self._started:
            raise RuntimeError("an analysis stream can be iterated only once; call ctx.analyses(...) again")
        self._started = True
        progress_since_failure = True
        failing_since: float | None = None
        delay = self._client.retry.initial_delay
        while not self.complete and not self.limited:
            if self._until_seq is not None and self._position >= self._until_seq:
                # Everything up to until_seq was delivered (the platform refuses afterSeq >= untilSeq).
                self.complete = True
                break
            lines: Lines | None = None
            try:
                lines = self._client.stream(
                    f"/scans/{self.scan.id}/analyses",
                    {**self._body, "afterSeq": self._position},
                    interrupt=self._cancel.check,
                )
                for raw in self._read(lines, validate=validate):
                    progress_since_failure = True
                    failing_since = None
                    delay = self._client.retry.initial_delay
                    if raw is not None:
                        yield raw
            except TransientError as exc:
                now = time.monotonic()
                failing_since = failing_since or now
                if now - failing_since > self._client.retry.budget:
                    raise ScriptError(
                        f"the analysis stream of scan {self.scan.name!r} kept failing: {exc.reason}",
                        code="unavailable",
                        retryable=True,
                    ) from exc
                warn(f"the analysis stream of scan {self.scan.name!r} was interrupted ({exc.reason}); resuming")
                if not progress_since_failure:
                    self._pause(delay)
                    delay = min(delay * 2, self._client.retry.max_delay)
                progress_since_failure = False
            finally:
                if lines is not None:
                    lines.close()
        if self.skipped > _LOGGED_SKIPS:
            warn(f"skipped {self.skipped} invalid analyses of scan {self.scan.name!r}")

    def _read(self, lines: Lines, *, validate: bool) -> Iterator[RawAnalysis | None]:
        """The analysis lines of one response; None for a checkpoint line (progress without an analysis).

        With `validate`, a line is parsed once with the full models; only a line that fails them is parsed
        again for its identity.
        """
        while True:
            self._cancel.check()
            raw = lines.next_line()
            if not raw:
                raise TransientError("the stream ended without its end line")
            if not raw.strip():
                continue
            parsed: _Line[Any, Any] | None = None
            invalid: pydantic.ValidationError | None = None
            control: _Control | _Line[Any, Any]
            if validate:
                try:
                    control = parsed = self.decoder.adapter.validate_json(raw)
                except pydantic.ValidationError as exc:
                    invalid = exc
                    control = self._control(raw)
                    if control.analysis is None:
                        raise ScriptError(f"the analysis stream sent an unexpected line: {exc}", code="stream") from exc
            else:
                control = self._control(raw)
            if control.analysis is not None:
                head = control.analysis
                if head.seq <= self._position:
                    continue  # a line before the resume point, sent again
                self._position = head.seq
                self.count += 1
                yield RawAnalysis(head.seq, head.id, raw, parsed, invalid)
                if self._limit is not None and self.count >= self._limit:
                    self.limited = True
                    return
            elif control.checkpoint is not None:
                self._position = max(self._position, control.checkpoint.after_seq)
                yield None
            elif control.end is not None:
                self._position = max(self._position, control.end.after_seq)
                self.limited = control.end.limited
                self.complete = True
                return
            elif control.error is not None:
                error = control.error
                if error.retryable:
                    raise TransientError(f"{error.code}: {error.message}")
                raise ScriptError(
                    f"the analysis stream of scan {self.scan.name!r} failed: {error.message}", code=error.code
                )

    @staticmethod
    def _control(raw: bytes) -> _Control:
        try:
            return _CONTROL.validate_json(raw)
        except pydantic.ValidationError as exc:
            raise ScriptError(f"the analysis stream sent an unexpected line: {exc}", code="stream") from exc

    def _pause(self, seconds: float) -> None:
        end = time.monotonic() + seconds
        while (remaining := end - time.monotonic()) > 0:
            self._cancel.check()
            self._cancel.wait(min(remaining, 0.25))
        self._cancel.check()


def _request_body(
    status: Sequence[str] | None,
    filter: dict[str, Any] | None,  # noqa: A002
    fields: Sequence[str] | Literal["all"] | None,
    until_seq: int | None,
    *,
    file_urls: bool,
) -> dict[str, Any]:
    body: dict[str, Any] = {"fileUrls": file_urls}
    if status is not None:
        body["status"] = list(status)
    if filter is not None:
        body["filter"] = filter
    if fields == "all":
        body["fields"] = "all"
    elif fields is not None:
        required = [*_ALWAYS_FIELDS, *(["files"] if file_urls else [])]
        body["fields"] = list(dict.fromkeys([*required, *fields]))
    if until_seq is not None:
        body["untilSeq"] = until_seq
    return body
