"""Template `cidr`: one analysis per IP address (or per subnet of length `prefix`) of CIDR ranges.

Ranges are normalised, merged and iterated in ascending order, IPv4 before IPv6, minus exclusions; the
expansion must not exceed `maxAnalyses`. Canonical schema: `schemas/templates/cidr.json`.
"""

from collections.abc import Mapping
from typing import Annotated, Any, Literal

from pydantic import AliasChoices, Field

from scantor.context import Context
from scantor.models import Config
from scantor.templates._fields import JSON_INTEGER, JsonStr
from scantor.templates._stream import TemplateStream, canonical_scan_config, template_schedule

Range = Annotated[JsonStr, Field(min_length=2, max_length=49)]
Prefix = Annotated[int, Field(ge=0, le=128), JSON_INTEGER]


class ScanConfig(Config):
    """The ranges to expand. The JSON name of `max_analyses` is `maxAnalyses`."""

    cidrs: list[Range] = Field(
        default=["192.0.2.0/29"],
        min_length=1,
        max_length=1000,
        description="CIDR ranges or single addresses (IPv4 or IPv6). Host bits are cleared.",
    )
    exclude: list[Range] = Field(
        default=[],
        max_length=1000,
        description=(
            "CIDR ranges or addresses never to emit (in subnet mode: subnets that intersect an exclusion are skipped)."
        ),
    )
    prefix: Prefix | None = Field(
        default=None,
        description=(
            "null = one analysis per address; otherwise one analysis per subnet of this length (each cidr "
            "must be at least that large; ≤ 32 when any IPv4 range is present)."
        ),
    )
    max_analyses: Annotated[int, Field(ge=1, le=100000000), JSON_INTEGER] = Field(
        default=65536,
        validation_alias=AliasChoices("maxAnalyses", "max_analyses"),
        serialization_alias="maxAnalyses",
        description="Required safety cap: the scan is rejected when the expansion is larger.",
    )


class AnalysisConfig(Config):
    """One address or subnet."""

    ip: Annotated[JsonStr, Field(min_length=2, max_length=39)] = Field(
        description="Address, or network address of the subnet (RFC 5952 text form for IPv6)."
    )
    prefix: Prefix = Field(description="32/128 for single addresses, otherwise the subnet length.")
    version: Literal[4, 6] = Field(description="IP version.")


@template_schedule("cidr")
def schedule(
    ctx: Context, scan_config: ScanConfig | Mapping[str, Any], task_config: object = None
) -> TemplateStream[AnalysisConfig]:
    """Yield one analysis config per address or subnet. `task_config` is accepted and ignored."""
    return TemplateStream(ctx, "cidr", canonical_scan_config(scan_config, ScanConfig), AnalysisConfig)
