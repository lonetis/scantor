"""Template proxies: native models against the canonical schemas and fixtures (cases D5, T4)."""

import json
from pathlib import Path
from typing import Any

import pydantic
import pytest

from scantor import templates
from tests.harness import SCHEMAS
from tests.schema_compat import incompatibilities

NAMES = sorted(
    path.name.removesuffix(".json")
    for path in (SCHEMAS / "templates").glob("*.json")
    if not path.name.endswith(".fixtures.json")
)


def _canonical(name: str) -> dict[str, Any]:
    return json.loads((SCHEMAS / "templates" / f"{name}.json").read_text(encoding="utf-8"))


def _fixtures(name: str) -> dict[str, Any]:
    return json.loads((SCHEMAS / "templates" / f"{name}.fixtures.json").read_text(encoding="utf-8"))


def _module(name: str) -> Any:
    return getattr(templates, name)


def test_every_canonical_template_has_a_proxy() -> None:
    assert sorted(templates.NAMES) == NAMES
    for name in NAMES:
        assert _module(name).schedule.__scantor_template__ == name


@pytest.mark.parametrize("name", NAMES)
def test_exported_schemas_match_the_canonical_ones(name: str) -> None:
    module, canonical = _module(name), _canonical(name)
    assert (
        incompatibilities(module.ScanConfig.model_json_schema(mode="validation"), canonical["$defs"]["scanConfig"])
        == []
    )
    assert (
        incompatibilities(
            module.AnalysisConfig.model_json_schema(mode="validation"), canonical["$defs"]["analysisConfig"]
        )
        == []
    )


@pytest.mark.parametrize("name", NAMES)
def test_native_models_accept_and_reject_the_fixture_configs(name: str) -> None:
    module, fixtures = _module(name), _fixtures(name)
    for case in fixtures["scanConfig"]["valid"]:
        parsed = module.ScanConfig.model_validate_json(json.dumps(case["input"]))
        assert parsed.model_dump(mode="json", by_alias=True) == case["effective"], case["name"]
    for case in fixtures["scanConfig"]["invalid"]:
        raw = json.dumps(case["input"])
        if case["kind"] == "schema":
            with pytest.raises(pydantic.ValidationError):
                module.ScanConfig.model_validate_json(raw)
        else:  # semantic: accepted by the schema, rejected only by the template's Validate step
            module.ScanConfig.model_validate_json(raw)
    for case in fixtures["analysisConfig"]["valid"]:
        parsed = module.AnalysisConfig.model_validate_json(json.dumps(case["input"]))
        assert parsed.model_dump(mode="json", by_alias=True) == case["input"], case["name"]
    for case in fixtures["analysisConfig"]["invalid"]:
        with pytest.raises(pydantic.ValidationError):
            module.AnalysisConfig.model_validate_json(json.dumps(case["input"]))


def test_python_attribute_names_of_camel_case_fields() -> None:
    config = templates.cidr.ScanConfig(max_analyses=10)
    assert config.max_analyses == 10
    assert config.model_dump(mode="json", by_alias=True)["maxAnalyses"] == 10
    assert templates.cidr.ScanConfig.model_validate({"maxAnalyses": 5}).max_analyses == 5


def test_template_scan_configs_can_be_extended() -> None:
    class ScanConfig(templates.tranco.ScanConfig):
        skip_tlds: list[str] = ["cn"]

    from scantor.templates._stream import canonical_scan_config

    extended = ScanConfig(limit=10, skip_tlds=["ru"])
    assert canonical_scan_config(extended, templates.tranco.ScanConfig) == {
        "list": "latest",
        "subdomains": False,
        "offset": 0,
        "limit": 10,
    }
    assert canonical_scan_config({"limit": 5, "extra": 1}, templates.tranco.ScanConfig) == {"limit": 5}
    assert canonical_scan_config({"max_analyses": 3}, templates.cidr.ScanConfig) == {"maxAnalyses": 3}


@pytest.mark.parametrize("name", NAMES)
def test_template_models_roundtrip_through_a_wrapped_schedule(
    name: str, start_connector: Any, ctx_factory: Any, tmp_path: Path
) -> None:
    runtime = start_connector("template_models.py")
    fixtures = _fixtures(name)
    for index, case in enumerate(fixtures["scanConfig"]["valid"]):
        request_id = f"s{index}"
        runtime.schedule(
            request_id, ctx_factory(request_id, kind="schedule"), {"template": name, "config": case["input"]}
        )
        example = fixtures["analysisConfig"]["valid"][0]["input"]
        transcript = runtime.serve_template([example])
        assert transcript.request is not None
        assert transcript.request["template"] == name
        assert transcript.request["scanConfig"] == case["effective"]
        assert transcript.analyses == [{"template": name, "config": example}]
        assert transcript.end["type"] == "done"
    for index, case in enumerate(fixtures["scanConfig"]["invalid"]):
        request_id = f"i{index}"
        runtime.schedule(
            request_id, ctx_factory(request_id, kind="schedule"), {"template": name, "config": case["input"]}
        )
        if case["kind"] == "schema":
            assert runtime.recv_type("error")["error"]["type"] == "validation"
        else:
            transcript = runtime.serve_template(
                [], error={"type": "validation", "message": "rejected", "retryable": False}
            )
            assert transcript.end["error"]["type"] == "validation"
    for index, case in enumerate(fixtures["analysisConfig"]["valid"]):
        request_id = f"r{index}"
        runtime.run(request_id, ctx_factory(request_id), {"template": name, "config": case["input"]})
        assert runtime.recv_type("result")["result"] == {"config": case["input"]}
    for index, case in enumerate(fixtures["analysisConfig"]["invalid"]):
        request_id = f"q{index}"
        runtime.run(request_id, ctx_factory(request_id), {"template": name, "config": case["input"]})
        assert runtime.recv_type("error")["error"]["type"] == "validation"
