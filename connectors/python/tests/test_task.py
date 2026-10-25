"""Definition checks of scantor.Task at import time."""

from collections.abc import Iterator

import pydantic
import pytest

import scantor
from scantor import templates


class TaskConfig(scantor.Config):
    greeting: str = "Hello"


class Result(pydantic.BaseModel):
    text: str


def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: TaskConfig) -> Result:
    return Result(text=task_config.greeting)


def test_defaults() -> None:
    task = scantor.Task(task_config=TaskConfig, result=Result, run=run)
    assert task.scan_config is scantor.Empty
    assert task.analysis_config is scantor.Empty
    assert task.template == "single"
    assert task.schedule is templates.single.schedule


def test_non_models_are_rejected() -> None:
    with pytest.raises(TypeError, match="result must be a pydantic model class"):
        scantor.Task(result=dict, run=run)  # pyright: ignore[reportArgumentType]
    with pytest.raises(TypeError, match="task_config must be a pydantic model class"):
        scantor.Task(task_config=str, result=Result, run=run)  # pyright: ignore[reportArgumentType]
    with pytest.raises(TypeError, match="run must be a function"):
        scantor.Task(result=Result, run="run")  # pyright: ignore[reportArgumentType]


def test_omitted_task_config_with_an_annotated_run_is_rejected() -> None:
    with pytest.raises(scantor.DefinitionError, match="pass task_config=TaskConfig"):
        scantor.Task(result=Result, run=run)


def test_run_must_take_three_arguments() -> None:
    def short(ctx: scantor.Context) -> Result:
        return Result(text="")

    with pytest.raises(scantor.DefinitionError, match="three positional arguments"):
        scantor.Task(result=Result, run=short)  # pyright: ignore[reportArgumentType]


def test_unwrapped_template_implies_its_types() -> None:
    def run_tranco(
        ctx: scantor.Context, analysis_config: templates.tranco.AnalysisConfig, task_config: TaskConfig
    ) -> Result:
        return Result(text=analysis_config.domain)

    task = scantor.Task(task_config=TaskConfig, result=Result, run=run_tranco, schedule=templates.tranco.schedule)
    assert task.template == "tranco"
    assert task.scan_config is templates.tranco.ScanConfig
    assert task.analysis_config is templates.tranco.AnalysisConfig

    class Extended(templates.tranco.ScanConfig):
        skip: list[str] = []

    with pytest.raises(scantor.DefinitionError, match="uses its own types"):
        scantor.Task(
            task_config=TaskConfig,
            scan_config=Extended,
            result=Result,
            run=run_tranco,
            schedule=templates.tranco.schedule,
        )


def test_custom_schedule_is_checked() -> None:
    class ScanConfig(scantor.Config):
        count: int = 3

    class AnalysisConfig(scantor.Config):
        n: int

    def schedule(ctx: scantor.Context, scan_config: ScanConfig, task_config: TaskConfig) -> Iterator[AnalysisConfig]:
        yield AnalysisConfig(n=0)

    def run_n(ctx: scantor.Context, analysis_config: AnalysisConfig, task_config: TaskConfig) -> Result:
        return Result(text=str(analysis_config.n))

    task = scantor.Task(
        task_config=TaskConfig,
        scan_config=ScanConfig,
        analysis_config=AnalysisConfig,
        result=Result,
        schedule=schedule,
        run=run_n,
    )
    assert task.template is None
    with pytest.raises(scantor.DefinitionError, match="pass scan_config=ScanConfig"):
        scantor.Task(
            task_config=TaskConfig, analysis_config=AnalysisConfig, result=Result, schedule=schedule, run=run_n
        )


def test_scan_config_without_schedule_is_rejected() -> None:
    class ScanConfig(scantor.Config):
        count: int = 3

    with pytest.raises(scantor.DefinitionError, match="needs a schedule"):
        scantor.Task(task_config=TaskConfig, scan_config=ScanConfig, result=Result, run=run)


def test_retry_delay_units() -> None:
    import datetime

    assert scantor.Retry("x").delay_ms is None
    assert scantor.Retry("x", 1.5).delay_ms == 1500
    assert scantor.Retry("x", datetime.timedelta(minutes=1)).delay_ms == 60000
    assert scantor.Retry("x", -3).delay_ms == 0
    longest = (2**63 - 1) // 1_000_000  # milliseconds of a Go time.Duration, the runtime's type
    assert scantor.Retry("x", 1e300).delay_ms == longest
    assert scantor.Retry("x", 10**400).delay_ms == longest


@pytest.mark.parametrize("delay", [float("nan"), float("inf"), float("-inf")])
def test_retry_rejects_non_finite_delays(delay: float) -> None:
    with pytest.raises(ValueError, match="finite"):
        scantor.Retry("rate limited", delay)


@pytest.mark.parametrize("delay", ["60", True, [1]])
def test_retry_rejects_non_numeric_delays(delay: object) -> None:
    with pytest.raises(TypeError, match="seconds"):
        scantor.Retry("rate limited", delay)  # pyright: ignore[reportArgumentType]


def test_file_ref_serialises_content_type_as_camel_case() -> None:
    ref = scantor.FileRef(id="1", name="a", size=1, sha256="0" * 64, content_type="text/plain")
    assert ref.model_dump()["contentType"] == "text/plain"
    assert scantor.FileRef.model_validate(ref.model_dump()).content_type == "text/plain"
    schema = scantor.FileRef.model_json_schema(mode="serialization")
    assert schema["x-scantor"] == "file"
    assert "contentType" in schema["properties"]
