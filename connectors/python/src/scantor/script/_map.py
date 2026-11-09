"""`ctx.map(...)`: a function over many items, on a thread pool and optionally in worker processes.

With `processes > 1` the SDK starts its own `multiprocessing` pool (start method `spawn`). Every worker
process imports the entry again under the same module name (the shared entry loader), creates its own
HTTP client and runs a thread pool of `workers` threads. Analysis lines travel to the workers as raw
bytes and are validated there; other items and all results are pickled, so `fn` must be a module-level
function and its results picklable.
"""

import collections
import concurrent.futures
import multiprocessing
import pickle
import signal
import sys
import weakref
from collections.abc import Callable, Iterable, Iterator
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass, field
from typing import Any, Literal

import pydantic

from scantor._json import describe_exception
from scantor.script._errors import CancelState, ScriptError
from scantor.script._http import ClientConfig, HttpClient, RetryPolicy
from scantor.script._models import FileAccess, set_process_file_access
from scantor.script._stream import AnalysisStream, LineDecoder, first_error

ErrorPolicy = Literal["raise", "collect"]
_WAIT_SECONDS = 0.25


@dataclass(frozen=True)
class WorkerSetup:
    """What a worker process needs, picklable (the parent's own objects stay in the parent)."""

    client_config: ClientConfig | None
    retry: RetryPolicy
    file_origin: str | None
    entry_path: str | None
    module_name: str | None
    workers: int


@dataclass(frozen=True)
class EntryInfo:
    path: str
    module_name: str


@dataclass(frozen=True)
class MapEnvironment:
    """The parent's side of `ctx.map`: cancellation, file access and how worker processes start."""

    cancel: CancelState
    client: HttpClient | None
    entry: EntryInfo | None
    open_maps: weakref.WeakSet[MapResult[Any]] = field(default_factory=weakref.WeakSet[Any])


@dataclass
class _Outcome:
    value: Any = None
    error: BaseException | None = None
    message: str = ""
    skipped: bool = False
    invalid: bool = False
    """the analysis did not match the stream's models (`invalid="raise"`): raised whatever the error policy"""


@dataclass
class _Unit:
    future: concurrent.futures.Future[Any]
    keys: list[tuple[int | None, str | int]]
    """(seq or None, analysis id or index) per item, in order"""
    chunked: bool


@dataclass(frozen=True)
class _Chunk:
    fn: Callable[[Any], Any]
    decoder: LineDecoder | None
    payloads: list[Any]
    """raw analysis lines (with a decoder) or pickled items"""


_SKIP = object()
_END = object()


class MapResult[T]:
    """The results of `ctx.map(...)`, an iterator.

    Results come in completion order (`ordered=False`) or in input order. `watermark` is, for an
    analysis stream, the highest seq up to which every analysis has been handed out (or failed into
    `errors`): checkpoint it and resume with `after_seq=`. `errors` lists `(analysis id or index,
    message)` in `errors="collect"` mode. At most `processes x workers x 2` items are in flight.
    """

    def __init__(
        self,
        fn: Callable[[Any], T],
        items: Iterable[Any],
        *,
        environment: MapEnvironment,
        workers: int,
        processes: int,
        ordered: bool,
        errors: ErrorPolicy,
        max_errors: int,
    ) -> None:
        _check_arguments(fn, workers, processes, errors, max_errors)
        self.errors: list[tuple[str | int, str]] = []
        self._fn = fn
        self._environment = environment
        self._cancel = environment.cancel
        self._workers = workers
        self._processes = processes
        self._ordered = ordered
        self._error_policy = errors
        self._max_errors = max_errors
        self._stream: AnalysisStream[Any, Any] | None = items if isinstance(items, AnalysisStream) else None
        self._units: dict[concurrent.futures.Future[Any], _Unit] = {}
        self._ready: collections.deque[tuple[_Outcome, int | None, str | int]] = collections.deque()
        self._inflight: collections.deque[int] = collections.deque()
        self._done: set[int] = set()
        self._exhausted = False
        self._closed = False
        self._source = self._items(items)
        self._executor: concurrent.futures.Executor
        if processes > 1:
            self._executor = self._process_pool()
            self._bound = 2 * processes
        else:
            self._executor = concurrent.futures.ThreadPoolExecutor(workers, thread_name_prefix="scantor-map")
            self._bound = 2 * workers
        environment.open_maps.add(self)

    @property
    def watermark(self) -> int | None:
        """For an analysis stream: the highest seq with every analysis up to it done; else None."""
        if self._stream is None:
            return None
        position = self._stream.watermark
        return min(position, self._inflight[0] - 1) if self._inflight else position

    def __iter__(self) -> Iterator[T]:
        return self

    def __next__(self) -> T:
        try:
            value = self._advance()
        except BaseException:
            self.close()
            raise
        if value is _END:
            raise StopIteration
        return value

    def _advance(self) -> Any:
        """The next result, or `_END`."""
        while True:
            while self._ready:
                outcome, seq, label = self._ready.popleft()
                value = self._settle(outcome, seq, label)
                if value is not _SKIP:
                    return value
            if self._closed:
                return _END
            self._cancel.check()
            self._fill()
            if not self._units:
                self._shutdown(wait=True)
                return _END
            self._collect()

    def close(self) -> None:
        """Stop: pending items are dropped and worker processes are terminated."""
        if self._closed:
            return
        self._closed = True
        self._ready.clear()
        close_source = getattr(self._source, "close", None)
        if callable(close_source):
            close_source()
        self._shutdown(wait=False)

    def __enter__(self) -> MapResult[T]:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # ── internals ────────────────────────────────────────────────────────────────────────────────

    def _items(self, items: Iterable[Any]) -> Iterator[tuple[int | None, str | int, Any]]:
        if self._stream is not None:
            if self._processes > 1:
                for raw in self._stream.raw():
                    yield raw.seq, raw.id, raw.line
            else:
                for analysis in self._stream:
                    yield analysis.seq, analysis.id, analysis
            return
        for index, item in enumerate(items):
            yield None, index, item

    def _next_item(self) -> tuple[int | None, str | int, Any] | None:
        if self._exhausted:
            return None
        try:
            item = next(self._source)
        except StopIteration:
            self._exhausted = True
            return None
        if item[0] is not None:
            self._inflight.append(item[0])
        return item

    def _fill(self) -> None:
        while len(self._units) < self._bound and not self._exhausted:
            if self._processes > 1:
                batch = [item for _ in range(self._workers) if (item := self._next_item()) is not None]
                if not batch:
                    return
                decoder = self._stream.decoder if self._stream is not None else None
                chunk = _Chunk(self._fn, decoder, [payload for _seq, _label, payload in batch])
                future = self._executor.submit(_run_chunk, chunk)
                self._units[future] = _Unit(future, [(seq, label) for seq, label, _ in batch], chunked=True)
            else:
                item = self._next_item()
                if item is None:
                    return
                seq, label, payload = item
                future = self._executor.submit(self._fn, payload)
                self._units[future] = _Unit(future, [(seq, label)], chunked=False)

    def _collect(self) -> None:
        if self._ordered:
            head = next(iter(self._units.values()))
            concurrent.futures.wait([head.future], timeout=_WAIT_SECONDS)
            finished = [head] if head.future.done() else []
        else:
            done, _ = concurrent.futures.wait(
                list(self._units), timeout=_WAIT_SECONDS, return_when=concurrent.futures.FIRST_COMPLETED
            )
            finished = [unit for future, unit in self._units.items() if future in done]
        for unit in finished:
            del self._units[unit.future]
            for outcome, (seq, label) in zip(self._outcomes(unit), unit.keys, strict=True):
                self._ready.append((outcome, seq, label))

    def _outcomes(self, unit: _Unit) -> list[_Outcome]:
        error = unit.future.exception()
        if not unit.chunked:
            if error is None:
                return [_Outcome(value=unit.future.result())]
            return [_Outcome(error=error, message=describe_exception(error))]
        if error is None:
            return unit.future.result()
        if isinstance(error, BrokenProcessPool):
            raise ScriptError(
                "a worker process of ctx.map died (out of memory, or killed); lower processes or workers",
                code="workerDied",
            ) from error
        failure = ScriptError(
            f"ctx.map: a worker process failed: {describe_exception(error)} "
            "(with processes > 1, results must be picklable)",
            code="workerFailed",
        )
        failure.__cause__ = error
        return [_Outcome(error=failure, message=failure.message) for _ in unit.keys]

    def _settle(self, outcome: _Outcome, seq: int | None, label: str | int) -> Any:
        if outcome.skipped:
            if self._stream is not None:
                self._stream.note_skipped(str(label), outcome.message)
            self._mark_done(seq)
            return _SKIP
        if outcome.error is not None:
            if outcome.invalid:
                # As in the parent's own stream (processes=1): an invalid analysis stops the map.
                scan = self._stream.scan.name if self._stream is not None else None
                outcome.error.add_note(f"analysis {label} of scan {scan!r} does not match the stream's models")
                raise outcome.error
            # Cancelled (and other BaseExceptions) always stop the map; only Exceptions are collected.
            if self._error_policy == "raise" or not isinstance(outcome.error, Exception):
                raise outcome.error
            self.errors.append((label, outcome.message))
            self._mark_done(seq)
            if len(self.errors) > self._max_errors:
                first_label, first_message = self.errors[0]
                raise ScriptError(
                    f"ctx.map: {len(self.errors)} items failed, more than max_errors={self._max_errors}; "
                    f"the first, {first_label}: {first_message}",
                    code="tooManyErrors",
                )
            return _SKIP
        self._mark_done(seq)
        return outcome.value

    def _mark_done(self, seq: int | None) -> None:
        if seq is None:
            return
        self._done.add(seq)
        while self._inflight and self._inflight[0] in self._done:
            self._done.discard(self._inflight.popleft())

    def _process_pool(self) -> concurrent.futures.ProcessPoolExecutor:
        environment = self._environment
        client = environment.client
        setup = WorkerSetup(
            client_config=client.config if client is not None else None,
            retry=client.retry if client is not None else RetryPolicy(),
            file_origin=client.file_origin if client is not None else None,
            entry_path=environment.entry.path if environment.entry is not None else None,
            module_name=environment.entry.module_name if environment.entry is not None else None,
            workers=self._workers,
        )
        return concurrent.futures.ProcessPoolExecutor(
            self._processes,
            mp_context=multiprocessing.get_context("spawn"),
            initializer=_init_worker,
            initargs=(setup,),
        )

    def _shutdown(self, *, wait: bool) -> None:
        self._closed = True
        self._environment.open_maps.discard(self)
        executor = self._executor
        if isinstance(executor, concurrent.futures.ProcessPoolExecutor) and not wait:
            # Workers ignore SIGTERM (the run's SIGTERM goes to the whole process group and is the parent's to
            # handle), so they are killed. This shuts the pool down too; a shutdown first would forget them.
            executor.kill_workers()
            return
        executor.shutdown(wait=wait, cancel_futures=True)


def _check_arguments(fn: Callable[..., Any], workers: int, processes: int, errors: str, max_errors: int) -> None:
    if not callable(fn):
        raise TypeError(f"ctx.map: fn must be a function, not {type(fn).__name__}")
    if not isinstance(workers, int) or workers < 1:
        raise ValueError(f"ctx.map: workers must be an int >= 1, not {workers!r}")
    if not isinstance(processes, int) or processes < 1:
        raise ValueError(f"ctx.map: processes must be an int >= 1, not {processes!r}")
    if errors not in {"raise", "collect"}:
        raise ValueError(f"ctx.map: errors must be 'raise' or 'collect', not {errors!r}")
    if not isinstance(max_errors, int) or max_errors < 0:
        raise ValueError(f"ctx.map: max_errors must be an int >= 0, not {max_errors!r}")
    if processes > 1:
        try:
            pickle.dumps(fn)
        except (pickle.PicklingError, AttributeError, TypeError) as exc:
            raise TypeError(
                f"ctx.map: with processes > 1, fn must be a module-level function (not a lambda, a nested "
                f"function or a bound method of an unpicklable object); {fn!r} cannot be sent to a worker "
                f"process: {exc}"
            ) from exc


# ── worker processes ─────────────────────────────────────────────────────────────────────────────────


@dataclass
class _WorkerState:
    access: FileAccess | None
    threads: concurrent.futures.ThreadPoolExecutor


_worker: _WorkerState | None = None


def _init_worker(setup: WorkerSetup) -> None:
    """Pool initializer: SIGTERM goes to the parent (it stops the pool), then client and entry."""
    global _worker  # noqa: PLW0603 - the state of this worker process
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    access: FileAccess | None = None
    if setup.client_config is not None:
        client = HttpClient(setup.client_config, setup.retry)
        client.set_file_origin(setup.file_origin)
        access = FileAccess(client)
        set_process_file_access(access)
    if setup.entry_path is not None:
        from scantor._entry import load_entry  # noqa: PLC0415 - only worker processes import entries
        from scantor.script._definition import SCRIPT_DEFINITION  # noqa: PLC0415 - imports this module

        loaded = load_entry(setup.entry_path, SCRIPT_DEFINITION, module_name=setup.module_name)
        if isinstance(loaded, dict):
            print(f"scantor: a worker process cannot import the entry: {loaded['message']}", file=sys.stderr)
            raise RuntimeError(loaded["message"])
    _worker = _WorkerState(access, concurrent.futures.ThreadPoolExecutor(setup.workers, "scantor-map"))


def _run_chunk(chunk: _Chunk) -> list[_Outcome]:
    state = _worker
    if state is None:
        raise RuntimeError("the worker process was not initialised")
    futures = [state.threads.submit(_run_one, chunk, payload, state.access) for payload in chunk.payloads]
    return [future.result() for future in futures]


def _run_one(chunk: _Chunk, payload: Any, access: FileAccess | None) -> _Outcome:
    item = payload
    if chunk.decoder is not None:
        try:
            item = chunk.decoder.decode(payload, access)
        except pydantic.ValidationError as exc:
            if chunk.decoder.invalid == "skip":
                return _Outcome(skipped=True, message=first_error(exc))
            outcome = _failure(exc)
            outcome.invalid = True
            return outcome
    try:
        return _Outcome(value=chunk.fn(item))
    except Exception as exc:
        return _failure(exc)


def _failure(exc: Exception) -> _Outcome:
    message = describe_exception(exc)
    exc.add_note(f"(raised in the worker process {multiprocessing.current_process().name})")
    try:
        pickle.loads(pickle.dumps(exc))  # our own bytes: checks that the error survives the trip
    except Exception:
        return _Outcome(error=ScriptError(message), message=message)
    return _Outcome(error=exc, message=message)
