"""Conformance fixture echo: a synchronous run (docs/protocol.md §12.2)."""

import sys
import time

from echo_models import AnalysisConfig, Result, TaskConfig, echo_ctx, secret_length

import scantor

print("importing echo")
print("importing echo", file=sys.stderr)


def run(ctx: scantor.Context, analysis_config: AnalysisConfig, task_config: TaskConfig) -> Result | dict[str, object]:
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
        end = time.monotonic() + analysis_config.sleep_ms / 1000
        while time.monotonic() < end:
            if ctx.cancelled:
                raise RuntimeError("stopped because the call was cancelled")
            time.sleep(0.01)
    if mode == "sleepUncooperative":
        time.sleep(analysis_config.sleep_ms / 1000)
    if mode == "exit":
        sys.exit(3)
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
        files.append(ctx.files.put("a.bin", b"abc", "application/octet-stream"))
        files.append(ctx.files.put("b.txt", "hello"))
        path = ctx.tmp_dir / "c.json"
        path.write_text('{"c": true}')
        files.append(ctx.files.put("c.json", path))
        path.write_text("changed after put")
    if mode == "fileError":
        ctx.files.put("bad.bin", b"x")
    return Result(text=text, ctx=echo_ctx(ctx), secretLength=secret_length(task_config), files=files)


task = scantor.Task(task_config=TaskConfig, analysis_config=AnalysisConfig, result=Result, run=run)
