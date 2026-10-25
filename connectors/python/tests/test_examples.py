"""The Python example tasks (tasks/) and the Python scaffold (scaffolds/python) against the connector."""

import http.server
import json
import re
import shutil
import subprocess
import sys
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import yaml
from jsonschema import Draft202012Validator

from tests.conftest import StartConnector, tool_env
from tests.harness import REPO_ROOT, SCHEMAS, FakeRuntime

CONNECTOR = REPO_ROOT / "connectors" / "python"
TASKS = REPO_ROOT / "tasks"
SCAFFOLD = REPO_ROOT / "scaffolds" / "python"
EXAMPLES = ["echo", "sleep", "throws", "files", "origins"]
TEMPLATES = sorted(
    path.name.removesuffix(".json")
    for path in (SCHEMAS / "templates").glob("*.json")
    if not path.name.endswith(".fixtures.json")
)
MANIFEST = Draft202012Validator(json.loads((SCHEMAS / "task-manifest.schema.json").read_text(encoding="utf-8")))
MINIMAL_DOCKERFILE = "ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\nCOPY requirements.txt .\n"
RENDER_DATA = {
    "Name": "m-python-test",
    "Description": 'A "quoted": description',
    "Language": "python",
    "Template": "single",
    "Version": "1.4.0",
    "BaseImage": "ghcr.io/lonetis/scantor-base-python:1.4.0",
    "ManifestSchemaURL": "https://raw.githubusercontent.com/lonetis/scantor/v1.4.0/schemas/task-manifest.schema.json",
    "GuideURL": "https://github.com/lonetis/scantor/blob/v1.4.0/docs/guide/authoring-python.md",
}


def describe(runtime: FakeRuntime) -> dict[str, Any]:
    runtime.send({"type": "describe", "id": "d1"})
    return runtime.recv_type("description")


def type_check(folder: Path) -> None:
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


# Examples ---------------------------------------------------------------------------------------------


def test_examples_and_scaffold_entries_are_lint_clean() -> None:
    """The code users copy from follows the connector's own ruff rules (scantor as first party)."""
    sources = [str(TASKS / name / "main.py") for name in EXAMPLES] + [str(SCAFFOLD / "entry")]
    options = ["--config", str(CONNECTOR / "pyproject.toml"), "--extension", "tmpl:python"]
    commands = [
        ["check", *options, "--config", 'lint.isort.known-first-party = ["scantor"]', *sources],
        ["format", "--check", *options, *sources],
    ]
    for command in commands:
        completed = subprocess.run(
            [sys.executable, "-m", "ruff", *command], capture_output=True, text=True, timeout=120, check=False
        )
        assert completed.returncode == 0, completed.stdout + completed.stderr


@pytest.mark.parametrize("name", EXAMPLES)
def test_example_folder_follows_the_task_structure(name: str) -> None:
    folder = TASKS / name
    manifest = yaml.safe_load((folder / "scantor.yaml").read_text(encoding="utf-8"))
    MANIFEST.validate(manifest)
    assert manifest["name"] == name
    assert manifest["language"] == "python"
    assert (folder / "Dockerfile").read_text(encoding="utf-8").startswith(MINIMAL_DOCKERFILE)
    assert (folder / ".dockerignore").is_file()
    assert (folder / "main.py").is_file()
    requirements = (folder / "requirements.txt").read_text(encoding="utf-8")
    assert "pydantic" not in requirements.split("#")[0]


@pytest.mark.parametrize("name", EXAMPLES)
def test_example_type_checks(name: str) -> None:
    type_check(TASKS / name)


def test_echo(start_connector: StartConnector, ctx_factory: Any) -> None:
    runtime = start_connector("main.py", cwd=TASKS / "echo")
    assert describe(runtime)["schedule"] == {"kind": "template", "template": "single"}
    runtime.run("r1", ctx_factory("r1"), task_config={"text": "hi"})
    log = runtime.recv_type("log")
    assert log["fields"] == {"length": 2}
    assert runtime.recv_type("result")["result"] == {"echo": "hi"}


def test_sleep(start_connector: StartConnector, ctx_factory: Any) -> None:
    runtime = start_connector("main.py", cwd=TASKS / "sleep")
    assert describe(runtime)["schedule"] == {"kind": "template", "template": "repeat"}
    runtime.run("r1", ctx_factory("r1"), {"iteration": 2}, {"seconds": 1.5})
    progress, result = runtime.until("result")
    assert [message["fraction"] for message in progress] == [pytest.approx(2 / 3), 1.0]
    assert result["result"]["iteration"] == 2
    assert result["result"]["slept"] >= 1.5
    deadline_ms = int(__import__("time").time() * 1000) + 300
    runtime.run("r2", ctx_factory("r2", deadline_ms=deadline_ms), {"iteration": 0}, {"seconds": 30})
    assert runtime.recv_type("error")["error"]["type"] == "cancelled"


def test_throws(start_connector: StartConnector, ctx_factory: Any) -> None:
    runtime = start_connector("main.py", cwd=TASKS / "throws")
    assert describe(runtime)["schedule"] == {"kind": "custom"}
    expectations = {"ok": "result", "error": "taskError", "fatal": "fatal", "retry": "retry"}
    for index, (mode, outcome) in enumerate(expectations.items()):
        request_id = f"r{index}"
        runtime.run(request_id, ctx_factory(request_id), {"value": 7}, {"mode": mode, "retry_delay": 2})
        reply = runtime.recv_type("result", "error")
        assert (reply["type"] if reply["type"] == "result" else reply["error"]["type"]) == outcome
        if mode == "retry":
            assert reply["error"]["delayMs"] == 2000
    runtime.run("f1", ctx_factory("f1", attempt=1), {"value": 1}, {"mode": "flaky", "fail_attempts": 1})
    assert runtime.recv_type("error")["error"]["type"] == "taskError"
    runtime.run("f2", ctx_factory("f2", attempt=2), {"value": 1}, {"mode": "flaky", "fail_attempts": 1})
    assert runtime.recv_type("result")["result"] == {"value": 1, "attempt": 2}

    runtime.schedule("s1", ctx_factory("s1", kind="schedule"), {"end": 3})
    transcript = runtime.serve_template([{"value": 0}, {"value": 1}, {"value": 2}])
    assert transcript.request is not None
    assert transcript.request["template"] == "range"
    assert transcript.analyses == [{"value": 0}, {"value": 1}, {"value": 2}]
    runtime.schedule("s2", ctx_factory("s2", kind="schedule"), {"end": 3}, {"fail_in_schedule": True})
    transcript = runtime.serve_template([{"value": 0}])
    assert transcript.end["error"]["type"] == "taskError"
    assert "demo exception in schedule" in transcript.end["error"]["message"]

    runtime.run("c1", ctx_factory("c1"), {"value": 1}, {"mode": "crash"})
    assert runtime.wait(10) == 3


def test_files(start_connector: StartConnector, ctx_factory: Any) -> None:
    runtime = start_connector("main.py", cwd=TASKS / "files")
    assert describe(runtime)["schedule"] == {"kind": "template", "template": "list"}
    runtime.run("r1", ctx_factory("r1"), {"item": "example.org", "index": 0})
    refs: dict[str, dict[str, Any]] = {}
    while len(refs) < 7:
        message = runtime.recv_type("file")
        refs[message["name"]] = runtime.answer_file(message)
    result = runtime.recv_type("result")["result"]
    assert result["item"] == "example.org"
    assert result["length"] == len("example.org")
    assert result["image"] == refs["image.png"]
    assert result["image"]["contentType"] == "image/png"
    assert result["nested"] == {"data": refs["nested.json"], "image": refs["nested.png"]}
    assert result["gallery"] == [refs["gallery-0.png"], refs["gallery-1.png"]]
    assert result["notes"]["size"] == len("Notes on example.org\n")


@pytest.fixture
def local_origin() -> Iterator[str]:
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            status = 429 if self.path == "/limited" else 200
            self.send_response(status)
            self.send_header("x-test", "yes")
            self.send_header("retry-after", "7")
            self.end_headers()
            self.wfile.write(b"hello")

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - signature of the base class
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()


def test_origins(start_connector: StartConnector, ctx_factory: Any, local_origin: str) -> None:
    runtime = start_connector("main.py", cwd=TASKS / "origins")
    description = describe(runtime)
    assert description["schedule"] == {"kind": "custom"}
    assert {"list", "limit", "skip_tlds", "scheme"} <= set(description["schemas"]["scanConfig"]["properties"])

    runtime.schedule("s1", ctx_factory("s1", kind="schedule"), {"limit": 3, "skip_tlds": ["cn"]})
    items = [
        {"domain": "google.com", "rank": 1},
        {"domain": "baidu.cn", "rank": 2},
        {"domain": "example.org", "rank": 3},
    ]
    transcript = runtime.serve_template(items)
    assert transcript.request is not None
    assert transcript.request["scanConfig"] == {"list": "latest", "subdomains": False, "offset": 0, "limit": 3}
    assert transcript.analyses == [
        {"origin": "https://google.com", "rank": 1},
        {"origin": "https://example.org", "rank": 3},
    ]

    runtime.run("r1", ctx_factory("r1"), {"origin": local_origin, "rank": 1})
    _, result = runtime.until("result")
    assert result["result"]["status"] == 200
    assert result["result"]["headers"]["x-test"] == "yes"
    assert result["result"]["error"] is None
    runtime.run("r2", ctx_factory("r2"), {"origin": f"{local_origin}/limited", "rank": 1})
    _, error = runtime.until("error")
    assert error["error"] == {**error["error"], "type": "retry", "delayMs": 7000}
    runtime.run("r3", ctx_factory("r3"), {"origin": "http://127.0.0.1:9", "rank": 2}, {"timeout_seconds": 2})
    _, result = runtime.until("result")
    assert result["result"]["status"] is None
    assert result["result"]["error"]


# Scaffold ---------------------------------------------------------------------------------------------


def render(text: str, data: dict[str, str]) -> str:
    """Enough of Go text/template ([[ ]] delimiters) for the scaffold's files."""
    text = re.sub(
        r"\[\[- if \.(\w+)\]\](.*?)\[\[- end\]\]",
        lambda match: match.group(2) if data.get(match.group(1)) else "",
        text,
        flags=re.DOTALL,
    )
    text = re.sub(r'\[\[printf "%q" \.(\w+)\]\]', lambda match: json.dumps(data[match.group(1)]), text)
    rendered = re.sub(r"\[\[\.(\w+)\]\]", lambda match: data[match.group(1)], text)
    assert "[[" not in rendered, rendered
    return rendered


def scaffold(target: Path, template: str) -> Path:
    data = {**RENDER_DATA, "Template": template}
    for source in (SCAFFOLD / "files").rglob("*"):
        if source.is_file():
            relative = source.relative_to(SCAFFOLD / "files")
            destination = target / str(relative).removesuffix(".tmpl")
            destination.parent.mkdir(parents=True, exist_ok=True)
            if source.suffix == ".tmpl":
                destination.write_text(render(source.read_text(encoding="utf-8"), data), encoding="utf-8")
            else:
                shutil.copyfile(source, destination)
    entry = SCAFFOLD / "entry" / f"{template}.py.tmpl"
    (target / "main.py").write_text(render(entry.read_text(encoding="utf-8"), data), encoding="utf-8")
    return target


def test_scaffold_has_an_entry_per_template() -> None:
    entries = sorted(path.name.removesuffix(".py.tmpl") for path in (SCAFFOLD / "entry").glob("*.py.tmpl"))
    assert entries == sorted([*TEMPLATES, "custom"])


def test_scaffold_files(tmp_path: Path) -> None:
    folder = scaffold(tmp_path, "single")
    manifest = yaml.safe_load((folder / "scantor.yaml").read_text(encoding="utf-8"))
    MANIFEST.validate(manifest)
    assert manifest == {
        "scantor": 1,
        "name": RENDER_DATA["Name"],
        "language": "python",
        "description": RENDER_DATA["Description"],
    }
    assert (
        (folder / "scantor.yaml")
        .read_text(encoding="utf-8")
        .startswith(f"# yaml-language-server: $schema={RENDER_DATA['ManifestSchemaURL']}\n")
    )
    for name in (
        ".devcontainer/devcontainer.json",
        ".vscode/launch.json",
        ".vscode/tasks.json",
        ".vscode/settings.json",
    ):
        json.loads((folder / name).read_text(encoding="utf-8"))
    devcontainer = json.loads((folder / ".devcontainer/devcontainer.json").read_text(encoding="utf-8"))
    assert devcontainer["build"]["args"] == {"SCANTOR_BASE": RENDER_DATA["BaseImage"]}
    languages = json.loads((SCHEMAS / "languages.json").read_text(encoding="utf-8"))
    expected_extensions = {*languages["languages"]["python"]["editorExtensions"], *languages["commonEditorExtensions"]}
    assert set(devcontainer["customizations"]["vscode"]["extensions"]) == expected_extensions
    launch = json.loads((folder / ".vscode/launch.json").read_text(encoding="utf-8"))["configurations"][0]
    assert launch["connect"] == {"host": "localhost", "port": 5678}
    labels = [
        task["label"] for task in json.loads((folder / ".vscode/tasks.json").read_text(encoding="utf-8"))["tasks"]
    ]
    assert labels == ["scantor: validate", "scantor: dev run", "scantor: dev debug", "scantor: push"]
    assert f"Guide: {RENDER_DATA['GuideURL']}\n" in (folder / "AGENTS.md").read_text(encoding="utf-8")
    assert (folder / "Dockerfile").read_text(encoding="utf-8") == (
        "ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\nCOPY requirements.txt .\n"
        "RUN pip install --no-cache-dir -r requirements.txt\nCOPY . .\n"
    )
    no_description = render((SCAFFOLD / "files" / "scantor.yaml.tmpl").read_text(), {**RENDER_DATA, "Description": ""})
    assert "description" not in yaml.safe_load(no_description)


@pytest.mark.parametrize("template", [*TEMPLATES, "custom"])
def test_scaffold_entries(template: str, tmp_path: Path, start_connector: StartConnector, ctx_factory: Any) -> None:
    folder = scaffold(tmp_path / template, template)
    type_check(folder)
    runtime = start_connector("main.py", cwd=folder)
    description = describe(runtime)
    expected = {"kind": "custom"} if template == "custom" else {"kind": "template", "template": template}
    assert description["schedule"] == expected
    assert description["warnings"] == []
    if template == "custom":
        runtime.schedule("s1", ctx_factory("s1", kind="schedule"), {})
        analyses, done = runtime.until("done")
        assert [message["config"] for message in analyses] == [{"n": 0}, {"n": 1}, {"n": 2}]
        assert done["count"] == 3
        analysis_config: dict[str, Any] = {"n": 0}
    elif template == "single":
        analysis_config = {}
    else:
        fixtures = json.loads((SCHEMAS / "templates" / f"{template}.fixtures.json").read_text(encoding="utf-8"))
        analysis_config = fixtures["analysisConfig"]["valid"][0]["input"]
    runtime.run("r1", ctx_factory("r1"), analysis_config)
    _, result = runtime.until("result")
    assert result["result"]["text"].startswith("Hello, ")
