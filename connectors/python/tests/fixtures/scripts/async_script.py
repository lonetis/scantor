"""An async run that returns a plain JSON value (no result model)."""

import asyncio

from scantor.script import Script, ScriptContext


async def run(ctx: ScriptContext, config: object) -> dict[str, object]:
    await asyncio.sleep(0.01)
    return {"scans": [scan.name for scan in ctx.scans], "cpus": ctx.cpus}


script = Script(run=run)
