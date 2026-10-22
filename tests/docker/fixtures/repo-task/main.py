"""A task of the fixtures server's git repositories: one analysis that echoes the task config."""

from pydantic import BaseModel

import scantor


class TaskConfig(scantor.Config):
    text: str = "imported from git"


class Result(BaseModel):
    echo: str


def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: TaskConfig) -> Result:
    return Result(echo=task_config.text)


task = scantor.Task(task_config=TaskConfig, result=Result, run=run)
