"""Typing tests (checked by basedpyright, never executed).

Every line ending in `# pyright: ignore[...]` must be a type error: the project enables
reportUnnecessaryTypeIgnoreComment, so an expected error that disappears fails the check.
"""

import datetime
from collections.abc import AsyncIterator, Iterator
from typing import assert_type

from pydantic import BaseModel

import scantor
from scantor import templates


class TaskConfig(scantor.Config):
    greeting: str = "Hello"


class Other(scantor.Config):
    level: int = 0


class Result(BaseModel):
    text: str


def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: TaskConfig) -> Result:
    return Result(text=task_config.greeting)


ok_minimal = scantor.Task(task_config=TaskConfig, result=Result, run=run)
assert_type(ok_minimal, scantor.Task[TaskConfig, scantor.Empty, scantor.Empty, Result])


async def run_async(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: TaskConfig) -> Result:
    return Result(text=task_config.greeting)


ok_async = scantor.Task(task_config=TaskConfig, result=Result, run=run_async)


def run_dict(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: TaskConfig) -> dict[str, str]:
    return {"text": task_config.greeting}


ok_dict = scantor.Task(task_config=TaskConfig, result=Result, run=run_dict)


def run_swapped(ctx: scantor.Context, task_config: TaskConfig, analysis_config: scantor.Empty) -> Result:
    return Result(text=task_config.greeting)


bad_swapped = scantor.Task(task_config=TaskConfig, result=Result, run=run_swapped)  # pyright: ignore[reportArgumentType]


def run_wrong_return(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: TaskConfig) -> TaskConfig:
    return task_config


bad_return = scantor.Task(task_config=TaskConfig, result=Result, run=run_wrong_return)  # pyright: ignore[reportArgumentType]


def run_wrong_parameter(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: Other) -> Result:
    return Result(text=str(task_config.level))


bad_parameter = scantor.Task(task_config=TaskConfig, result=Result, run=run_wrong_parameter)  # pyright: ignore[reportArgumentType]
bad_result_type = scantor.Task(task_config=TaskConfig, result=str, run=run)  # pyright: ignore[reportArgumentType]


# Unwrapped template: its own scan and analysis config types are implied.
def run_tranco(
    ctx: scantor.Context, analysis_config: templates.tranco.AnalysisConfig, task_config: TaskConfig
) -> Result:
    return Result(text=f"{analysis_config.domain} {analysis_config.rank}")


ok_unwrapped = scantor.Task(task_config=TaskConfig, result=Result, schedule=templates.tranco.schedule, run=run_tranco)
assert_type(
    ok_unwrapped,
    scantor.Task[TaskConfig, templates.tranco.ScanConfig, templates.tranco.AnalysisConfig, Result],
)
bad_unwrapped = scantor.Task(task_config=TaskConfig, result=Result, schedule=templates.tranco.schedule, run=run)  # pyright: ignore[reportArgumentType]


# Wrapped template inside a custom generator.
class ScanConfig(templates.tranco.ScanConfig):
    skip_tlds: list[str] = []


class AnalysisConfig(scantor.Config):
    url: str


def schedule(ctx: scantor.Context, scan_config: ScanConfig, task_config: TaskConfig) -> Iterator[AnalysisConfig]:
    for item in templates.tranco.schedule(ctx, scan_config):
        assert_type(item, templates.tranco.AnalysisConfig)
        yield AnalysisConfig(url=f"https://{item.domain}/")


async def schedule_async(
    ctx: scantor.Context, scan_config: ScanConfig, task_config: TaskConfig
) -> AsyncIterator[AnalysisConfig]:
    async for item in templates.tranco.schedule(ctx, scan_config):
        yield AnalysisConfig(url=f"https://{item.domain}/")


def run_url(ctx: scantor.Context, analysis_config: AnalysisConfig, task_config: TaskConfig) -> Result:
    return Result(text=analysis_config.url)


ok_wrapped = scantor.Task(
    task_config=TaskConfig,
    scan_config=ScanConfig,
    analysis_config=AnalysisConfig,
    result=Result,
    schedule=schedule,
    run=run_url,
)
ok_wrapped_async = scantor.Task(
    task_config=TaskConfig,
    scan_config=ScanConfig,
    analysis_config=AnalysisConfig,
    result=Result,
    schedule=schedule_async,
    run=run_url,
)


def schedule_wrong_items(
    ctx: scantor.Context, scan_config: ScanConfig, task_config: TaskConfig
) -> Iterator[TaskConfig]:
    yield task_config


bad_items = scantor.Task(
    task_config=TaskConfig,
    scan_config=ScanConfig,
    analysis_config=AnalysisConfig,
    result=Result,
    schedule=schedule_wrong_items,
    run=run_url,  # pyright: ignore[reportArgumentType] - reported on run: it cannot take the yielded type
)


def uses_context(ctx: scantor.Context) -> None:
    ctx.log("info", "fetched", status=200)
    ctx.log("verbose", "fetched")  # pyright: ignore[reportArgumentType]
    assert_type(ctx.files.put("a.txt", b"abc"), scantor.FileRef)
    assert_type(ctx.remaining(), float | None)
    ctx.files.put("a.txt", 42)  # pyright: ignore[reportArgumentType]
    for item in templates.cidr.schedule(ctx, templates.cidr.ScanConfig(cidrs=["192.0.2.0/30"], max_analyses=4)):
        assert_type(item.ip, str)
        item.address  # pyright: ignore[reportAttributeAccessIssue]
    for value in templates.range.schedule(ctx, {"start": 1, "end": 3}):
        assert_type(value.value, int)


retry_seconds = scantor.Retry("rate limited", delay=1.5)
retry_timedelta = scantor.Retry("rate limited", delay=datetime.timedelta(seconds=30))
retry_text = scantor.Retry("rate limited", delay="30s")  # pyright: ignore[reportArgumentType]
