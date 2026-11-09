"""ctx.map with worker processes: a module-level function reads a file of every analysis."""

import os

from scantor.script import Analysis, Script, ScriptContext


def notes(analysis: Analysis) -> tuple[int, int]:
    return len(analysis.read_text("notes.txt")), os.getpid()


def run_parallel(ctx: ScriptContext, config: object) -> dict[str, int]:
    stream = ctx.analyses(ctx.scans[0], status="succeeded")
    results = ctx.map(notes, stream, processes=2, workers=4)
    rows = list(results)
    return {
        "analyses": len(rows),
        "characters": sum(length for length, _ in rows),
        "processes": len({pid for _, pid in rows}),
        "parent": int(os.getpid() in {pid for _, pid in rows}),
        "watermark": results.watermark or 0,
    }


script = Script(run=run_parallel)
