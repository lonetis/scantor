"""Conformance fixture template-models: configs parsed with the native models of any template."""

from collections.abc import Iterator
from typing import Any

from pydantic import BaseModel

import scantor
from scantor import templates


class ScanConfig(scantor.Config):
    template: str
    config: dict[str, Any]


class AnalysisConfig(scantor.Config):
    template: str
    config: dict[str, Any]


class Result(BaseModel):
    config: dict[str, Any]


def _module(name: str) -> Any:
    return getattr(templates, name)


def schedule(ctx: scantor.Context, scan_config: ScanConfig, task_config: scantor.Empty) -> Iterator[AnalysisConfig]:
    module = _module(scan_config.template)
    parsed = module.ScanConfig.model_validate(scan_config.config)
    for item in module.schedule(ctx, parsed):
        yield AnalysisConfig(template=scan_config.template, config=item.model_dump(by_alias=True))


def run(ctx: scantor.Context, analysis_config: AnalysisConfig, task_config: scantor.Empty) -> Result:
    module = _module(analysis_config.template)
    parsed = module.AnalysisConfig.model_validate(analysis_config.config)
    return Result(config=parsed.model_dump(by_alias=True))


task = scantor.Task(scan_config=ScanConfig, analysis_config=AnalysisConfig, result=Result, schedule=schedule, run=run)
