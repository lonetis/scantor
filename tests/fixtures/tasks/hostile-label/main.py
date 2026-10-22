"""hostile-label: the task is harmless; its Dockerfile claims labels that only scantor sets (docs/security.md LBL)."""

from pydantic import BaseModel

import scantor


class Result(BaseModel):
    ok: bool


def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: scantor.Empty) -> Result:
    return Result(ok=True)


task = scantor.Task(result=Result, run=run)
