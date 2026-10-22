"""Template `tranco`: domains of a Tranco research top list (https://tranco-list.eu) with their rank.

`latest` and dates are resolved to a concrete, immutable list id before the first analysis is
published. Canonical schema: `schemas/templates/tranco.json`.
"""

from collections.abc import Mapping
from typing import Annotated, Any

from pydantic import Field

from scantor.context import Context
from scantor.models import Config
from scantor.templates._fields import JSON_INTEGER, JsonBool, JsonStr
from scantor.templates._stream import TemplateStream, canonical_scan_config, template_schedule


class ScanConfig(Config):
    """Which list and which window of it."""

    list: JsonStr = Field(
        default="latest",
        pattern=r"^(latest|[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9A-Z]{4,6})$",
        description="`latest`, a date YYYY-MM-DD (the daily list of that date) or a Tranco list id.",
    )
    subdomains: JsonBool = Field(
        default=False,
        description="Use the daily list that includes subdomains (only for `latest` and dates).",
    )
    offset: Annotated[int, Field(ge=0, le=999999), JSON_INTEGER] = Field(
        default=0, description="Skip this many top entries (offset + limit ≤ 1000000)."
    )
    limit: Annotated[int, Field(ge=1, le=1000000), JSON_INTEGER] = Field(default=1000, description="Number of domains.")


class AnalysisConfig(Config):
    """One domain of the list."""

    domain: Annotated[JsonStr, Field(min_length=1, max_length=253)] = Field(
        description="Registrable domain as listed (no scheme, no www.)."
    )
    rank: Annotated[int, Field(ge=1, le=1000000), JSON_INTEGER] = Field(description="1-based Tranco rank.")


@template_schedule("tranco")
def schedule(
    ctx: Context, scan_config: ScanConfig | Mapping[str, Any], task_config: object = None
) -> TemplateStream[AnalysisConfig]:
    """Yield one analysis config per domain, in rank order. `task_config` is accepted and ignored."""
    return TemplateStream(ctx, "tranco", canonical_scan_config(scan_config, ScanConfig), AnalysisConfig)
