"""A script for the runner tests: typed stream, progress, checkpoint, an output, secrets, a summary."""

from pydantic import BaseModel
from report_models import Result

import scantor
from scantor.script import Script, ScriptContext


class Params(scantor.Config):
    mode: str = "ok"
    min_length: int = 0


class Summary(BaseModel):
    analyses: int
    long_items: list[str]
    secret_length: int
    resumed: bool


def run(ctx: ScriptContext, config: Params) -> Summary | dict[str, object]:
    scan = ctx.scans[0]
    state = ctx.resume_state or {"done": 0}
    long_items: list[str] = []
    stream = ctx.analyses(scan, result=Result, status="succeeded")
    for analysis in stream:
        assert analysis.result is not None
        state["done"] += 1
        if analysis.result.length >= config.min_length:
            long_items.append(analysis.result.item)
        ctx.progress(state["done"], scan.counts.succeeded)
        ctx.checkpoint({**state, "after_seq": stream.watermark})
    ctx.log("streamed", analyses=state["done"])
    ctx.outputs.put("items.txt", "\n".join(long_items) + "\n")
    if config.mode == "raise":
        raise RuntimeError("the script broke on purpose")
    if config.mode == "bad_result":
        return {"analyses": "many"}
    return Summary(
        analyses=state["done"],
        long_items=long_items,
        secret_length=len(ctx.secrets.get("API_KEY", "")),
        resumed=ctx.resume_state is not None,
    )


script = Script(run=run, config=Params, result=Summary)
