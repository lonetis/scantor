"""scantor.script.Script: import-time checks of the definition, and the shared entry loader."""

from pathlib import Path
from typing import Any

import pydantic
import pytest

import scantor
from scantor import DefinitionError
from scantor._entry import LoadedEntry, load_entry
from scantor.script import Script, ScriptContext
from scantor.script._definition import SCRIPT_DEFINITION
from tests.script_support import SCRIPT_ENTRIES


class Params(scantor.Config):
    limit: int = 10


class Other(scantor.Config):
    name: str = ""


class Summary(pydantic.BaseModel):
    count: int


def run_params(ctx: ScriptContext, config: Params) -> Summary:
    return Summary(count=config.limit)


def test_valid_definitions() -> None:
    script = Script(run=run_params, config=Params, result=Summary)
    assert script.config is Params
    assert script.result is Summary
    plain = Script(run=lambda ctx, config: None)
    assert plain.config is scantor.Empty
    assert plain.result is None


@pytest.mark.parametrize(
    ("arguments", "message"),
    [
        ({"run": "not callable"}, "run must be a function"),
        ({"run": lambda ctx: None}, "run must accept two positional arguments"),
        ({"run": run_params, "config": dict}, "config must be a pydantic model class"),
        ({"run": run_params, "config": Params, "result": 3}, "result must be a pydantic model class"),
        ({"run": run_params, "config": Other}, "annotated Params, but the script's config type is Other"),
    ],
)
def test_invalid_definitions(arguments: dict[str, Any], message: str) -> None:
    with pytest.raises(DefinitionError, match=message):
        Script(**arguments)


def test_secret_fields_are_rejected() -> None:
    class SecretParams(scantor.Config):
        token: pydantic.SecretStr = pydantic.SecretStr("")

    class SecretResult(pydantic.BaseModel):
        token: pydantic.SecretStr

    def run(ctx: ScriptContext, config: SecretParams) -> None:
        del ctx, config

    with pytest.raises(DefinitionError, match=r"ctx\.secrets"):
        Script(run=run, config=SecretParams)

    def run_secret(ctx: ScriptContext, config: scantor.Empty) -> SecretResult:
        raise NotImplementedError

    with pytest.raises(DefinitionError, match="the result model SecretResult has a secret field"):
        Script(run=run_secret, result=SecretResult)


def test_entry_loader_takes_the_script() -> None:
    loaded = load_entry(str(SCRIPT_ENTRIES / "report.py"), SCRIPT_DEFINITION)
    assert isinstance(loaded, LoadedEntry)
    assert isinstance(loaded.definition, Script)
    assert loaded.path.name == "report.py"


@pytest.mark.parametrize(
    ("entry", "error_type", "message"),
    [
        ("no_script.py", "validation", "defines no module-level `script`; assign script = scantor.script.Script(...)"),
        ("secret_config.py", "validation", "invalid script definition:"),
    ],
)
def test_entry_loader_errors(entry: str, error_type: str, message: str) -> None:
    loaded = load_entry(str(SCRIPT_ENTRIES / entry), SCRIPT_DEFINITION)
    assert isinstance(loaded, dict)
    assert loaded["type"] == error_type
    assert message in loaded["message"]


def test_entry_import_failure_is_a_script_error(tmp_path: Path) -> None:
    entry = tmp_path / "broken_entry.py"
    entry.write_text("raise ImportError('no such package')\n", encoding="utf-8")
    loaded = load_entry(str(entry), SCRIPT_DEFINITION)
    assert isinstance(loaded, dict)
    assert loaded["type"] == "scriptError"
    assert loaded["message"] == "ImportError: no such package"


def test_a_task_entry_is_not_a_script() -> None:
    loaded = load_entry(str(Path(__file__).parent / "fixtures" / "echo.py"), SCRIPT_DEFINITION)
    assert isinstance(loaded, dict)
    assert "defines no module-level `script`" in loaded["message"]
