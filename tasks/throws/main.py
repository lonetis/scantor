"""throws: every way an analysis or a schedule can fail, chosen by the task config.

The schedule wraps the template `range`: it iterates the template's stream and can fail before the
first analysis. `run` waits `work_seconds`, then ends as `mode` says.
"""

import os
import time
from collections.abc import Iterator
from typing import Literal

from pydantic import BaseModel, Field

import scantor
from scantor import templates

Mode = Literal["ok", "error", "fatal", "retry", "flaky", "timeout", "crash"]


class TaskConfig(scantor.Config):
    mode: Mode = Field(
        default="error",
        description=(
            "ok: succeed; error: raise an exception (taskError, retried); fatal: raise scantor.Fatal (no "
            "retry); retry: raise scantor.Retry; flaky: fail the first fail_attempts attempts, then succeed; "
            "timeout: outlive the analysis timeout; crash: exit the process."
        ),
    )
    work_seconds: float = Field(default=0, ge=0, le=3600, description="Simulated work before the outcome.")
    fail_attempts: int = Field(default=1, ge=0, le=20, description="flaky: attempts that fail before one succeeds.")
    retry_delay: float | None = Field(
        default=None, ge=0, description="retry: requested delay in seconds; null uses the scan's backoff."
    )
    fail_in_schedule: bool = Field(default=False, description="Raise in schedule before the first analysis.")


class Result(BaseModel):
    value: int
    attempt: int


def schedule(
    ctx: scantor.Context, scan_config: templates.range.ScanConfig, task_config: TaskConfig
) -> Iterator[templates.range.AnalysisConfig]:
    for item in templates.range.schedule(ctx, scan_config):
        if task_config.fail_in_schedule:
            raise RuntimeError("demo exception in schedule")
        yield item


def run(ctx: scantor.Context, analysis_config: templates.range.AnalysisConfig, task_config: TaskConfig) -> Result:
    time.sleep(task_config.work_seconds)  # do some heavy work
    match task_config.mode:
        case "error":
            raise RuntimeError("demo exception in run")  # taskError: retried after the backoff
        case "fatal":
            raise scantor.Fatal("demo fatal error")  # fails now, no further attempts
        case "retry":
            raise scantor.Retry("demo retry", delay=task_config.retry_delay)  # retried after the delay
        case "flaky" if ctx.attempt <= task_config.fail_attempts:
            raise RuntimeError(f"demo failure in attempt {ctx.attempt}")
        case "timeout":
            # Ignores ctx.cancelled on purpose: the runtime ends the analysis at its deadline (timeout).
            time.sleep((ctx.remaining() or 3600) + 60)
        case "crash":
            os._exit(3)  # the process dies (crash) and is replaced
        case _:
            pass
    return Result(value=analysis_config.value, attempt=ctx.attempt)


task = scantor.Task(
    task_config=TaskConfig,
    scan_config=templates.range.ScanConfig,
    analysis_config=templates.range.AnalysisConfig,
    result=Result,
    schedule=schedule,
    run=run,
)
