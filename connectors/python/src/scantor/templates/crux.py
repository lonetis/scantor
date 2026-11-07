"""Template `crux`: origins of a Chrome UX Report list up to a rank bucket.

The list comes from zakird/crux-top-lists (the default, up to rank 1M) or lonetis/crux-cache (every
origin CrUX tracks). `latest` is resolved to a concrete month before the first analysis is published.
Canonical schema: `schemas/templates/crux.json`.
"""

from collections.abc import Mapping
from typing import Annotated, Any, Literal

from pydantic import Field

from scantor.context import Context
from scantor.models import Config
from scantor.templates._fields import JsonStr
from scantor.templates._stream import TemplateStream, canonical_scan_config, template_schedule

Bucket = Literal[1000, 5000, 10000, 50000, 100000, 500000, 1000000, 5000000, 10000000, 50000000]
Source = Literal["crux-top-lists", "crux-cache"]


class ScanConfig(Config):
    """Which list and how deep."""

    source: Source = Field(
        default="crux-top-lists",
        description=(
            "Where the list comes from: `crux-top-lists` (zakird/crux-top-lists: rank buckets up to 1000000, "
            "country lists from 202501) or `crux-cache` (lonetis/crux-cache: every origin and bucket, the "
            "countries it publishes)."
        ),
    )
    country: JsonStr = Field(
        default="global",
        pattern=r"^(global|[a-z]{2})$",
        description=(
            "`global` or a lowercase ISO 3166-1 alpha-2 country code (crux-top-lists has country lists from "
            "202501, crux-cache only the countries it publishes)."
        ),
    )
    month: JsonStr = Field(
        default="latest",
        pattern=r"^(latest|[0-9]{4}(0[1-9]|1[0-2]))$",
        description="`latest` or a month YYYYMM.",
    )
    bucket: Bucket = Field(
        default=1000,
        description=(
            "Include origins with rank bucket ≤ this value (the cap of the scan); buckets above 1000000 need "
            "source crux-cache."
        ),
    )


class AnalysisConfig(Config):
    """One origin of the list."""

    origin: Annotated[JsonStr, Field(min_length=1, max_length=2048)] = Field(
        description="Origin as listed (scheme + host, no trailing slash; http and https occur)."
    )
    rank: Bucket = Field(description="CrUX rank bucket of the origin.")


@template_schedule("crux")
def schedule(
    ctx: Context, scan_config: ScanConfig | Mapping[str, Any], task_config: object = None
) -> TemplateStream[AnalysisConfig]:
    """Yield one analysis config per origin, in bucket order. `task_config` is accepted and ignored."""
    return TemplateStream(ctx, "crux", canonical_scan_config(scan_config, ScanConfig), AnalysisConfig)
