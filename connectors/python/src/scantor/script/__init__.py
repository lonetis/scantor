"""scantor scripts: evaluate the results and files of your scans on the master.

A script entry defines a module-level `script = scantor.script.Script(run=...)`; `run(ctx, config)`
reads the selected scans through `ctx` (typed analyses, their files, aggregations), stores outputs and
returns a summary. See docs/guide/scripts.md.
"""

from scantor.script._context import AggregateResult, ScriptContext, Secrets
from scantor.script._definition import CFG, RES, Script
from scantor.script._errors import Cancelled, ScriptError
from scantor.script._map import MapResult
from scantor.script._models import (
    Analysis,
    AnalysisError,
    AnalysisStatus,
    Attempt,
    Output,
    Scan,
    ScanCounts,
    Timings,
)
from scantor.script._outputs import Outputs
from scantor.script._stream import AnalysisStream

__all__ = [
    "CFG",
    "RES",
    "AggregateResult",
    "Analysis",
    "AnalysisError",
    "AnalysisStatus",
    "AnalysisStream",
    "Attempt",
    "Cancelled",
    "MapResult",
    "Output",
    "Outputs",
    "Scan",
    "ScanCounts",
    "Script",
    "ScriptContext",
    "ScriptError",
    "Secrets",
    "Timings",
]
