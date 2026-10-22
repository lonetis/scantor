"""The schedule request and wrapped template streams (cases S1–S5, T1–T3)."""

import time
from pathlib import Path
from typing import Any

import pytest

from tests.conftest import StartConnector

SCHEDULES = ["schedule.py", "schedule_async.py"]
WRAPPED = ["template_wrapped.py", "template_wrapped_async.py"]


@pytest.mark.parametrize("entry", SCHEDULES)
def test_items_in_order_then_done(start_connector: StartConnector, ctx_factory: Any, entry: str) -> None:
    runtime = start_connector(entry)
    runtime.schedule("s1", ctx_factory("s1", kind="schedule"), {"count": 3})
    analyses, done = runtime.until("done")
    assert [message["config"] for message in analyses] == [{"n": 0}, {"n": 1}, {"n": 2}]
    assert all(message == {**message, "type": "analysis", "id": "s1"} for message in analyses)
    assert done == {"type": "done", "id": "s1", "count": 3}


@pytest.mark.parametrize("entry", SCHEDULES)
def test_empty_schedule(start_connector: StartConnector, ctx_factory: Any, entry: str) -> None:
    runtime = start_connector(entry)
    runtime.schedule("s1", ctx_factory("s1", kind="schedule"), {"count": 0})
    assert runtime.recv_type("done") == {"type": "done", "id": "s1", "count": 0}


@pytest.mark.parametrize("entry", SCHEDULES)
def test_errors_end_the_schedule(start_connector: StartConnector, ctx_factory: Any, entry: str) -> None:
    runtime = start_connector(entry)
    runtime.schedule("s1", ctx_factory("s1", kind="schedule"), {"count": 5, "failAt": 2})
    analyses, error = runtime.until("error")
    assert len(analyses) == 2
    assert error["error"]["type"] == "taskError"
    runtime.schedule("s2", ctx_factory("s2", kind="schedule"), {"count": 5, "fatalAt": 0})
    error = runtime.recv_type("error")
    assert error["id"] == "s2"
    assert error["error"]["type"] == "fatal"


def test_invalid_scan_config_is_a_validation_error(start_connector: StartConnector, ctx_factory: Any) -> None:
    runtime = start_connector("schedule.py")
    runtime.schedule("s1", ctx_factory("s1", kind="schedule"), {"count": "three"})
    error = runtime.recv_type("error")["error"]
    assert error["type"] == "validation"
    assert error["message"].startswith("scan config is invalid")


def test_backpressure_and_cancel_during_a_stall(start_connector: StartConnector, ctx_factory: Any) -> None:
    runtime = start_connector("schedule.py")
    runtime.schedule("s1", ctx_factory("s1", kind="schedule"), {"count": 100000})
    for _ in range(2):
        runtime.pause_reading()
        time.sleep(1)
        runtime.resume_reading()
    analyses, done = runtime.until("done", timeout=60)
    assert [message["config"]["n"] for message in analyses] == list(range(100000))
    assert done["count"] == 100000

    runtime.schedule("s2", ctx_factory("s2", kind="schedule"), {"count": 1000000})
    runtime.pause_reading()
    time.sleep(0.5)
    runtime.send({"type": "cancel", "id": "s2", "reason": "stop"})
    runtime.resume_reading()
    analyses, error = runtime.until("error", "done", timeout=60)
    assert error == {"type": "error", "id": "s2", "error": {"type": "cancelled", "message": "cancelled: stop"}}
    assert 0 < len(analyses) < 1000000


def test_async_schedule_is_cancelled_at_its_next_await(start_connector: StartConnector, ctx_factory: Any) -> None:
    runtime = start_connector("schedule_async.py")
    runtime.schedule("s1", ctx_factory("s1", kind="schedule"), {"count": 1000, "sleepMs": 50})
    runtime.recv_type("analysis")
    runtime.send({"type": "cancel", "id": "s1", "reason": "drain"})
    _, error = runtime.until("error", "done")
    assert error["error"] == {"type": "cancelled", "message": "cancelled: drain"}


@pytest.mark.parametrize("entry", WRAPPED)
def test_wrapped_template_flow_control(start_connector: StartConnector, ctx_factory: Any, entry: str) -> None:
    runtime = start_connector(entry)
    runtime.schedule("s1", ctx_factory("s1", kind="schedule"), {"end": 1000})
    transcript = runtime.serve_template({"value": value} for value in range(1000))
    assert transcript.request is not None
    assert transcript.request["parent"] == "s1"
    assert transcript.request["template"] == "range"
    assert transcript.request["scanConfig"] == {"start": 0, "end": 1000, "step": 1}
    assert transcript.request["credit"] == 256
    assert transcript.credits
    assert all(credit == 128 for credit in transcript.credits)
    assert [config["n"] for config in transcript.analyses] == [2 * value for value in range(1000)]
    assert transcript.end == {"type": "done", "id": "s1", "count": 1000}
    assert not transcript.cancelled


@pytest.mark.parametrize("entry", WRAPPED)
def test_stopping_early_cancels_the_stream(start_connector: StartConnector, ctx_factory: Any, entry: str) -> None:
    runtime = start_connector(entry)
    runtime.schedule("s1", ctx_factory("s1", kind="schedule"), {"end": 1000, "stopAfter": 5})
    transcript = runtime.serve_template({"value": value} for value in range(1000))
    assert len(transcript.analyses) == 5
    assert transcript.cancelled
    assert transcript.end == {"type": "done", "id": "s1", "count": 5}


@pytest.mark.parametrize("entry", WRAPPED)
def test_template_errors_reach_task_code(start_connector: StartConnector, ctx_factory: Any, entry: str) -> None:
    runtime = start_connector(entry)
    runtime.schedule("s1", ctx_factory("s1", kind="schedule"), {"end": 10})
    transcript = runtime.serve_template([], error={"type": "platform", "message": "download failed", "retryable": True})
    assert transcript.end["error"]["type"] == "taskError"
    assert "download failed" in transcript.end["error"]["message"]
    runtime.schedule("s2", ctx_factory("s2", kind="schedule"), {"end": 10})
    transcript = runtime.serve_template([], error={"type": "validation", "message": "bad config", "retryable": False})
    assert transcript.end["error"]["type"] == "validation"
    assert transcript.end["error"]["message"] == "bad config"


def test_files_and_templates_are_rejected_outside_their_request(
    start_connector: StartConnector, ctx_factory: Any, tmp_path: Path
) -> None:
    (tmp_path / "main.py").write_text(
        """
from collections.abc import Iterator

from pydantic import BaseModel

import scantor
from scantor import templates


class Result(BaseModel):
    values: list[int]


def schedule(ctx: scantor.Context, scan_config: scantor.Empty, task_config: scantor.Empty) -> Iterator[scantor.Empty]:
    ctx.progress(0.5, "ignored outside run")
    ctx.files.put("a.txt", b"x")
    yield scantor.Empty()


def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: scantor.Empty) -> Result:
    return Result(values=[item.value for item in templates.range.schedule(ctx, {"end": 2})])


task = scantor.Task(result=Result, schedule=schedule, run=run)
"""
    )
    runtime = start_connector("main.py", cwd=tmp_path)
    runtime.schedule("s1", ctx_factory("s1", kind="schedule"))
    error = runtime.recv_type("error")["error"]
    assert (error["type"], error["message"]) == ("validation", "files are only available in run")
    runtime.run("r1", ctx_factory("r1"))
    error = runtime.recv_type("error")["error"]
    assert (error["type"], error["message"]) == ("validation", "templates can only be used in schedule")


def test_default_schedule_is_the_single_template(start_connector: StartConnector, ctx_factory: Any) -> None:
    runtime = start_connector("echo.py")
    runtime.schedule("s1", ctx_factory("s1", kind="schedule"))
    transcript = runtime.serve_template([{}])
    assert transcript.request is not None
    assert transcript.request["template"] == "single"
    # The item is validated with the task's own analysis config model, which fills its defaults.
    assert transcript.analyses == [{"name": "world", "mode": "ok", "sleepMs": 0, "bytes": 0}]
    assert transcript.end == {"type": "done", "id": "s1", "count": 1}
