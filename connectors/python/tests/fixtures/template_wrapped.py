from collections.abc import Iterator

from pydantic import BaseModel

import scantor
from scantor import templates


class ScanConfig(scantor.Config):
    start: int = 0
    end: int = 10
    stopAfter: int | None = None  # noqa: N815


class AnalysisConfig(scantor.Config):
    n: int


class Result(BaseModel):
    n: int


def schedule(ctx: scantor.Context, scan_config: ScanConfig, task_config: scantor.Empty) -> Iterator[AnalysisConfig]:
    for produced, item in enumerate(
        templates.range.schedule(ctx, {"start": scan_config.start, "end": scan_config.end, "step": 1})
    ):
        if scan_config.stopAfter is not None and produced >= scan_config.stopAfter:
            return
        yield AnalysisConfig(n=item.value * 2)


def run(ctx: scantor.Context, analysis_config: AnalysisConfig, task_config: scantor.Empty) -> Result:
    return Result(n=analysis_config.n)


task = scantor.Task(scan_config=ScanConfig, analysis_config=AnalysisConfig, result=Result, schedule=schedule, run=run)
