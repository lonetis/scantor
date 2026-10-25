"""ctx.files.put rejects a content type outside the `file` message schema before anything is sent."""

from pydantic import BaseModel

import scantor


class Result(BaseModel):
    outcomes: list[str]
    file: scantor.FileRef


def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: scantor.Empty) -> Result:
    outcomes: list[str] = []
    for content_type in ("x" * 256, "", 42):
        try:
            ctx.files.put("t.bin", b"x", content_type)
        except scantor.ScantorError as exc:
            outcomes.append(exc.type)
    return Result(outcomes=outcomes, file=ctx.files.put("t.bin", b"x", "x" * 255))


task = scantor.Task(result=Result, run=run)
