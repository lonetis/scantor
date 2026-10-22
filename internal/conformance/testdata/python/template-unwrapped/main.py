"""Conformance fixture template-unwrapped: the range proxy passed unwrapped."""

from pydantic import BaseModel

import scantor
from scantor import templates


class Result(BaseModel):
    value: int


def run(ctx: scantor.Context, analysis_config: templates.range.AnalysisConfig, task_config: scantor.Empty) -> Result:
    return Result(value=analysis_config.value)


task = scantor.Task(result=Result, schedule=templates.range.schedule, run=run)
