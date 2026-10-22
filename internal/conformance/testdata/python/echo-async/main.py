"""Conformance fixture echo-async: echo with an asynchronous run (docs/protocol.md §12.2)."""

import asyncio
import sys

from echo_models import AnalysisConfig, Result, TaskConfig, echo_ctx, secret_length

import scantor

print("importing echo")
print("importing echo", file=sys.stderr)


async def run(
    ctx: scantor.Context, analysis_config: AnalysisConfig, task_config: TaskConfig
) -> Result | dict[str, object]:
    mode = analysis_config.mode
    files: list[scantor.FileRef] = []
    text = f"{task_config.greeting}, {analysis_config.name}!"
    if mode == "fatal":
        raise scantor.Fatal("fatal requested")
    if mode == "retry":
        raise scantor.Retry("retry requested")
    if mode == "retryAfter":
        raise scantor.Retry("retry requested", 1.5)
    if mode == "throw":
        raise RuntimeError("boom")
    if mode == "invalidResult":
        return {"text": 42, "ctx": echo_ctx(ctx).model_dump(), "secretLength": 0, "files": []}
    if mode == "sleep":
        await asyncio.sleep(analysis_config.sleep_ms / 1000)
    if mode == "oversized":
        text = "x" * analysis_config.size
    if mode == "stdout":
        print('{"type":"result","id":"r0","result":{}}', flush=True)
        print("noise", file=sys.stderr, flush=True)
    if mode == "log":
        ctx.log("info", "hello", n=1)
    if mode == "progress":
        ctx.progress(0.5, "half")
    if mode == "file":
        files.append(await ctx.files.aput("a.bin", b"abc", "application/octet-stream"))
        files.append(await ctx.files.aput("b.txt", "hello"))
        path = ctx.tmp_dir / "c.json"
        path.write_text('{"c": true}')
        files.append(await ctx.files.aput("c.json", path))
        path.write_text("changed after put")
    if mode == "fileError":
        await ctx.files.aput("bad.bin", b"x")
    return Result(text=text, ctx=echo_ctx(ctx), secretLength=secret_length(task_config), files=files)


task = scantor.Task(task_config=TaskConfig, analysis_config=AnalysisConfig, result=Result, run=run)
