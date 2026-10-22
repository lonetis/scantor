"""big-result: a result larger than SCANTOR_MAX_RESULT_BYTES, which fails the analysis with a validation error."""

from pydantic import BaseModel, Field

import scantor


class TaskConfig(scantor.Config):
    size_bytes: int = Field(default=2 * 1024 * 1024, ge=1, le=64 * 1024 * 1024, description="Length of the result text.")


class Result(BaseModel):
    text: str


def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: TaskConfig) -> Result:
    return Result(text="x" * task_config.size_bytes)


task = scantor.Task(task_config=TaskConfig, result=Result, run=run)
