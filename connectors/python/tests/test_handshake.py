"""Handshake, version negotiation and process lifecycle (docs/protocol.md §4, §10, §11; cases H1–H5)."""

import subprocess
import sys
import time

from tests.conftest import FIXTURES, StartConnector
from tests.harness import DEFAULT_LIMITS


def test_hello_ready_and_import_output_stays_off_the_protocol(start_connector: StartConnector) -> None:
    runtime = start_connector("echo.py", handshake=False)
    hello = runtime.recv_type("hello")
    assert hello["id"] == "hello"
    assert hello["protocol"]["min"] <= 1 <= hello["protocol"]["max"]
    assert hello["connector"]["language"] == "python"
    assert hello["connector"]["runtime"].startswith("cpython 3.")
    assert hello["pid"] == runtime.process.pid
    runtime.send(
        {
            "type": "welcome",
            "id": "hello",
            "protocolVersion": 1,
            "mode": "worker",
            "runtime": {"version": "1.4.0"},
            "limits": DEFAULT_LIMITS,
            "cancelGraceMs": 5000,
        }
    )
    assert runtime.recv_type("ready") == {"type": "ready", "id": "hello"}
    assert runtime.shutdown() == 0
    assert "importing echo" in runtime.stdout.text()
    assert "importing echo" in runtime.stderr.text()
    assert not any(b"importing" in line for line in runtime.lines)


def test_runtime_rejecting_hello_ends_the_process(start_connector: StartConnector) -> None:
    runtime = start_connector("echo.py", handshake=False)
    runtime.recv_type("hello")
    runtime.send({"type": "error", "id": "hello", "error": {"type": "validation", "message": "no common version"}})
    assert runtime.wait(5) != 0
    assert runtime.closed_without_messages()


def test_unsupported_protocol_version_is_reported(start_connector: StartConnector) -> None:
    runtime = start_connector("echo.py", handshake=False)
    runtime.recv_type("hello")
    runtime.send(
        {
            "type": "welcome",
            "id": "hello",
            "protocolVersion": 2,
            "mode": "worker",
            "runtime": {"version": "9.0.0"},
            "limits": DEFAULT_LIMITS,
            "cancelGraceMs": 5000,
        }
    )
    error = runtime.recv_type("error")
    assert error["id"] == "hello"
    assert error["error"]["type"] == "validation"
    assert runtime.wait(5) == 1


def test_import_error_is_a_task_error(start_connector: StartConnector) -> None:
    runtime = start_connector("import_error.py", handshake=False)
    runtime.recv_type("hello")
    runtime.send(
        {
            "type": "welcome",
            "id": "hello",
            "protocolVersion": 1,
            "mode": "describe",
            "runtime": {"version": "1.4.0"},
            "limits": DEFAULT_LIMITS,
            "cancelGraceMs": 5000,
        }
    )
    error = runtime.recv_type("error")
    assert error["id"] == "hello"
    assert error["error"]["type"] == "taskError"
    assert "boom at import" in error["error"]["message"]
    assert "import_error.py" in error["error"]["stack"]
    assert "scantor/_server.py" not in error["error"]["stack"]
    assert runtime.wait(5) == 1


def test_module_without_task_is_an_invalid_definition(start_connector: StartConnector) -> None:
    for entry, expected in (("bad_definition.py", "defines no module-level `task`"), ("bad_types.py", "result")):
        runtime = start_connector(entry, handshake=False)
        runtime.recv_type("hello")
        runtime.send(
            {
                "type": "welcome",
                "id": "hello",
                "protocolVersion": 1,
                "mode": "describe",
                "runtime": {"version": "1.4.0"},
                "limits": DEFAULT_LIMITS,
                "cancelGraceMs": 5000,
            }
        )
        error = runtime.recv_type("error")
        assert error["error"]["type"] == "validation"
        assert expected in error["error"]["message"]
        assert runtime.wait(5) == 1


def test_missing_entry_is_an_invalid_definition(start_connector: StartConnector) -> None:
    runtime = start_connector("does_not_exist.py", handshake=False)
    runtime.recv_type("hello")
    runtime.send(
        {
            "type": "welcome",
            "id": "hello",
            "protocolVersion": 1,
            "mode": "describe",
            "runtime": {"version": "1.4.0"},
            "limits": DEFAULT_LIMITS,
            "cancelGraceMs": 5000,
        }
    )
    assert runtime.recv_type("error")["error"]["type"] == "validation"
    assert runtime.wait(5) == 1


def test_started_without_protocol_fds_exits_2() -> None:
    completed = subprocess.run(
        [sys.executable, "-m", "scantor.serve", "echo.py"],
        cwd=FIXTURES,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert completed.returncode == 2
    assert 'run it with "scantor dev run"' in completed.stderr


def test_shutdown_and_end_of_input_exit_0(start_connector: StartConnector) -> None:
    runtime = start_connector("echo.py")
    started = time.monotonic()
    assert runtime.shutdown(5) == 0
    assert time.monotonic() - started < 5
    runtime = start_connector("echo.py")
    runtime.close_input()
    assert runtime.wait(5) == 0


def test_unknown_fields_and_requests(start_connector: StartConnector, ctx_factory) -> None:
    runtime = start_connector("echo.py", handshake=False)
    runtime.handshake(xFuture=1)
    runtime.send({"type": "frobnicate", "id": "z1"})
    error = runtime.recv_type("error")
    assert error == {
        "type": "error",
        "id": "z1",
        "error": {"type": "validation", "message": "unsupported request frobnicate"},
    }
    runtime.run("r1", ctx_factory("r1"), xFuture=1)
    result = runtime.recv_type("result")
    assert result["id"] == "r1"
    assert result["result"]["text"] == "Hello, world!"
