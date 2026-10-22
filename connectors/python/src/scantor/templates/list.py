"""Template `list`: one analysis per item of an inline list and/or an uploaded file.

Items are trimmed and empty items are skipped. Canonical schema: `schemas/templates/list.json`.
"""

from collections.abc import Mapping
from typing import Annotated, Any

from pydantic import Field

from scantor.context import Context
from scantor.models import Config
from scantor.templates._fields import JSON_INTEGER, MAX_SAFE_INTEGER, JsonStr, UuidStr
from scantor.templates._stream import TemplateStream, canonical_scan_config, template_schedule

Item = Annotated[JsonStr, Field(min_length=1, max_length=4096)]


class ScanConfig(Config):
    """Which items to analyse: inline items, then the non-empty lines of an uploaded list."""

    items: list[Item] = Field(default=[], max_length=10000, description="Inline items (trimmed; empty items skipped).")
    upload: UuidStr | None = Field(
        default=None,
        description=(
            "Id of an uploaded list (POST /api/uploads, kind list); its non-empty lines follow the inline items."
        ),
        json_schema_extra={"format": "uuid", "x-scantor": "upload"},
    )
    offset: Annotated[int, Field(ge=0, le=MAX_SAFE_INTEGER), JSON_INTEGER] = Field(
        default=0, description="Skip this many items of the combined sequence."
    )
    limit: Annotated[int, Field(ge=1, le=MAX_SAFE_INTEGER), JSON_INTEGER] | None = Field(
        default=None, description="At most this many analyses; null = all."
    )


class AnalysisConfig(Config):
    """One item of the list."""

    item: Item = Field(description="The trimmed item.")
    index: Annotated[int, Field(ge=0, le=MAX_SAFE_INTEGER), JSON_INTEGER] = Field(
        description=("0-based position in the combined sequence (inline items, then upload lines), before offset.")
    )


@template_schedule("list")
def schedule(
    ctx: Context, scan_config: ScanConfig | Mapping[str, Any], task_config: object = None
) -> TemplateStream[AnalysisConfig]:
    """Yield one analysis config per list item. `task_config` is accepted and ignored."""
    return TemplateStream(ctx, "list", canonical_scan_config(scan_config, ScanConfig), AnalysisConfig)
