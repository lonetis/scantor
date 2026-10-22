"""crashy: analyses that end the hard way, chosen by the task config.

`exit` ends the connector process with code 3, `memory` allocates beyond the worker's memory limit, `hang` sleeps
past the analysis timeout without looking at ctx.cancelled, `ok` succeeds.
"""

import os
import time
from typing import Literal

from pydantic import BaseModel, Field

import scantor


class TaskConfig(scantor.Config):
    mode: Literal["exit", "memory", "hang", "ok"] = "exit"
    memory_mib: int = Field(default=4096, ge=1, le=65536, description="memory: how much to allocate.")


class Result(BaseModel):
    mode: str


def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: TaskConfig) -> Result:
    match task_config.mode:
        case "exit":
            os._exit(3)
        case "memory":
            chunks = [bytearray(1024 * 1024) for _ in range(task_config.memory_mib)]
            ctx.log("info", "allocated", chunks=len(chunks))
        case "hang":
            time.sleep((ctx.remaining() or 3600) + 60)
        case "ok":
            pass
    return Result(mode=task_config.mode)


task = scantor.Task(task_config=TaskConfig, result=Result, run=run)
