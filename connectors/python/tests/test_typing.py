"""basedpyright checks the definition API (docs/tasks.md §5.6; negative cases in tests/typing)."""

import json
import subprocess
import sys
from pathlib import Path

from tests.conftest import basedpyright

CONNECTOR = Path(__file__).resolve().parents[1]


def test_typing_cases() -> None:
    completed = subprocess.run(
        [basedpyright(), "--outputjson", "--pythonpath", sys.executable, "tests/typing"],
        cwd=CONNECTOR,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    output = json.loads(completed.stdout)
    problems = [
        f"{Path(item['file']).name}:{item['range']['start']['line'] + 1}: {item['message']}"
        for item in output["generalDiagnostics"]
        if item["severity"] == "error"
    ]
    assert problems == []
    assert output["summary"]["filesAnalyzed"] >= 1
