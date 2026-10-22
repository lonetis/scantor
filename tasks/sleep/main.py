"""sleep: long-running analyses to watch workers, processes, progress, timeouts and cancellation.

The template `repeat` (unwrapped) creates `times` analyses; each one sleeps for the task config's
`seconds`. The async sleep is cancelled at the analysis deadline or when the worker stops.
"""

import asyncio
import time

from pydantic import BaseModel, Field

import scantor
from scantor import templates


class TaskConfig(scantor.Config):
    seconds: float = Field(default=5, ge=0, le=86400, description="How long each analysis sleeps.")


class Result(BaseModel):
    iteration: int
    slept: float


async def run(
    ctx: scantor.Context, analysis_config: templates.repeat.AnalysisConfig, task_config: TaskConfig
) -> Result:
    started = time.monotonic()
    remaining = task_config.seconds
    while remaining > 0:
        step = min(1.0, remaining)
        await asyncio.sleep(step)  # raises asyncio.CancelledError when the analysis is cancelled
        remaining -= step
        ctx.progress(
            1 - remaining / task_config.seconds, f"{task_config.seconds - remaining:g} of {task_config.seconds:g} s"
        )
    return Result(iteration=analysis_config.iteration, slept=round(time.monotonic() - started, 3))


task = scantor.Task(task_config=TaskConfig, result=Result, schedule=templates.repeat.schedule, run=run)
