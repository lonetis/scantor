"""Conformance fixture template-repeat: the repeat proxy passed unwrapped with its types."""

from typing import Any

from pydantic import BaseModel

import scantor
from scantor import templates


class Result(BaseModel):
    config: dict[str, Any]


def run(ctx: scantor.Context, analysis_config: templates.repeat.AnalysisConfig, task_config: scantor.Empty) -> Result:
    return Result(config=analysis_config.model_dump(by_alias=True))


task = scantor.Task(result=Result, schedule=templates.repeat.schedule, run=run)
