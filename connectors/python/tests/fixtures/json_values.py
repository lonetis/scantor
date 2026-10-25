"""Results and analysis configs that JSON cannot represent (docs/protocol.md §5.5)."""

from collections.abc import Iterator
from typing import Any

from pydantic import BaseModel

import scantor

RESULTS: dict[str, dict[str, Any]] = {
    "ok": {},
    "binary": {"data": b"\xff\xfe"},
    "utf8Bytes": {"data": b"abc"},
    "nan": {"anything": [float("nan")]},
    "infinity": {"anything": [1, {"x": float("-inf")}]},
    "intKey": {"mapping": {1: "a"}},
}

CONFIG_DATA = {"binary": b"\xff\xfe", "utf8Bytes": b"abc"}


class ScanConfig(scantor.Config):
    case: str = "binary"


class AnalysisConfig(scantor.Config):
    case: str = "ok"
    data: bytes | None = None


class Values(BaseModel):
    data: bytes | None = None
    anything: list[Any] = []
    mapping: dict[Any, str] = {}


def schedule(ctx: scantor.Context, scan_config: ScanConfig, task_config: scantor.Empty) -> Iterator[AnalysisConfig]:
    yield AnalysisConfig()
    yield AnalysisConfig(case=scan_config.case, data=CONFIG_DATA[scan_config.case])


def run(ctx: scantor.Context, analysis_config: AnalysisConfig, task_config: scantor.Empty) -> Values:
    return Values(**RESULTS[analysis_config.case])


task = scantor.Task(scan_config=ScanConfig, analysis_config=AnalysisConfig, result=Values, schedule=schedule, run=run)
