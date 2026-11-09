"""The script scaffold (scaffolds/python-script) against the script SDK: rendered, linted, type-checked and run."""

import csv
import io
import json
import shutil
import subprocess
import sys
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator

from tests.conftest import tool_env
from tests.harness import REPO_ROOT, SCHEMAS
from tests.script_fake import RUN_ID, FakePlatform
from tests.script_support import ScriptProcess, files_scan
from tests.test_examples import render

SCAFFOLD = REPO_ROOT / "scaffolds" / "python-script"
CONNECTOR = REPO_ROOT / "connectors" / "python"
MANIFEST = Draft202012Validator(json.loads((SCHEMAS / "script-manifest.schema.json").read_text(encoding="utf-8")))
RENDER_DATA = {
    "Name": "s-python-test",
    "Description": 'A "quoted": description',
    "Language": "python",
    "Version": "1.4.0",
    "BaseImage": "ghcr.io/lonetis/scantor-base-python:1.4.0",
    "ManifestSchemaURL": "https://raw.githubusercontent.com/lonetis/scantor/v1.4.0/schemas/script-manifest.schema.json",
    "GuideURL": "https://github.com/lonetis/scantor/blob/v1.4.0/docs/guide/scripts.md",
}


def scaffold(target: Path) -> Path:
    for source in (SCAFFOLD / "files").rglob("*"):
        if source.is_file():
            destination = target / str(source.relative_to(SCAFFOLD / "files")).removesuffix(".tmpl")
            destination.parent.mkdir(parents=True, exist_ok=True)
            if source.suffix == ".tmpl":
                destination.write_text(render(source.read_text(encoding="utf-8"), RENDER_DATA), encoding="utf-8")
            else:
                shutil.copyfile(source, destination)
    return target


def test_scaffold_files(tmp_path: Path) -> None:
    folder = scaffold(tmp_path / "s-python-test")
    manifest = yaml.safe_load((folder / "scantor-script.yaml").read_text(encoding="utf-8"))
    MANIFEST.validate(manifest)
    assert manifest == {
        "scantor": 1,
        "name": "s-python-test",
        "language": "python",
        "description": 'A "quoted": description',
    }
    assert (folder / "Dockerfile").read_text(encoding="utf-8") == (
        REPO_ROOT / "scaffolds" / "python" / "files" / "Dockerfile"
    ).read_text(encoding="utf-8")
    assert "WORKDIR" not in (folder / "Dockerfile").read_text(encoding="utf-8")
    assert RENDER_DATA["GuideURL"] in (folder / "AGENTS.md").read_text(encoding="utf-8")


def test_scaffold_is_lint_clean_and_type_checks(tmp_path: Path) -> None:
    folder = scaffold(tmp_path / "s-python-test")
    sources = [str(folder / "main.py"), str(folder / "models.py")]
    options = ["--config", str(CONNECTOR / "pyproject.toml")]
    for command in (
        ["check", *options, "--config", 'lint.isort.known-first-party = ["scantor", "models"]', *sources],
        ["format", "--check", *options, *sources],
    ):
        completed = subprocess.run(
            [sys.executable, "-m", "ruff", *command], capture_output=True, text=True, timeout=120, check=False
        )
        assert completed.returncode == 0, completed.stdout + completed.stderr
    completed = subprocess.run(
        [sys.executable, "-m", "scantor.check", "main.py"],
        cwd=folder,
        env=tool_env(),
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr


def test_scaffold_runs(tmp_path: Path, platform: FakePlatform) -> None:
    folder = scaffold(tmp_path / "s-python-test")
    scan = files_scan(platform, ["example.org", "example.net"], name="files-e2e")
    platform.add_analysis(scan, status="failed", error={"type": "taskError", "message": "boom"})
    code, _, stderr = ScriptProcess(platform, folder / "main.py", cwd=folder).wait()
    assert code == 0, stderr
    assert platform.finishes == [{"result": {"scan": "files-e2e", "analyses": 2, "files": 14}}]
    rows = list(csv.reader(io.StringIO(platform.stored_outputs()["analyses.csv"].data.decode("utf-8"), newline="")))
    assert rows == [["seq", "files"], ["0", "7"], ["1", "7"]]
    assert platform.progress[-1] == {"done": 2, "total": 2, "message": None}
    # The failed analysis (seq 2) is skipped by the status filter, so the watermark passes it.
    assert platform.checkpoints[-1] == {"after_seq": 2, "analyses": 2, "files": 14}


def test_scaffold_resumes(tmp_path: Path, platform: FakePlatform) -> None:
    # The run it resumes was stopped after seq 1: its partial CSV and checkpoint agree.
    folder = scaffold(tmp_path / "s-python-test")
    scan = files_scan(platform, [f"site-{n}.org" for n in range(4)], name="files-e2e")
    earlier = platform.seed_output("analyses.csv.partial", b"seq,files\r\n0,7\r\n1,7\r\n", "text/csv")
    checkpoint = {"after_seq": 1, "analyses": 2, "files": 14}
    platform.resume = {"runId": RUN_ID, "checkpoint": checkpoint, "outputs": [earlier]}
    code, _, stderr = ScriptProcess(platform, folder / "main.py", cwd=folder).wait()
    assert code == 0, stderr
    assert platform.finishes == [{"result": {"scan": "files-e2e", "analyses": 4, "files": 28}}]
    assert platform.stream_requests[0]["afterSeq"] == 1
    rows = list(csv.reader(io.StringIO(platform.stored_outputs()["analyses.csv"].data.decode("utf-8"), newline="")))
    assert rows == [["seq", "files"], *[[str(seq), "7"] for seq in range(4)]]
    assert platform.checkpoints[-1] == {"after_seq": scan.analyses[-1]["seq"], "analyses": 4, "files": 28}
