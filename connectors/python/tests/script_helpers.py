"""Module-level functions for `ctx.map(..., processes=2)` tests: worker processes import them by name."""

import os
import time
from typing import Any

import pydantic

from scantor.script import Analysis


class ItemResult(pydantic.BaseModel):
    item: str
    length: int


def item_of(analysis: Analysis[ItemResult]) -> str:
    assert analysis.result is not None
    return analysis.result.item


def square(value: int) -> int:
    return value * value


def fail_on_odd(value: int) -> int:
    if value % 2:
        raise ValueError(f"odd: {value}")
    return value


def notes_and_pid(analysis: Analysis[Any]) -> tuple[int, str, int]:
    """Read a file of the analysis in the worker process; return where it ran."""
    return analysis.seq, analysis.read_text("notes.txt"), os.getpid()


def slow_identity(value: int) -> int:
    time.sleep(0.01 * (5 - value % 5))
    return value


class Unpicklable:
    def __reduce__(self) -> Any:
        raise TypeError("not picklable")


def unpicklable_result(value: int) -> Unpicklable:
    del value
    return Unpicklable()


def stuck_unless_zero(value: int) -> int:
    if value:
        time.sleep(120)
    return value
