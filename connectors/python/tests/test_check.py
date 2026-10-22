"""`python -m scantor.check <entry>` (SCANTOR_CHECK_CMD): basedpyright in the check line format."""

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

from scantor import check
from tests.conftest import tool_env

ERROR_LINE = re.compile(r"^(?P<file>[^:\s]+):(?P<line>\d+)(:(?P<column>\d+))?: (?P<message>.+)$")

GOOD = """
from pydantic import BaseModel

import scantor


class Result(BaseModel):
    text: str


def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: scantor.Empty) -> Result:
    return Result(text="ok")


task = scantor.Task(result=Result, run=run)
"""

BAD = GOOD.replace('Result(text="ok")', "Result(text=42)")


def run_check(folder: Path, entry: str = "main.py") -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "scantor.check", entry],
        cwd=folder,
        env=tool_env(),
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )


def test_clean_task_passes(tmp_path: Path) -> None:
    (tmp_path / "main.py").write_text(GOOD)
    completed = run_check(tmp_path)
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert not any(ERROR_LINE.match(line) for line in completed.stdout.splitlines())


def test_type_errors_are_reported_per_line(tmp_path: Path) -> None:
    (tmp_path / "lib").mkdir()
    (tmp_path / "main.py").write_text(BAD)
    (tmp_path / "lib" / "helper.py").write_text("value: int = 'text'\n")
    completed = run_check(tmp_path)
    assert completed.returncode == 1
    errors = [match for line in completed.stdout.splitlines() if (match := ERROR_LINE.match(line))]
    files = {match["file"] for match in errors}
    assert files == {"main.py", "lib/helper.py"}
    main_error = next(match for match in errors if match["file"] == "main.py")
    assert main_error["line"] == str(BAD.splitlines().index("    return Result(text=42)") + 1)
    assert "reportArgumentType" in main_error["message"]


def test_task_configuration_is_honoured(tmp_path: Path) -> None:
    (tmp_path / "main.py").write_text(GOOD + "\n\ndef untyped(value):\n    return value\n")
    (tmp_path / "pyrightconfig.json").write_text(json.dumps({"typeCheckingMode": "strict"}))
    completed = run_check(tmp_path)
    assert completed.returncode == 1
    assert "reportMissingParameterType" in completed.stdout


def test_missing_entry(tmp_path: Path) -> None:
    completed = run_check(tmp_path, "nope.py")
    assert completed.returncode == 1
    assert ERROR_LINE.match(completed.stdout.splitlines()[0])


def test_warnings_never_look_like_errors(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    output = {
        "generalDiagnostics": [
            {
                "file": str(tmp_path / "main.py"),
                "severity": "warning",
                "message": "something\n  detail",
                "rule": "reportFoo",
                "range": {"start": {"line": 2, "character": 4}, "end": {"line": 2, "character": 5}},
            }
        ],
        "summary": {"filesAnalyzed": 1, "warningCount": 1},
    }
    code = check.report(json.dumps(output), "", 0, tmp_path)
    assert code == 0
    printed = capsys.readouterr().out.splitlines()
    assert printed[0] == "[warning] main.py line 3:5 something detail (reportFoo)"
    assert not any(ERROR_LINE.match(line) for line in printed)


def test_basedpyright_failures_fail_the_check(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    code = check.report("", "Error: config is not valid JSON", 3, tmp_path, culprit="pyrightconfig.json")
    assert code == 1
    printed = capsys.readouterr().out.splitlines()
    assert printed[0] == "basedpyright | Error: config is not valid JSON"
    errors = [match for line in printed if (match := ERROR_LINE.match(line))]
    assert [(match["file"], match["line"]) for match in errors] == [("pyrightconfig.json", "1")]


def test_warnings_fail_the_check_when_the_task_says_so(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    # basedpyright exits 1 without errors when the task's configuration sets failOnWarnings.
    output = {
        "generalDiagnostics": [
            {
                "file": str(tmp_path / "main.py"),
                "severity": "warning",
                "message": "unused import",
                "rule": "reportUnusedImport",
                "range": {"start": {"line": 0, "character": 7}, "end": {"line": 0, "character": 9}},
            }
        ],
        "summary": {"filesAnalyzed": 1, "warningCount": 1},
    }
    assert check.report(json.dumps(output), "", 1, tmp_path) == 1
    printed = capsys.readouterr().out.splitlines()
    assert printed[0] == "main.py:1:8: unused import (reportUnusedImport)"


def test_unparsable_task_configuration_is_an_error(tmp_path: Path) -> None:
    (tmp_path / "main.py").write_text("value: int = 1\n")
    (tmp_path / "pyrightconfig.json").write_text("{ not json")
    completed = run_check(tmp_path)
    assert completed.returncode == 1
    errors = [match for line in completed.stdout.splitlines() if (match := ERROR_LINE.match(line))]
    assert [match["file"] for match in errors] == ["pyrightconfig.json"], completed.stdout
    assert "could not be parsed" in errors[0]["message"]
