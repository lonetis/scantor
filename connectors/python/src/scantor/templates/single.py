"""Template `single`: exactly one analysis with an empty analysis config.

The default when a task defines no schedule. Canonical schema: `schemas/templates/single.json`.
"""

from collections.abc import Mapping
from typing import Any

from scantor.context import Context
from scantor.models import Empty
from scantor.templates._stream import TemplateStream, canonical_scan_config, template_schedule

ScanConfig = Empty
AnalysisConfig = Empty


@template_schedule("single")
def schedule(
    ctx: Context, scan_config: ScanConfig | Mapping[str, Any], task_config: object = None
) -> TemplateStream[AnalysisConfig]:
    """Yield one empty analysis config. `task_config` is accepted and ignored."""
    return TemplateStream(ctx, "single", canonical_scan_config(scan_config, ScanConfig), AnalysisConfig)
