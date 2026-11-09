"""ctx.map: threads and worker processes, ordering, error collection, watermarks, bounded work."""

import multiprocessing
import os
import threading
from typing import Any

import pydantic
import pytest

from scantor.script import Analysis, Cancelled, ScriptError
from scantor.script._errors import CancelState
from tests import script_helpers
from tests.script_fake import FakePlatform
from tests.script_support import files_scan, make_context, wait_until


def test_threads_ordered_and_unordered(platform: FakePlatform) -> None:
    ctx = make_context(platform)
    ordered = list(ctx.map(script_helpers.slow_identity, range(20), workers=4, ordered=True))
    assert ordered == list(range(20))
    unordered = list(ctx.map(script_helpers.slow_identity, range(20), workers=4))
    assert sorted(unordered) == list(range(20))
    assert unordered != list(range(20))


def test_lambdas_and_closures_work_with_threads(platform: FakePlatform) -> None:
    ctx = make_context(platform)
    offset = 10
    assert sorted(ctx.map(lambda value: value + offset, [1, 2, 3])) == [11, 12, 13]


def test_errors_raise_by_default(platform: FakePlatform) -> None:
    ctx = make_context(platform)
    with pytest.raises(ValueError, match="odd"):
        list(ctx.map(script_helpers.fail_on_odd, range(10), ordered=True))


def test_errors_collect(platform: FakePlatform) -> None:
    ctx = make_context(platform)
    results = ctx.map(script_helpers.fail_on_odd, range(10), errors="collect", ordered=True)
    assert list(results) == [0, 2, 4, 6, 8]
    assert sorted(results.errors) == [(n, f"ValueError: odd: {n}") for n in (1, 3, 5, 7, 9)]
    assert results.watermark is None


def test_max_errors(platform: FakePlatform) -> None:
    ctx = make_context(platform)
    with pytest.raises(ScriptError) as error:
        list(ctx.map(script_helpers.fail_on_odd, range(20), errors="collect", max_errors=2, ordered=True))
    assert error.value.code == "tooManyErrors"


def test_in_flight_work_is_bounded(platform: FakePlatform) -> None:
    ctx = make_context(platform)
    pulled = 0

    def items() -> Any:
        nonlocal pulled
        for value in range(1000):
            pulled += 1
            yield value

    results = ctx.map(script_helpers.square, items(), workers=4)
    next(results)
    assert pulled <= 2 * 4 + 1
    results.close()


def test_watermark_follows_the_stream(platform: FakePlatform) -> None:
    files_scan(platform, [f"s{n}" for n in range(12)])
    ctx = make_context(platform)
    release = {n: threading.Event() for n in range(12)}

    def wait_for_release(analysis: Analysis[Any]) -> int:
        release[analysis.seq].wait(10)
        return analysis.seq

    stream = ctx.analyses(ctx.scans[0], after_seq=-1)
    results = ctx.map(wait_for_release, stream, workers=4)
    assert results.watermark == -1
    release[1].set()
    assert next(results) == 1
    assert results.watermark == -1  # seq 0 is still running
    release[0].set()
    assert next(results) == 0
    assert results.watermark == 1
    for event in release.values():
        event.set()
    rest = sorted(results)
    assert rest == list(range(2, 12))
    assert results.watermark == 11


def test_collected_errors_count_toward_the_watermark(platform: FakePlatform) -> None:
    files_scan(platform, [f"s{n}" for n in range(4)])
    ctx = make_context(platform)

    def fail_on_two(analysis: Analysis[Any]) -> int:
        if analysis.seq == 2:
            raise RuntimeError("two")
        return analysis.seq

    results = ctx.map(fail_on_two, ctx.analyses(ctx.scans[0]), errors="collect", ordered=True)
    assert list(results) == [0, 1, 3]
    assert results.errors == [(f"{ctx.scans[0].id}-2", "RuntimeError: two")]
    assert results.watermark == 3


def test_cancellation_stops_map(platform: FakePlatform) -> None:
    cancel = CancelState()
    ctx = make_context(platform, cancel=cancel)
    results = ctx.map(script_helpers.slow_identity, range(100), workers=2)
    next(results)
    cancel.cancel("test")
    with pytest.raises(Cancelled):
        list(results)


def test_processes_with_plain_items(platform: FakePlatform) -> None:
    ctx = make_context(platform)
    results = ctx.map(script_helpers.square, range(50), processes=2, workers=3, ordered=True)
    assert list(results) == [n * n for n in range(50)]


def test_processes_read_files_of_streamed_analyses(platform: FakePlatform) -> None:
    files_scan(platform, [f"site-{n}.org" for n in range(10)])
    ctx = make_context(platform)
    stream = ctx.analyses(ctx.scans[0])
    results = ctx.map(script_helpers.notes_and_pid, stream, processes=2, workers=2)
    rows = sorted(results)
    assert [(seq, text) for seq, text, _ in rows] == [(n, f"Notes on site-{n}.org\n") for n in range(10)]
    assert os.getpid() not in {pid for _, _, pid in rows}
    assert results.watermark == 9


def test_processes_errors(platform: FakePlatform) -> None:
    ctx = make_context(platform)
    collected = ctx.map(script_helpers.fail_on_odd, range(6), processes=2, errors="collect", ordered=True)
    assert list(collected) == [0, 2, 4]
    assert [label for label, _ in collected.errors] == [1, 3, 5]
    with pytest.raises(ValueError, match="odd") as error:
        list(ctx.map(script_helpers.fail_on_odd, range(6), processes=2, ordered=True))
    assert any("worker process" in note for note in getattr(error.value, "__notes__", []))
    with pytest.raises(ScriptError, match="picklable"):
        list(ctx.map(script_helpers.unpicklable_result, range(3), processes=2))


@pytest.mark.parametrize("processes", [1, 2])
def test_invalid_analyses_raise_whatever_the_error_policy(platform: FakePlatform, processes: int) -> None:
    scan = platform.add_scan("odd")
    platform.add_analysis(scan, result={"item": "ok", "length": 2})
    platform.add_analysis(scan, result={"item": "broken"})
    platform.add_analysis(scan, result={"item": "fine", "length": 4})
    ctx = make_context(platform)
    stream = ctx.analyses(ctx.scans[0], result=script_helpers.ItemResult)
    results = ctx.map(script_helpers.item_of, stream, processes=processes, errors="collect", ordered=True)
    with pytest.raises(pydantic.ValidationError) as error:
        list(results)
    assert f"analysis {scan.id}-1 of scan 'odd' does not match the stream's models" in error.value.__notes__
    assert results.errors == []

    skipping = ctx.analyses(ctx.scans[0], result=script_helpers.ItemResult, invalid="skip")
    assert list(ctx.map(script_helpers.item_of, skipping, processes=processes, ordered=True)) == ["ok", "fine"]


def test_processes_need_module_level_functions(platform: FakePlatform) -> None:
    ctx = make_context(platform)
    with pytest.raises(TypeError, match="module-level function"):
        ctx.map(lambda value: value, range(3), processes=2)


def test_invalid_arguments(platform: FakePlatform) -> None:
    ctx = make_context(platform)
    with pytest.raises(ValueError, match="workers"):
        ctx.map(script_helpers.square, [1], workers=0)
    with pytest.raises(ValueError, match="errors"):
        ctx.map(script_helpers.square, [1], errors="ignore")  # pyright: ignore[reportArgumentType]


def test_closing_terminates_worker_processes(platform: FakePlatform) -> None:
    ctx = make_context(platform)
    results = ctx.map(script_helpers.stuck_unless_zero, range(10), processes=2, workers=1)
    assert next(results) == 0
    results.close()
    wait_until(lambda: not multiprocessing.active_children(), timeout=10)
    assert list(results) == []


def test_cancelled_is_never_collected(platform: FakePlatform) -> None:
    cancel = CancelState()
    ctx = make_context(platform, cancel=cancel)

    def stop_on_three(value: int) -> int:
        if value == 3:
            cancel.cancel("test")
            ctx.check_cancelled()
        return value

    with pytest.raises(Cancelled):
        list(ctx.map(stop_on_three, range(10), errors="collect", ordered=True))
