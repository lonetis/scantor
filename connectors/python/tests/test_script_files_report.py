"""tests/fixtures/scripts/files-report: the script the end-to-end tests run on a scan of the example task files."""

import ast
import csv
import io
import json
import subprocess
import sys

import yaml
from jsonschema import Draft202012Validator

from tests.conftest import tool_env
from tests.harness import REPO_ROOT, SCHEMAS
from tests.script_fake import RUN_ID, FakePlatform
from tests.script_support import ScriptProcess, add_files_analysis, files_scan

FOLDER = REPO_ROOT / "tests" / "fixtures" / "scripts" / "files-report"
CONNECTOR = REPO_ROOT / "connectors" / "python"
MANIFEST = Draft202012Validator(json.loads((SCHEMAS / "script-manifest.schema.json").read_text(encoding="utf-8")))
MINIMAL_DOCKERFILE = "ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\nCOPY requirements.txt .\n"


def run(platform: FakePlatform) -> tuple[int, str, str]:
    return ScriptProcess(platform, FOLDER / "main.py", cwd=FOLDER).wait()


def csv_rows(data: bytes) -> list[list[str]]:
    return list(csv.reader(io.StringIO(data.decode("utf-8"), newline="")))


def test_folder_follows_the_script_structure() -> None:
    manifest = yaml.safe_load((FOLDER / "scantor-script.yaml").read_text(encoding="utf-8"))
    MANIFEST.validate(manifest)
    assert manifest["name"] == FOLDER.name
    assert manifest["language"] == "python"
    assert (FOLDER / "Dockerfile").read_text(encoding="utf-8").startswith(MINIMAL_DOCKERFILE)
    assert (FOLDER / ".dockerignore").is_file()
    assert "pydantic" not in (FOLDER / "requirements.txt").read_text(encoding="utf-8").split("#")[0]


def test_models_are_the_files_task_models() -> None:
    def classes(source: str) -> dict[str, str]:
        tree = ast.parse(source)
        return {node.name: ast.unparse(node) for node in tree.body if isinstance(node, ast.ClassDef)}

    task = classes((REPO_ROOT / "tasks" / "files" / "main.py").read_text(encoding="utf-8"))
    script = classes((FOLDER / "models.py").read_text(encoding="utf-8"))
    assert script == {name: task[name] for name in ("Attachments", "Result")}


def test_lint_and_type_check() -> None:
    sources = [str(FOLDER / "main.py"), str(FOLDER / "models.py")]
    options = ["--config", str(CONNECTOR / "pyproject.toml")]
    for command in (
        # The folder's own modules (models.py) are first party, like scantor.
        ["check", *options, "--config", 'lint.isort.known-first-party = ["scantor", "models"]', *sources],
        ["format", "--check", *options, *sources],
    ):
        completed = subprocess.run(
            [sys.executable, "-m", "ruff", *command], capture_output=True, text=True, timeout=120, check=False
        )
        assert completed.returncode == 0, completed.stdout + completed.stderr
    completed = subprocess.run(
        [sys.executable, "-m", "scantor.check", "main.py"],
        cwd=FOLDER,
        env=tool_env(),
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr


def test_report_of_a_files_scan(platform: FakePlatform) -> None:
    scan = files_scan(platform, ["example.org", "example.net"], name="files-e2e")
    platform.add_analysis(scan, status="failed", error={"type": "taskError", "message": "boom"})
    add_files_analysis(platform, scan, "example.com")
    code, stdout, stderr = run(platform)
    assert code == 0, stderr
    summary = {"scan": "files-e2e", "analyses": 3, "files": 21, "bytes": platform.finishes[0]["result"]["bytes"]}
    assert platform.finishes == [{"result": {**summary, "resumed": False}}]
    outputs = platform.stored_outputs()
    rows = csv_rows(outputs["files.csv"].data)
    assert rows[0] == ["seq", "item", "files", "bytes", "upper"]
    assert [[seq, item, files, upper] for seq, item, files, _, upper in rows[1:]] == [
        ["0", "example.org", "7", "EXAMPLE.ORG"],
        ["1", "example.net", "7", "EXAMPLE.NET"],
        ["3", "example.com", "7", "EXAMPLE.COM"],
    ]
    assert sum(int(row[3]) for row in rows[1:]) == summary["bytes"]
    assert json.loads(outputs["summary.json"].data) == {**summary, "resumed": False}
    assert outputs["summary.json"].content_type == "application/json"
    assert platform.progress[-1] == {"done": 3, "total": 3, "message": "21 files read"}
    assert platform.checkpoints[-1] == {"after_seq": 3, "analyses": 3, "files": 21, "bytes": summary["bytes"]}
    assert platform.describes[0]["configSchema"]["properties"]["workers"]["default"] == 8
    assert "report written analyses=3 files=21" in stdout
    # Every file was read once and verified.
    gets = [key for method, key, _ in platform.file_requests if method == "GET" and key.startswith("files/")]
    assert len(gets) == 3 * 7 + 3  # every file, and data.json once more for its JSON


def test_sample_run_with_a_limit(platform: FakePlatform) -> None:
    files_scan(platform, [f"site-{n}.org" for n in range(5)])
    platform.limit = 2
    code, _, stderr = run(platform)
    assert code == 0, stderr
    assert platform.finishes[0]["result"]["analyses"] == 2
    assert len(csv_rows(platform.stored_outputs()["files.csv"].data)) == 3
    assert platform.progress[-1]["total"] == 2


def test_restart_with_resume_continues_after_the_checkpoint(platform: FakePlatform) -> None:
    files_scan(platform, [f"site-{n}.org" for n in range(4)])
    earlier = platform.seed_output(
        "files.csv.partial", b"seq,item,files,bytes,upper\r\n0,site-0.org,7,10,SITE-0.ORG\r\n"
    )
    checkpoint = {"after_seq": 0, "analyses": 1, "files": 7, "bytes": 10}
    platform.resume = {"runId": RUN_ID, "checkpoint": checkpoint, "outputs": [earlier]}
    code, _, stderr = run(platform)
    assert code == 0, stderr
    result = platform.finishes[0]["result"]
    assert (result["analyses"], result["files"], result["resumed"]) == (4, 28, True)
    rows = csv_rows(platform.stored_outputs()["files.csv"].data)
    assert [row[0] for row in rows] == ["seq", "0", "1", "2", "3"]
    assert platform.stream_requests[0]["afterSeq"] == 0
