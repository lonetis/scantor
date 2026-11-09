"""`python -m scantor.script <entry>` end to end against the fake platform: bootstrap to finish."""

import os
import subprocess
import sys
from typing import Any

import pytest

from scantor.script import ScriptError
from tests.script_fake import RUN_ID, FakePlatform
from tests.script_support import SCRIPT_ENTRIES, ScriptProcess, files_scan, make_context, wait_until


def items_scan(platform: FakePlatform, items: list[str]) -> None:
    scan = platform.add_scan("items")
    for item in items:
        platform.add_analysis(scan, result={"item": item, "length": len(item)})
    platform.add_analysis(scan, status="failed", error={"type": "fatal", "message": "no"})


def run_entry(platform: FakePlatform, name: str) -> tuple[int, str, str]:
    return ScriptProcess(platform, SCRIPT_ENTRIES / name).wait()


def test_run_reports_describe_progress_checkpoint_and_result(platform: FakePlatform) -> None:
    items_scan(platform, ["a", "bbbb", "cc"])
    platform.config = {"min_length": 2}
    platform.secrets = {"API_KEY": "s3cr3t"}
    code, stdout, stderr = run_entry(platform, "report.py")
    assert code == 0, stderr
    assert platform.finishes == [
        {"result": {"analyses": 3, "long_items": ["bbbb", "cc"], "secret_length": 6, "resumed": False}}
    ]
    (describe,) = platform.describes
    assert describe["configSchema"]["properties"]["min_length"]["default"] == 0
    assert describe["resultSchema"]["required"] == ["analyses", "long_items", "secret_length", "resumed"]
    assert platform.progress[-1] == {"done": 3, "total": 3, "message": None}
    assert platform.checkpoints[-1] == {"done": 3, "after_seq": 2}  # seq 3 (failed) comes after
    assert platform.stored_outputs()["items.txt"].data == b"bbbb\ncc\n"
    assert "streamed analyses=3" in stdout
    assert "s3cr3t" not in stdout + stderr
    # Bootstrap first, finish last.
    assert platform.requests[0][:2] == ("GET", "/bootstrap")
    assert platform.requests[-1][:2] == ("POST", "/finish")


def test_resumed_run_sees_the_checkpoint(platform: FakePlatform) -> None:
    items_scan(platform, ["a"])
    platform.resume = {"runId": RUN_ID, "checkpoint": {"done": 10}, "outputs": []}
    code, _, stderr = run_entry(platform, "report.py")
    assert code == 0, stderr
    assert platform.finishes[0]["result"]["analyses"] == 11
    assert platform.finishes[0]["result"]["resumed"] is True


def test_a_500_is_retried_and_the_result_is_not_lost(platform: FakePlatform) -> None:
    # A short database outage answers 500 internal; every call of the API is idempotent.
    items_scan(platform, ["a", "bb"])
    platform.faults["GET /bootstrap"] = [(500, "internal")]
    platform.faults["POST /finish"] = [(500, "internal"), (503, "unavailable")]
    code, _, stderr = run_entry(platform, "report.py")
    assert code == 0, stderr
    assert platform.finishes[0]["result"]["analyses"] == 2
    assert [path for _, path, _ in platform.requests].count("/finish") == 3


def test_a_query_timeout_is_not_retried(platform: FakePlatform) -> None:
    scan = platform.add_scan("running", state="running")
    platform.add_analysis(scan, result={})
    platform.faults[f"POST /scans/{scan.id}/aggregate"] = [(500, "internal"), (504, "unavailable")]
    ctx = make_context(platform)
    assert ctx.count(ctx.scans[0]) == 1
    aggregates = [path for _, path, _ in platform.requests if path.endswith("/aggregate")]
    assert len(aggregates) == 3

    # The query hit its time limit and would hit it again: raised at once.
    platform.faults[f"POST /scans/{scan.id}/aggregate"] = [(504, "queryTimeout")]
    with pytest.raises(ScriptError) as error:
        ctx.count(ctx.scans[0])
    assert (error.value.code, error.value.status, error.value.retryable) == ("queryTimeout", 504, False)
    aggregates = [path for _, path, _ in platform.requests if path.endswith("/aggregate")]
    assert len(aggregates) == 4


def test_invalid_config_fails_with_validation(platform: FakePlatform) -> None:
    items_scan(platform, ["a"])
    platform.config = {"min_length": "long", "unknown": 1}
    code, _, stderr = run_entry(platform, "report.py")
    assert code == 1
    (finish,) = platform.finishes
    assert finish["error"]["type"] == "validation"
    assert "the script config is invalid (2 errors)" in finish["error"]["message"]
    assert "/min_length" in finish["error"]["message"]
    assert "the script failed" in stderr
    assert not platform.stream_requests  # run was never called


def test_exception_fails_with_script_error_and_flushes(platform: FakePlatform) -> None:
    items_scan(platform, ["a", "bb"])
    platform.config = {"mode": "raise"}
    code, _, stderr = run_entry(platform, "report.py")
    assert code == 1
    (finish,) = platform.finishes
    assert finish["error"]["type"] == "scriptError"
    assert finish["error"]["message"] == "RuntimeError: the script broke on purpose"
    assert "report.py" in finish["error"]["stack"]
    assert "scantor/script/_main.py" not in finish["error"]["stack"]
    assert platform.checkpoints[-1] == {"done": 2, "after_seq": 1}
    assert "RuntimeError" in stderr


def test_invalid_result_fails_with_validation(platform: FakePlatform) -> None:
    items_scan(platform, ["a"])
    platform.config = {"mode": "bad_result"}
    code, _, _ = run_entry(platform, "report.py")
    assert code == 1
    assert platform.finishes[0]["error"]["type"] == "validation"
    assert "the result is invalid" in platform.finishes[0]["error"]["message"]


def test_result_size_limit(platform: FakePlatform) -> None:
    items_scan(platform, ["x" * 200])
    platform.max_result_bytes = 100
    code, _, _ = run_entry(platform, "report.py")
    assert code == 1
    assert "the limit is 100" in platform.finishes[0]["error"]["message"]


def test_async_run_with_a_plain_result(platform: FakePlatform) -> None:
    items_scan(platform, ["a"])
    code, _, stderr = run_entry(platform, "async_script.py")
    assert code == 0, stderr
    assert platform.finishes == [{"result": {"scans": ["items"], "cpus": 2}}]
    assert platform.describes == [
        {
            "configSchema": {
                "additionalProperties": False,
                "description": "No parameters.",
                "properties": {},
                "title": "Empty",
                "type": "object",
            },
            "resultSchema": None,
        }
    ]


@pytest.mark.parametrize(
    ("entry", "message"),
    [
        ("secret_config.py", "invalid script definition: the config model Params has a secret field"),
        ("no_script.py", "no_script.py defines no module-level `script`"),
        ("missing.py", "entry missing.py does not exist"),
    ],
)
def test_entry_errors(platform: FakePlatform, entry: str, message: str) -> None:
    code, _, _ = run_entry(platform, entry)
    assert code == 1
    (finish,) = platform.finishes
    assert finish["error"]["type"] == "validation"
    assert message in finish["error"]["message"]


def test_processes_two(platform: FakePlatform) -> None:
    files_scan(platform, [f"site-{n}.org" for n in range(12)])
    code, _, stderr = run_entry(platform, "parallel.py")
    assert code == 0, stderr
    result: dict[str, Any] = platform.finishes[0]["result"]
    assert result["analyses"] == 12
    assert result["characters"] == sum(len(f"Notes on site-{n}.org\n") for n in range(12))
    assert 1 <= result["processes"] <= 2
    assert result["parent"] == 0
    assert result["watermark"] == 11


def test_sigterm_cancels_flushes_and_stores_partial_outputs(platform: FakePlatform) -> None:
    files_scan(platform, [f"s{n}" for n in range(5)])
    process = ScriptProcess(platform, SCRIPT_ENTRIES / "cancellable.py")
    wait_until(lambda: len(platform.checkpoints) >= 1)
    process.terminate()
    code, _, stderr = process.wait()
    assert code == 143, stderr
    (finish,) = platform.finishes
    assert finish["error"] == {"type": "scriptError", "message": "cancelled: received SIGTERM"}
    partial = platform.stored_outputs()["rows.txt.partial"]
    rows = partial.data.decode().splitlines()
    assert rows
    assert platform.checkpoints[-1] == {"done": len(rows)}


@pytest.mark.skipif("SCANTOR_SCRIPT_CMD" not in os.environ, reason="runs in the base image (ENV contract)")
def test_the_base_image_script_command(platform: FakePlatform) -> None:
    items_scan(platform, ["a"])
    command = os.environ["SCANTOR_SCRIPT_CMD"].split()
    assert command == ["python", "-m", "scantor.script", "{entry}"]
    completed = subprocess.run(
        [part.replace("{entry}", "async_script.py") for part in command],
        cwd=SCRIPT_ENTRIES,
        env={**os.environ, **platform.environment()},
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    assert platform.finishes == [{"result": {"scans": ["items"], "cpus": 2}}]


def test_without_environment_it_explains_itself() -> None:
    completed = subprocess.run(
        [sys.executable, "-m", "scantor.script", "main.py"],
        env={"PATH": "/usr/bin:/bin", "PYTHONPATH": ":".join(sys.path)},
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert completed.returncode == 2
    assert "SCANTOR_URL and SCANTOR_SCRIPT_TOKEN are not set" in completed.stderr
