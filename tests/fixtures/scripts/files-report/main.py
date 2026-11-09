"""files-report: read every file of a scan of the example task `files` and report on them.

Streams the succeeded analyses of the first scan, typed with the task's result model, reads and
verifies every file of each analysis in worker threads, writes one CSV row per analysis and a JSON
summary as outputs, reports progress, checkpoints its position and returns the totals. A restart with
resume continues after the last checkpoint and copies the rows of the previous run first.
"""

import csv
import io
import shutil

from pydantic import BaseModel, Field

import scantor
from models import Result
from scantor.script import Analysis, Script, ScriptContext

CSV_NAME = "files.csv"
HEADER = ["seq", "item", "files", "bytes", "upper"]


class Config(scantor.Config):
    workers: int = Field(default=8, ge=1, le=64, description="Threads that read files in parallel.")


class Row(BaseModel):
    seq: int
    item: str
    files: int
    bytes: int
    upper: str


class Summary(BaseModel):
    scan: str
    analyses: int
    files: int
    bytes: int
    resumed: bool


def inspect(analysis: Analysis[Result]) -> Row:
    """Read every file of one analysis (each checked against its SHA-256); runs in worker threads."""
    result = analysis.result
    if result is None:
        raise ValueError(f"analysis {analysis.id} has no result")
    sizes = [len(analysis.read_bytes(ref)) for ref in analysis.files]
    data = analysis.read_json(result.data)
    return Row(seq=analysis.seq, item=result.item, files=len(sizes), bytes=sum(sizes), upper=data["upper"])


def run(ctx: ScriptContext, config: Config) -> Summary:
    scan = ctx.scans[0]
    state = ctx.resume_state or {"after_seq": None, "analyses": 0, "files": 0, "bytes": 0}
    total = min(ctx.limit, scan.counts.succeeded) if ctx.limit else scan.counts.succeeded
    previous = next((out for out in ctx.resume_outputs if out.name in {CSV_NAME, f"{CSV_NAME}.partial"}), None)

    stream = ctx.analyses(scan, result=Result, status="succeeded", after_seq=state["after_seq"])
    rows = ctx.map(inspect, stream, workers=config.workers, ordered=True)
    with ctx.outputs.open(CSV_NAME) as file:
        if previous is not None:
            shutil.copyfileobj(io.TextIOWrapper(previous.open(), encoding="utf-8", newline=""), file)
        writer = csv.writer(file)
        if previous is None:
            writer.writerow(HEADER)
        for row in rows:
            writer.writerow([row.seq, row.item, row.files, row.bytes, row.upper])
            state["analyses"] += 1
            state["files"] += row.files
            state["bytes"] += row.bytes
            state["after_seq"] = rows.watermark
            ctx.progress(state["analyses"], total, f"{state['files']} files read")
            ctx.checkpoint(state)

    summary = Summary(
        scan=scan.name,
        analyses=state["analyses"],
        files=state["files"],
        bytes=state["bytes"],
        resumed=ctx.resume_state is not None,
    )
    ctx.outputs.put("summary.json", summary.model_dump_json(indent=2), "application/json")
    ctx.log("report written", analyses=summary.analyses, files=summary.files)
    return summary


script = Script(run=run, config=Config, result=Summary)
