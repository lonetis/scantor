"""Runs until SIGTERM: writes an output row per analysis and checkpoints."""

import time

from scantor.script import Script, ScriptContext


def run(ctx: ScriptContext, config: object) -> None:
    done = 0
    with ctx.outputs.open("rows.txt") as file:
        while True:
            for analysis in ctx.analyses(ctx.scans[0]):
                file.write(f"{analysis.seq}\n")
                file.flush()
                done += 1
                ctx.checkpoint({"done": done})
                time.sleep(0.02)


script = Script(run=run)
