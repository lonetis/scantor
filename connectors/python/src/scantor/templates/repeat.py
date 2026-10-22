"""Template `repeat`: `times` analyses whose config is only the 0-based iteration number.

Canonical schema: `schemas/templates/repeat.json`.
"""

from collections.abc import Mapping
from typing import Annotated, Any

from pydantic import Field

from scantor.context import Context
from scantor.models import Config
from scantor.templates._fields import JSON_INTEGER, MAX_SAFE_INTEGER
from scantor.templates._stream import TemplateStream, canonical_scan_config, template_schedule


class ScanConfig(Config):
    """How many analyses to create."""

    times: Annotated[int, Field(ge=1, le=MAX_SAFE_INTEGER), JSON_INTEGER] = Field(
        default=1, description="Number of analyses."
    )


class AnalysisConfig(Config):
    """One repetition."""

    iteration: Annotated[int, Field(ge=0, le=MAX_SAFE_INTEGER), JSON_INTEGER] = Field(description="0-based iteration.")


@template_schedule("repeat")
def schedule(
    ctx: Context, scan_config: ScanConfig | Mapping[str, Any], task_config: object = None
) -> TemplateStream[AnalysisConfig]:
    """Yield `times` analysis configs. `task_config` is accepted and ignored."""
    return TemplateStream(ctx, "repeat", canonical_scan_config(scan_config, ScanConfig), AnalysisConfig)
