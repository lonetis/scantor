"""`ScriptContext`: what `run(ctx, config)` gets: the scans, their analyses and files, outputs and reporting."""

import json
import math
import time
import types
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from typing import Any, Literal, TypeVar, overload

import pydantic

from scantor._json import truncate
from scantor.script._errors import CancelState, ScriptError
from scantor.script._http import HttpClient
from scantor.script._map import ErrorPolicy, MapEnvironment, MapResult
from scantor.script._models import ANALYSIS_STATUSES, Bootstrap, FileAccess, Output, Scan
from scantor.script._outputs import Outputs
from scantor.script._report import Reporter
from scantor.script._stream import AnalysisStream, InvalidPolicy, LineDecoder

T = TypeVar("T")
I = TypeVar("I")  # noqa: E741 - the item type
RM = TypeVar("RM", bound=pydantic.BaseModel)
CM = TypeVar("CM", bound=pydantic.BaseModel)
StatusFilter = str | Sequence[str] | None
_MAX_LOG_MESSAGE = 16384
_TERMINAL_SCAN_STATES = frozenset({"completed", "failed", "cancelled"})


class Secrets(Mapping[str, str]):
    """The run's secrets by name; the representation shows the names only."""

    def __init__(self, values: Mapping[str, str]) -> None:
        self._values = types.MappingProxyType(dict(values))

    def __getitem__(self, name: str) -> str:
        return self._values[name]

    def __iter__(self) -> Iterator[str]:
        return iter(self._values)

    def __len__(self) -> int:
        return len(self._values)

    def __repr__(self) -> str:
        return f"Secrets({sorted(self._values)!r})"


class AggregateResult(list[dict[str, Any]]):
    """The documents of `ctx.aggregate`; `truncated` is True when the platform cut them at its limit."""

    def __init__(self, items: Iterable[dict[str, Any]], *, truncated: bool) -> None:
        super().__init__(items)
        self.truncated = truncated


class ScriptContext:
    """The context of a script run, passed to `run(ctx, config)`."""

    def __init__(
        self,
        *,
        bootstrap: Bootstrap,
        client: HttpClient,
        access: FileAccess,
        cancel: CancelState,
        reporter: Reporter,
        map_environment: MapEnvironment,
    ) -> None:
        run = bootstrap.script_run
        self._client = client
        self._access = access
        self._cancel = cancel
        self._reporter = reporter
        self._map_environment = map_environment
        self._scan_files = {scan.id: tuple(scan.file_ref_paths) for scan in bootstrap.scans}
        self.run_id: str = run.id
        self.script_name: str = run.script_name
        self.cpus: int = max(1, math.floor(run.cpus or 1))
        """CPUs of the run (at least 1): a good `processes=` for CPU-bound work"""
        self.limit: int | None = run.settings.limit
        """the sample size of the run (analyses per stream), None for a full run"""
        self.deadline: float | None = run.deadline.timestamp() if run.deadline is not None else None
        """epoch seconds at which the run times out"""
        self.secrets: Mapping[str, str] = Secrets(run.secrets)
        """secrets given for this run (never stored in the config or shown)"""
        self.scans: list[Scan] = [scan.to_scan() for scan in bootstrap.scans]
        """the scans the run reads, in the order they were given"""
        resume = bootstrap.resume
        self.resume_state: Any = resume.checkpoint if resume is not None else None
        """the last checkpoint of the run this run resumes, else None"""
        self.resume_outputs: list[Output] = (
            [output.to_output(access) for output in resume.outputs] if resume is not None else []
        )
        """the outputs of the run this run resumes"""
        self.outputs: Outputs = Outputs(client, access, bootstrap.limits.part_bytes)
        """files this run stores"""

    # ── time and cancellation ────────────────────────────────────────────────────────────────────

    def remaining(self) -> float | None:
        """Seconds until the run times out (never negative), None without a deadline."""
        return None if self.deadline is None else max(0.0, self.deadline - time.time())

    @property
    def cancelled(self) -> bool:
        """True once the run is being stopped (cancel, timeout or shutdown)."""
        return self._cancel.cancelled

    def check_cancelled(self) -> None:
        """Raise `Cancelled` once the run is being stopped; call it in long loops of your own."""
        self._cancel.check()

    # ── scans and analyses ───────────────────────────────────────────────────────────────────────

    def scan(self, id_or_name: str) -> Scan:
        """One of the run's scans by id or name."""
        for scan in self.scans:
            if scan.id == id_or_name:
                return scan
        named = [scan for scan in self.scans if scan.name == id_or_name]
        if len(named) == 1:
            return named[0]
        if named:
            raise ScriptError(f"{len(named)} scans of this run are named {id_or_name!r}; use the id", code="ambiguous")
        raise ScriptError(f"scan {id_or_name!r} is not a scan of this run", code="notFound")

    @overload
    def analyses(
        self,
        scan: Scan | str,
        *,
        result: type[RM],
        analysis_config: type[CM],
        status: StatusFilter = None,
        filter: dict[str, Any] | None = None,
        fields: Sequence[str] | Literal["all"] | None = None,
        after_seq: int | None = None,
        until_seq: int | None = None,
        file_urls: bool = True,
        invalid: InvalidPolicy = "raise",
    ) -> AnalysisStream[RM, CM]: ...
    @overload
    def analyses(
        self,
        scan: Scan | str,
        *,
        result: type[RM],
        analysis_config: None = None,
        status: StatusFilter = None,
        filter: dict[str, Any] | None = None,
        fields: Sequence[str] | Literal["all"] | None = None,
        after_seq: int | None = None,
        until_seq: int | None = None,
        file_urls: bool = True,
        invalid: InvalidPolicy = "raise",
    ) -> AnalysisStream[RM, dict[str, Any]]: ...
    @overload
    def analyses(
        self,
        scan: Scan | str,
        *,
        result: None = None,
        analysis_config: type[CM],
        status: StatusFilter = None,
        filter: dict[str, Any] | None = None,
        fields: Sequence[str] | Literal["all"] | None = None,
        after_seq: int | None = None,
        until_seq: int | None = None,
        file_urls: bool = True,
        invalid: InvalidPolicy = "raise",
    ) -> AnalysisStream[dict[str, Any], CM]: ...
    @overload
    def analyses(
        self,
        scan: Scan | str,
        *,
        result: None = None,
        analysis_config: None = None,
        status: StatusFilter = None,
        filter: dict[str, Any] | None = None,
        fields: Sequence[str] | Literal["all"] | None = None,
        after_seq: int | None = None,
        until_seq: int | None = None,
        file_urls: bool = True,
        invalid: InvalidPolicy = "raise",
    ) -> AnalysisStream[dict[str, Any], dict[str, Any]]: ...
    def analyses(
        self,
        scan: Scan | str,
        *,
        result: type[Any] | None = None,
        analysis_config: type[Any] | None = None,
        status: StatusFilter = None,
        filter: dict[str, Any] | None = None,  # noqa: A002 - the documented keyword
        fields: Sequence[str] | Literal["all"] | None = None,
        after_seq: int | None = None,
        until_seq: int | None = None,
        file_urls: bool = True,
        invalid: InvalidPolicy = "raise",
    ) -> AnalysisStream[Any, Any]:
        """The analyses of a scan in seq order, typed with the task's models.

        `result` and `analysis_config` are the task's pydantic models (copy them into `models.py`);
        without them results and configs are dicts. `status` (`"succeeded"` or a list) and `filter` (a
        query filter, as in `query_analyses`) select analyses; `fields` limits what is sent (`id`,
        `seq`, `status`, `attempt`, `round`, and `files` with `file_urls`, are always included;
        `"all"` adds attempts, timings and the log tail). `after_seq`/`until_seq` bound the seq range.
        `invalid="skip"` logs and skips analyses that do not match the models instead of raising.
        """
        target = scan if isinstance(scan, Scan) else self.scan(scan)
        for model, role in ((result, "result"), (analysis_config, "analysis_config")):
            if model is not None and not (isinstance(model, type) and issubclass(model, pydantic.BaseModel)):
                raise TypeError(f"{role} must be a pydantic model class, not {model!r}")
        if invalid not in {"raise", "skip"}:
            raise ValueError(f"invalid must be 'raise' or 'skip', not {invalid!r}")
        decoder = LineDecoder(result, analysis_config, self._scan_files.get(target.id, ()), invalid)
        return AnalysisStream(
            client=self._client,
            cancel=self._cancel,
            access=self._access,
            scan=target,
            decoder=decoder,
            status=_statuses(status),
            filter=filter,
            fields=fields,
            after_seq=after_seq,
            until_seq=until_seq,
            file_urls=file_urls,
            limit=self.limit,
        )

    def aggregate(
        self, scan: Scan | str, pipeline: list[dict[str, Any]], *, limit: int | None = None
    ) -> AggregateResult:
        """Run an aggregation pipeline over a scan's analyses (as `aggregate_analyses`).

        Best for status and seq predicates and grouped counts; to evaluate every analysis, stream them.
        """
        target = scan if isinstance(scan, Scan) else self.scan(scan)
        body: dict[str, Any] = {"pipeline": pipeline}
        if limit is not None:
            body["limit"] = limit
        reply = self._client.call("POST", f"/scans/{target.id}/aggregate", body)
        result = AggregateResult(reply.get("items", []), truncated=bool(reply.get("truncated")))
        if result.truncated:
            self.log(f"aggregate on scan {target.name!r} was truncated at {len(result)} documents")
        return result

    def count(self, scan: Scan | str, *, status: StatusFilter = None) -> int:
        """The number of analyses of a scan (with one of `status`): exact, also while the scan runs."""
        target = scan if isinstance(scan, Scan) else self.scan(scan)
        statuses = _statuses(status)
        counts = target.counts
        if target.state in _TERMINAL_SCAN_STATES and not counts.hint:
            if statuses is None:
                return counts.total
            return sum(getattr(counts, name) for name in statuses)
        pipeline: list[dict[str, Any]] = []
        if statuses is not None:
            pipeline.append({"$match": {"status": {"$in": statuses}}})
        pipeline.append({"$group": {"_id": "$status", "n": {"$sum": 1}}})
        return sum(int(item.get("n", 0)) for item in self.aggregate(target, pipeline))

    # ── parallelism ──────────────────────────────────────────────────────────────────────────────

    def map(
        self,
        fn: Callable[[I], T],
        items: Iterable[I],
        *,
        workers: int = 16,
        processes: int = 1,
        ordered: bool = False,
        errors: ErrorPolicy = "raise",
        max_errors: int = 100,
    ) -> MapResult[T]:
        """Apply `fn` to every item in parallel and iterate the results.

        `workers` threads run `fn` (per process) for I/O such as reading files; `processes > 1` adds
        worker processes for CPU-bound work (use `ctx.cpus`): then `fn` must be a module-level function
        and its results picklable. `errors="collect"` records failures in `.errors` instead of raising,
        up to `max_errors`. With an analysis stream, `.watermark` is the seq to checkpoint.
        """
        return MapResult(
            fn,
            items,
            environment=self._map_environment,
            workers=workers,
            processes=processes,
            ordered=ordered,
            errors=errors,
            max_errors=max_errors,
        )

    # ── reporting ────────────────────────────────────────────────────────────────────────────────

    def progress(self, done: float, total: float | None = None, message: str | None = None) -> None:
        """Report progress (`done` of `total`, optional message); sent at most once per second."""
        self._reporter.progress(done, total, message)

    def checkpoint(self, state: object) -> None:
        """Save JSON state for a restart with resume (`resume_state`); saved at most every 10 s.

        The state is copied at once; the latest one is saved when the run ends, also on failure.
        """
        self._reporter.checkpoint(state)

    def log(self, message: str, **fields: Any) -> None:
        """Write a line to the run log: `message key=value ...` (values as JSON)."""
        text = str(message)
        if fields:
            parts = [f"{key}={json.dumps(value, default=str, ensure_ascii=False)}" for key, value in fields.items()]
            text = f"{text} {' '.join(parts)}"
        print(truncate(text, _MAX_LOG_MESSAGE).replace("\n", "\\n"), flush=True)


def _statuses(status: StatusFilter) -> list[str] | None:
    if status is None:
        return None
    values = [status] if isinstance(status, str) else list(status)
    unknown = [value for value in values if value not in ANALYSIS_STATUSES]
    if unknown or not values:
        raise ValueError(f"status must be one or more of {', '.join(ANALYSIS_STATUSES)}, not {status!r}")
    return values
