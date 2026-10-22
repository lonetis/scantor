"""no-hello: the task module is valid, but the Dockerfile replaces the connector command with silent.py."""

from pydantic import BaseModel

import scantor


class Result(BaseModel):
    ok: bool


def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: scantor.Empty) -> Result:
    return Result(ok=True)


task = scantor.Task(result=Result, run=run)
