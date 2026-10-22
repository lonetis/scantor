"""Conformance fixture schedule: a synchronous generator."""

from collections.abc import Iterator

from pydantic import BaseModel

import scantor


class ScanConfig(scantor.Config):
    count: int = 3
    failAt: int | None = None  # noqa: N815
    fatalAt: int | None = None  # noqa: N815


class AnalysisConfig(scantor.Config):
    n: int


class Result(BaseModel):
    n: int


def schedule(ctx: scantor.Context, scan_config: ScanConfig, task_config: scantor.Empty) -> Iterator[AnalysisConfig]:
    for n in range(scan_config.count):
        if scan_config.failAt == n:
            raise RuntimeError(f"failing before item {n}")
        if scan_config.fatalAt == n:
            raise scantor.Fatal(f"fatal before item {n}")
        yield AnalysisConfig(n=n)


def run(ctx: scantor.Context, analysis_config: AnalysisConfig, task_config: scantor.Empty) -> Result:
    return Result(n=analysis_config.n)


task = scantor.Task(scan_config=ScanConfig, analysis_config=AnalysisConfig, result=Result, schedule=schedule, run=run)
