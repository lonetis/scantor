"""The run request: results, ctx, validation, errors, logs, progress and files (cases R1–R14, C1–C5)."""

import json
import os
import signal
import time
from pathlib import Path
from typing import Any

import pytest

from tests.conftest import StartConnector

ECHO_FIXTURES = ["echo.py", "echo_async.py"]


@pytest.mark.parametrize("entry", ECHO_FIXTURES)
def test_results_use_defaults_and_task_config(start_connector: StartConnector, ctx_factory: Any, entry: str) -> None:
    runtime = start_connector(entry)
    runtime.run("r1", ctx_factory("r1"))
    assert runtime.recv_type("result")["result"]["text"] == "Hello, world!"
    runtime.run("r2", ctx_factory("r2"), task_config={"greeting": "Hi"})
    assert runtime.recv_type("result")["result"]["text"] == "Hi, world!"


@pytest.mark.parametrize("entry", ECHO_FIXTURES)
def test_ctx_reaches_task_code(start_connector: StartConnector, ctx_factory: Any, entry: str) -> None:
    runtime = start_connector(entry)
    ctx = ctx_factory("r1", seq=1234, attempt=2, deadline_ms=int((time.time() + 60) * 1000))
    runtime.run("r1", ctx)
    echoed = runtime.recv_type("result")["result"]["ctx"]
    assert echoed == {
        "scanId": ctx["scanId"],
        "analysisId": ctx["analysisId"],
        "seq": 1234,
        "attempt": 2,
        "hasDeadline": True,
        "tmpDirWritable": True,
    }


@pytest.mark.parametrize("entry", ECHO_FIXTURES)
def test_invalid_configs_are_validation_errors(start_connector: StartConnector, ctx_factory: Any, entry: str) -> None:
    runtime = start_connector(entry)
    for request_id, analysis_config in (("r1", {"name": 5}), ("r2", {"nmae": "x"})):
        runtime.run(request_id, ctx_factory(request_id), analysis_config)
        error = runtime.recv_type("error")
        assert error["id"] == request_id
        assert error["error"]["type"] == "validation"
        assert error["error"]["details"]["issues"]
    runtime.run("r3", ctx_factory("r3"), task_config={"greeting": ["not", "a", "string"]})
    error = runtime.recv_type("error")["error"]
    assert error["type"] == "validation"
    assert error["message"].startswith("task config is invalid")
    assert error["details"]["issues"][0]["path"] == "/greeting"


@pytest.mark.parametrize("entry", ECHO_FIXTURES)
def test_error_classification(start_connector: StartConnector, ctx_factory: Any, entry: str) -> None:
    runtime = start_connector(entry)
    expected = {
        "fatal": ("fatal", "fatal requested"),
        "retry": ("retry", "retry requested"),
        "retryAfter": ("retry", "retry requested"),
        "throw": ("taskError", "RuntimeError: boom"),
        "invalidResult": ("validation", "result is invalid"),
    }
    for index, (mode, (error_type, message)) in enumerate(expected.items()):
        request_id = f"r{index}"
        runtime.run(request_id, ctx_factory(request_id), {"mode": mode})
        error = runtime.recv_type("error")["error"]
        assert error["type"] == error_type
        assert error["message"].startswith(message)
        if mode == "retry":
            assert "delayMs" not in error
        if mode == "retryAfter":
            assert error["delayMs"] == 1500
        if mode == "throw":
            assert entry in error["stack"]
            assert "scantor/_handlers.py" not in error["stack"]


def test_oversized_result_is_one_valid_line(start_connector: StartConnector, ctx_factory: Any) -> None:
    runtime = start_connector("echo.py")
    runtime.run("r1", ctx_factory("r1"), {"mode": "oversized", "bytes": 2 * 1024 * 1024})
    result = runtime.recv_type("result")
    assert len(result["result"]["text"]) == 2 * 1024 * 1024
    assert len(runtime.lines[-1]) > 2 * 1024 * 1024


def test_result_beyond_the_line_limit_is_a_validation_error(start_connector: StartConnector, ctx_factory: Any) -> None:
    runtime = start_connector("echo.py", handshake=False)
    runtime.handshake(
        limits={
            "maxLineBytes": 4096,
            "maxResultBytes": 1024,
            "maxAnalysisConfigBytes": 1024,
            "maxFileBytes": 1024,
            "maxFilesPerAnalysis": 2,
        }
    )
    runtime.run("r1", ctx_factory("r1"), {"mode": "oversized", "bytes": 10000})
    error = runtime.recv_type("error")["error"]
    assert error["type"] == "validation"
    assert "ctx.files" in error["message"]


@pytest.mark.parametrize("entry", ECHO_FIXTURES)
def test_stdout_never_reaches_the_protocol(start_connector: StartConnector, ctx_factory: Any, entry: str) -> None:
    runtime = start_connector(entry)
    runtime.run("r1", ctx_factory("r1"), {"mode": "stdout"})
    assert runtime.recv_type("result")["id"] == "r1"
    assert runtime.shutdown() == 0
    assert '{"type":"result","id":"r0","result":{}}' in runtime.stdout.text()
    assert "noise" in runtime.stderr.text()
    assert all(json.loads(line)["id"] != "r0" for line in runtime.lines if b'"id"' in line)


@pytest.mark.parametrize("entry", ECHO_FIXTURES)
def test_log_and_progress_name_their_request(start_connector: StartConnector, ctx_factory: Any, entry: str) -> None:
    runtime = start_connector(entry)
    runtime.run("r1", ctx_factory("r1"), {"mode": "log"})
    log = runtime.recv_type("log")
    assert log == {"type": "log", "parent": "r1", "level": "info", "message": "hello", "fields": {"n": 1}}
    runtime.recv_type("result")
    runtime.run("r2", ctx_factory("r2"), {"mode": "progress"})
    progress = runtime.recv_type("progress")
    assert progress == {"type": "progress", "parent": "r2", "fraction": 0.5, "message": "half"}
    runtime.recv_type("result")


@pytest.mark.parametrize("entry", ECHO_FIXTURES)
def test_files_are_registered_by_path(start_connector: StartConnector, ctx_factory: Any, entry: str) -> None:
    runtime = start_connector(entry)
    ctx = ctx_factory("r1")
    runtime.run("r1", ctx, {"mode": "file"})
    requests: list[dict[str, Any]] = []
    refs: list[dict[str, Any]] = []
    while len(requests) < 3:
        message = runtime.recv_type("file")
        assert message["parent"] == "r1"
        assert Path(message["path"]).parent == Path(ctx["filesDir"])
        requests.append(message)
        refs.append(runtime.answer_file(message))
    contents = [Path(message["path"]).read_bytes() for message in requests]
    assert contents == [b"abc", b"hello", b'{"c": true}']
    assert [message["contentType"] for message in requests] == ["application/octet-stream", None, None]
    assert len({message["name"] for message in requests}) == 3
    result = runtime.recv_type("result")["result"]
    assert result["files"] == refs


@pytest.mark.parametrize("entry", ECHO_FIXTURES)
def test_invalid_file_names_fail_the_run(start_connector: StartConnector, ctx_factory: Any, entry: str) -> None:
    runtime = start_connector(entry)
    runtime.run("r1", ctx_factory("r1"), {"mode": "fileError"})
    error = runtime.recv_type("error")["error"]
    assert error["type"] == "validation"
    assert "bad/name" in error["message"]


@pytest.mark.parametrize("entry", ECHO_FIXTURES)
def test_runtime_file_errors_reach_task_code(start_connector: StartConnector, ctx_factory: Any, entry: str) -> None:
    runtime = start_connector(entry)
    runtime.run("r1", ctx_factory("r1"), {"mode": "file"})
    request = runtime.recv_type("file")
    runtime.send(
        {
            "type": "error",
            "id": request["id"],
            "error": {"type": "validation", "message": "quota exceeded by the harness", "retryable": False},
        }
    )
    error = runtime.recv_type("error")["error"]
    assert error == {**error, "type": "validation", "message": "quota exceeded by the harness"}


def test_file_limits_are_enforced_early(start_connector: StartConnector, ctx_factory: Any) -> None:
    runtime = start_connector("echo.py", handshake=False)
    runtime.handshake(
        limits={
            "maxLineBytes": 8388608,
            "maxResultBytes": 1048576,
            "maxAnalysisConfigBytes": 65536,
            "maxFileBytes": 2,
            "maxFilesPerAnalysis": 100,
        }
    )
    runtime.run("r1", ctx_factory("r1"), {"mode": "file"})
    error = runtime.recv_type("error")["error"]
    assert error["type"] == "validation"
    assert error["message"] == "file a.bin is 3 bytes; the limit is 2"


@pytest.mark.parametrize("entry", ECHO_FIXTURES)
def test_secrets_reach_task_code(start_connector: StartConnector, ctx_factory: Any, entry: str) -> None:
    runtime = start_connector(entry)
    runtime.run("r1", ctx_factory("r1"), task_config={"apiToken": "s3cret"})
    assert runtime.recv_type("result")["result"]["secretLength"] == 6


def test_secrets_in_results_are_serialised_in_plaintext(start_connector: StartConnector, ctx_factory: Any) -> None:
    runtime = start_connector("secrets_result.py")
    runtime.run("r1", ctx_factory("r1"), task_config={"token": "abc"})
    assert runtime.recv_type("result")["result"] == {"echoed": "abc", "plain": "visible", "ratio": 0.5}
    runtime.run("r2", ctx_factory("r2"), task_config={"token": "nan"})
    error = runtime.recv_type("error")["error"]
    assert error["type"] == "validation"
    assert "not representable in JSON" in error["message"]


@pytest.mark.parametrize("entry", ECHO_FIXTURES)
def test_fifty_runs_on_one_process(start_connector: StartConnector, ctx_factory: Any, entry: str) -> None:
    runtime = start_connector(entry)
    for index in range(50):
        request_id = f"r{index}"
        runtime.run(request_id, ctx_factory(request_id, seq=index), {"name": str(index)})
        result = runtime.recv_type("result")
        assert result["id"] == request_id
        assert result["result"]["text"] == f"Hello, {index}!"
        assert result["result"]["ctx"]["tmpDirWritable"]


@pytest.mark.parametrize("entry", ECHO_FIXTURES)
def test_cancel_ends_the_run(start_connector: StartConnector, ctx_factory: Any, entry: str) -> None:
    runtime = start_connector(entry)
    runtime.run("r1", ctx_factory("r1"), {"mode": "sleep", "sleepMs": 60000})
    time.sleep(0.2)
    started = time.monotonic()
    runtime.send({"type": "cancel", "id": "r1", "reason": "drain"})
    error = runtime.recv_type("error", timeout=5)
    assert time.monotonic() - started < 5
    assert error == {"type": "error", "id": "r1", "error": {"type": "cancelled", "message": "cancelled: drain"}}


@pytest.mark.parametrize("entry", ECHO_FIXTURES)
def test_deadline_cancels_task_code(start_connector: StartConnector, ctx_factory: Any, entry: str) -> None:
    runtime = start_connector(entry)
    deadline_ms = int(time.time() * 1000) + 300
    runtime.run("r1", ctx_factory("r1", deadline_ms=deadline_ms), {"mode": "sleep", "sleepMs": 60000})
    error = runtime.recv_type("error", timeout=5)
    assert error["error"]["type"] == "cancelled"
    assert time.time() * 1000 - deadline_ms < 2000


def test_cancel_for_another_request_is_ignored(start_connector: StartConnector, ctx_factory: Any) -> None:
    runtime = start_connector("echo.py")
    runtime.run("r1", ctx_factory("r1"), {"mode": "sleep", "sleepMs": 300})
    runtime.send({"type": "cancel", "id": "r0", "reason": "stop"})
    assert runtime.recv_type("result")["id"] == "r1"


def test_uncooperative_code_dies_with_its_process_group(start_connector: StartConnector, ctx_factory: Any) -> None:
    runtime = start_connector("echo.py")
    runtime.run("r1", ctx_factory("r1"), {"mode": "sleepUncooperative", "sleepMs": 60000})
    time.sleep(0.2)
    runtime.send({"type": "cancel", "id": "r1", "reason": "stop"})
    time.sleep(0.5)
    assert runtime.process.poll() is None
    os.killpg(runtime.process.pid, signal.SIGKILL)
    assert runtime.wait(5) == -signal.SIGKILL


def test_signals_keep_their_default_disposition(start_connector: StartConnector, ctx_factory: Any) -> None:
    # The event loop of async task code must not trap SIGINT (docs/protocol.md §11).
    runtime = start_connector("echo_async.py")
    runtime.run("r1", ctx_factory("r1"), {"mode": "sleep", "sleepMs": 60000})
    time.sleep(0.5)
    runtime.process.send_signal(signal.SIGINT)
    assert runtime.wait(5) == -signal.SIGINT
    runtime = start_connector("echo.py")
    runtime.process.send_signal(signal.SIGTERM)
    assert runtime.wait(5) == -signal.SIGTERM


def test_exit_in_task_code_ends_the_process(start_connector: StartConnector, ctx_factory: Any) -> None:
    runtime = start_connector("echo.py")
    runtime.run("r1", ctx_factory("r1"), {"mode": "exit"})
    assert runtime.wait(10) == 3
    assert runtime.closed_without_messages()


def test_minimal_task_defaults_to_empty_configs(start_connector: StartConnector, ctx_factory: Any) -> None:
    runtime = start_connector("minimal.py")
    runtime.run("r1", ctx_factory("r1"))
    assert runtime.recv_type("result")["result"] == {"ok": True}
