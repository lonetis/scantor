"""bundle-probe: list items for the bundle-run tests (docs/runtime.md §15.7, tests/e2e/bundles.spec.ts).

The template `list` (unwrapped) yields one analysis per item. `run` prints a line into the analysis log, sleeps
`sleepMs`, fails the first attempt of the item `retryOn` with a retryable error and the item `failOn` with a fatal one,
and stores one text file referenced by the result when `writeFile` is set. The result holds the item, whether the
secret `token` was given and the token itself in a secret (writeOnly) field, which bundle runs must mask.
"""

import asyncio

from pydantic import BaseModel, Field, SecretStr

import scantor
from scantor import templates


class TaskConfig(scantor.Config):
    token: SecretStr | None = Field(default=None, description="A secret (writeOnly): describe drops its default.")
    failOn: str | None = Field(default=None, description="The item whose analysis fails with a fatal error.")
    retryOn: str | None = Field(default=None, description="The item whose first attempt fails with a retryable error.")
    sleepMs: int = Field(default=0, ge=0, le=3_600_000, description="How long each analysis sleeps, in milliseconds.")
    writeFile: bool = Field(default=True, description="Store one text file per analysis.")


class Result(BaseModel):
    item: str
    index: int
    attempt: int
    hasToken: bool
    token: SecretStr | None
    file: scantor.FileRef | None


async def run(ctx: scantor.Context, analysis_config: templates.list.AnalysisConfig, task_config: TaskConfig) -> Result:
    item = analysis_config.item
    print(f"bundle-probe {item} attempt {ctx.attempt}", flush=True)
    await asyncio.sleep(task_config.sleepMs / 1000)  # raises asyncio.CancelledError when the analysis is cancelled
    if item == task_config.retryOn and ctx.attempt == 1:
        raise scantor.Retry(f"retry {item} in attempt {ctx.attempt}")  # after the backoff of the settings
    if item == task_config.failOn:
        raise scantor.Fatal(f"fatal {item}")  # no further attempts
    file = ctx.files.put("probe.txt", f"bundle-probe {item}\n", "text/plain") if task_config.writeFile else None
    return Result(
        item=item,
        index=analysis_config.index,
        attempt=ctx.attempt,
        hasToken=task_config.token is not None,
        token=task_config.token,
        file=file,
    )


task = scantor.Task(task_config=TaskConfig, result=Result, schedule=templates.list.schedule, run=run)
