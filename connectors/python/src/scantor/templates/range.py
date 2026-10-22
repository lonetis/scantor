"""Template `range`: one analysis per integer of start, start+step, ... up to but excluding end.

Python `range` semantics; `step` must not be 0. Canonical schema: `schemas/templates/range.json`.
"""

from collections.abc import Mapping
from typing import Annotated, Any

from pydantic import Field

from scantor.context import Context
from scantor.models import Config
from scantor.templates._fields import JSON_INTEGER, MAX_SAFE_INTEGER
from scantor.templates._stream import TemplateStream, canonical_scan_config, template_schedule

SafeInt = Annotated[int, Field(ge=-MAX_SAFE_INTEGER, le=MAX_SAFE_INTEGER), JSON_INTEGER]


class ScanConfig(Config):
    """The integer range."""

    start: SafeInt = Field(default=0, description="First value (inclusive).")
    end: SafeInt = Field(default=10, description="Bound (exclusive).")
    step: SafeInt = Field(default=1, description="Increment; negative counts down; 0 is rejected.")


class AnalysisConfig(Config):
    """One integer of the range."""

    value: SafeInt = Field(description="The integer.")


@template_schedule("range")
def schedule(
    ctx: Context, scan_config: ScanConfig | Mapping[str, Any], task_config: object = None
) -> TemplateStream[AnalysisConfig]:
    """Yield one analysis config per integer. `task_config` is accepted and ignored."""
    return TemplateStream(ctx, "range", canonical_scan_config(scan_config, ScanConfig), AnalysisConfig)
