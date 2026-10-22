"""The describe request (cases D1–D5) and the describe output it leads to."""

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from tests.conftest import StartConnector
from tests.harness import SCHEMAS
from tests.schema_compat import incompatibilities

DRAFT = "https://json-schema.org/draft/2020-12/schema"
TEMPLATES = sorted(
    path.name.removesuffix(".json")
    for path in (SCHEMAS / "templates").glob("*.json")
    if not path.name.endswith(".fixtures.json")
)


def describe(runtime: Any) -> dict[str, Any]:
    runtime.send({"type": "describe", "id": "d1"})
    description = runtime.recv_type("description")
    assert description["id"] == "d1"
    return description


def as_describe_output(description: dict[str, Any]) -> dict[str, Any]:
    """The runtime's normalisation (docs/tasks.md §7 step 3) reduced to what the schema checks."""
    schemas = {key: {**schema, "$schema": DRAFT} for key, schema in description["schemas"].items()}
    return {
        "protocolVersion": 1,
        "connector": {"language": "python", "version": "dev"},
        "schemas": schemas,
        "schedule": description["schedule"],
        "secretPaths": {"taskConfig": [], "scanConfig": [], "analysisConfig": [], "result": []},
        "uploadPaths": {"taskConfig": [], "scanConfig": []},
        "fileRefPaths": [],
        "warnings": description["warnings"],
    }


def assert_valid_describe_output(description: dict[str, Any]) -> None:
    schema = json.loads((SCHEMAS / "describe.schema.json").read_text(encoding="utf-8"))
    Draft202012Validator(schema).validate(as_describe_output(description))
    for exported in description["schemas"].values():
        Draft202012Validator.check_schema(exported)


def test_echo_description(start_connector: StartConnector) -> None:
    description = describe(start_connector("echo.py"))
    task_config = description["schemas"]["taskConfig"]
    assert task_config["additionalProperties"] is False
    assert task_config["properties"]["greeting"]["default"] == "Hello"
    assert "greeting" not in task_config.get("required", [])
    token = task_config["properties"]["apiToken"]
    assert any(branch.get("writeOnly") for branch in token["anyOf"])
    analysis_config = description["schemas"]["analysisConfig"]
    assert analysis_config["additionalProperties"] is False
    assert set(analysis_config["properties"]) == {"name", "mode", "sleepMs", "bytes"}
    result = description["schemas"]["result"]
    assert result["type"] == "object"
    assert result["properties"]["files"]["items"] == {"$ref": "#/$defs/FileRef"}
    file_ref = result["$defs"]["FileRef"]
    assert file_ref["x-scantor"] == "file"
    assert file_ref["additionalProperties"] is False
    assert set(file_ref["required"]) == {"id", "name", "size", "sha256", "contentType"}
    assert description["schedule"] == {"kind": "template", "template": "single"}
    assert description["warnings"] == []
    assert_valid_describe_output(description)


def test_minimal_description(start_connector: StartConnector) -> None:
    description = describe(start_connector("minimal.py"))
    for key in ("taskConfig", "scanConfig", "analysisConfig"):
        schema = description["schemas"][key]
        assert (schema["type"], schema["properties"], schema["additionalProperties"]) == ("object", {}, False)
    assert description["schedule"] == {"kind": "template", "template": "single"}
    assert_valid_describe_output(description)


def test_custom_and_unwrapped_schedules(start_connector: StartConnector) -> None:
    assert describe(start_connector("schedule.py"))["schedule"] == {"kind": "custom"}
    assert describe(start_connector("template_wrapped.py"))["schedule"] == {"kind": "custom"}
    unwrapped = describe(start_connector("template_unwrapped.py"))
    assert unwrapped["schedule"] == {"kind": "template", "template": "range"}
    assert_valid_describe_output(unwrapped)


@pytest.mark.parametrize("name", TEMPLATES)
def test_unwrapped_template_tasks(name: str, start_connector: StartConnector, tmp_path: Path) -> None:
    (tmp_path / "main.py").write_text(
        f"""
from pydantic import BaseModel

import scantor
from scantor import templates


class Result(BaseModel):
    config: dict[str, object]


def run(ctx: scantor.Context, analysis_config: templates.{name}.AnalysisConfig, task_config: scantor.Empty) -> Result:
    return Result(config=analysis_config.model_dump(by_alias=True))


task = scantor.Task(result=Result, schedule=templates.{name}.schedule, run=run)
"""
    )
    description = describe(start_connector("main.py", cwd=tmp_path))
    assert description["schedule"] == {"kind": "template", "template": name}
    canonical = json.loads((SCHEMAS / "templates" / f"{name}.json").read_text(encoding="utf-8"))["$defs"]
    assert incompatibilities(description["schemas"]["scanConfig"], canonical["scanConfig"]) == []
    assert incompatibilities(description["schemas"]["analysisConfig"], canonical["analysisConfig"]) == []
    assert_valid_describe_output(description)


def test_list_upload_field_is_annotated(start_connector: StartConnector, tmp_path: Path) -> None:
    schema = json.loads(json.dumps(__import__("scantor").templates.list.ScanConfig.model_json_schema()))
    assert schema["properties"]["upload"]["x-scantor"] == "upload"
    assert schema["properties"]["upload"]["format"] == "uuid"


def test_single_task_with_required_analysis_fields_warns(start_connector: StartConnector, tmp_path: Path) -> None:
    (tmp_path / "main.py").write_text(
        """
from pydantic import BaseModel

import scantor


class AnalysisConfig(scantor.Config):
    url: str


class Result(BaseModel):
    url: str


def run(ctx: scantor.Context, analysis_config: AnalysisConfig, task_config: scantor.Empty) -> Result:
    return Result(url=analysis_config.url)


task = scantor.Task(analysis_config=AnalysisConfig, result=Result, run=run)
"""
    )
    description = describe(start_connector("main.py", cwd=tmp_path))
    assert len(description["warnings"]) == 1
    assert "AnalysisConfig rejects" in description["warnings"][0]
