"""echo: the smallest task. Each scan has one analysis that echoes a message from the task config.

There is no schedule, so the template `single` creates exactly one analysis with an empty analysis config.
"""

from pydantic import BaseModel

import scantor


class TaskConfig(scantor.Config):
    text: str = "Hello, World!"


class Result(BaseModel):
    echo: str


def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: TaskConfig) -> Result:
    ctx.log("info", "echoing", length=len(task_config.text))
    return Result(echo=task_config.text)


task = scantor.Task(task_config=TaskConfig, result=Result, run=run)
