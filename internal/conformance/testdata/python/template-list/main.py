"""Conformance fixture template-list: the list proxy passed unwrapped with its types."""

from typing import Any

from pydantic import BaseModel

import scantor
from scantor import templates


class Result(BaseModel):
    config: dict[str, Any]


def run(ctx: scantor.Context, analysis_config: templates.list.AnalysisConfig, task_config: scantor.Empty) -> Result:
    return Result(config=analysis_config.model_dump(by_alias=True))


task = scantor.Task(result=Result, schedule=templates.list.schedule, run=run)
