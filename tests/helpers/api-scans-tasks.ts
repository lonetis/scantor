import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { copyTask, exampleTaskDir } from './tasks'

// Task folders of api/scans.spec.ts and e2e/lifecycle.spec.ts (docs/testing.md §7.9). Each helper returns a temporary
// folder; the caller removes it with `removeDir` after uploading it.
//
// `lifecycleTask()` is a small Python task generated for the scan lifecycle tests. One build serves every case that
// needs more than the `sleep` example: a custom schedule (no expected total) that can yield slowly (an unfinished
// scheduler to pause and resume) and can fail with `scantor.Fatal` after its items (a `failed` scan without
// scheduler restarts), runs that end as the task config says (ok, Fatal, Retry with a delay), a secret whose SHA-256
// the result carries, an optional stored file, and an array of upload ids (describe records the upload path
// /lists/*). Its manifest has non-platform defaults for the settings merge tests.

/** The `defaults` block of the lifecycle task's manifest (docs/tasks.md §3.1). */
export const LIFECYCLE_DEFAULTS = {
  timeout: '45s',
  maxAttempts: 4,
  backoff: { initial: '2s' },
  resources: { cpus: 0.5, memory: '200MiB' },
} as const

const LIFECYCLE_MAIN = `"""lifecycle: a test task of the scan lifecycle specs (tests/helpers/api-scans-tasks.ts).

The custom schedule yields \`count\` analyses, waiting \`item_delay\` seconds before each one, and raises
scantor.Fatal after them when \`fail\` is "fatal". Each run sleeps \`seconds\` (cancellable, with progress), then
ends as \`mode\` says.
"""

import asyncio
import hashlib
from collections.abc import AsyncIterator
from typing import Annotated, Literal

from pydantic import BaseModel, Field, SecretStr

import scantor

UploadId = Annotated[str, Field(json_schema_extra={"x-scantor": "upload"})]


class TaskConfig(scantor.Config):
    seconds: float = Field(default=0, ge=0, le=600, description="How long each run sleeps.")
    mode: Literal["ok", "fatal", "retry"] = Field(default="ok", description="How each run ends.")
    retry_delay: float = Field(default=3600, ge=1, le=86400, description="retry: the requested delay in seconds.")
    file: bool = Field(default=False, description="Store a small file and return its FileRef.")
    api_token: SecretStr | None = Field(default=None, description="A secret; the result carries its SHA-256.")
    lists: list[UploadId] = Field(default=[], max_length=64, description="Ids of uploaded lists.")


class ScanConfig(scantor.Config):
    count: int = Field(default=1, ge=0, le=1000000, description="Number of analyses.")
    item_delay: float = Field(default=0, ge=0, le=10, description="Pause before each analysis is yielded.")
    fail: Literal["never", "fatal"] = Field(default="never", description="fatal: raise scantor.Fatal after the items.")


class AnalysisConfig(scantor.Config):
    value: int


class Result(BaseModel):
    value: int
    attempt: int
    api_token_sha256: str | None
    report: scantor.FileRef | None


async def schedule(ctx: scantor.Context, scan_config: ScanConfig, task_config: TaskConfig) -> AsyncIterator[AnalysisConfig]:
    for value in range(scan_config.count):
        if scan_config.item_delay > 0:
            await asyncio.sleep(scan_config.item_delay)
        yield AnalysisConfig(value=value)
    if scan_config.fail == "fatal":
        raise scantor.Fatal("lifecycle: the schedule failed on purpose")


async def run(ctx: scantor.Context, analysis_config: AnalysisConfig, task_config: TaskConfig) -> Result:
    total = task_config.seconds
    remaining = total
    while remaining > 0:
        step = min(0.5, remaining)
        await asyncio.sleep(step)
        remaining -= step
        ctx.progress(1 - remaining / total, f"{total - remaining:g} of {total:g} s")
    if task_config.mode == "fatal":
        raise scantor.Fatal("lifecycle: the run failed on purpose")
    if task_config.mode == "retry":
        raise scantor.Retry("lifecycle: retry on purpose", delay=task_config.retry_delay)
    token = task_config.api_token.get_secret_value() if task_config.api_token else None
    report: scantor.FileRef | None = None
    if task_config.file:
        report = await ctx.files.aput("report.txt", f"lifecycle {analysis_config.value}\\n", "text/plain")
    return Result(
        value=analysis_config.value,
        attempt=ctx.attempt,
        api_token_sha256=hashlib.sha256(token.encode()).hexdigest() if token is not None else None,
        report=report,
    )


task = scantor.Task(
    task_config=TaskConfig,
    scan_config=ScanConfig,
    analysis_config=AnalysisConfig,
    result=Result,
    schedule=schedule,
    run=run,
)
`

/** The generated lifecycle task (a copy of the sleep example's folder with its own entry file and manifest). */
export async function lifecycleTask(): Promise<string> {
  const dir = await copyTask(exampleTaskDir('sleep'), 'lifecycle')
  await writeFile(join(dir, 'main.py'), LIFECYCLE_MAIN)
  const manifest = join(dir, 'scantor.yaml')
  const doc = parseDocument(await readFile(manifest, 'utf8'))
  doc.set('description', 'A generated test task of the scan lifecycle specs.')
  doc.set('defaults', LIFECYCLE_DEFAULTS)
  await writeFile(manifest, doc.toString())
  return dir
}

/** A copy of tasks/<example> whose manifest has the given `defaults` block (docs/tasks.md §3.1). */
export async function exampleWithDefaults(example: string, defaults: Record<string, unknown>): Promise<string> {
  const dir = await copyTask(exampleTaskDir(example), example)
  const manifest = join(dir, 'scantor.yaml')
  const doc = parseDocument(await readFile(manifest, 'utf8'))
  doc.set('defaults', defaults)
  await writeFile(manifest, doc.toString())
  return dir
}

/** A copy of tasks/<example> with a changed entry file, so publishing it creates a new revision. */
export async function exampleWithChangedCode(example: string, entry: string, marker: string): Promise<string> {
  const dir = await copyTask(exampleTaskDir(example), example)
  await appendFile(join(dir, entry), `\n# ${marker}\n`)
  return dir
}
