"""nondeterministic: a custom schedule that yields random items slowly.

A scheduler restarted mid-stream replays the schedule and finds different items, so the scan fails with
"schedule() is not deterministic" (chaos tests).
"""

import random
import time
from collections.abc import Iterator

from pydantic import BaseModel, Field

import scantor


class ScanConfig(scantor.Config):
    count: int = Field(default=200, ge=1, le=100000)
    delay_seconds: float = Field(default=0.2, ge=0, le=10, description="Pause before each item.")


class AnalysisConfig(scantor.Config):
    value: float


class Result(BaseModel):
    value: float


def schedule(ctx: scantor.Context, scan_config: ScanConfig, task_config: scantor.Empty) -> Iterator[AnalysisConfig]:
    for _ in range(scan_config.count):
        time.sleep(scan_config.delay_seconds)
        yield AnalysisConfig(value=random.random())  # deliberately not deterministic


def run(ctx: scantor.Context, analysis_config: AnalysisConfig, task_config: scantor.Empty) -> Result:
    return Result(value=analysis_config.value)


task = scantor.Task(scan_config=ScanConfig, analysis_config=AnalysisConfig, result=Result, schedule=schedule, run=run)
