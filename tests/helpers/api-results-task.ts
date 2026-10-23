import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The `resultset` task of the api-results specs (test runs, analyses, exports, files, waits, ingestion): a small
// Python task generated into a temporary folder, so every outcome the result routes need can be chosen per item of
// the scan config without a fixture image of its own. Items are `<kind>:<arg>`:
//
//   ok, anything else   succeeds; `value` = the item
//   raw:<json string>   succeeds; `value` = the decoded string (leading tabs, CRs and formula characters survive,
//                       although the custom schedule never trims items)
//   file:<name>         succeeds with a text file `<name>` (default report.txt) in `report`
//   fatal:<message>     fails at once (`scantor.Fatal`, error type `fatal`)
//   flaky:<n>           fails attempts 1…n (`taskError`, retried), then succeeds
//
// The scan config's `count` appends the items ok-0 … ok-<count-1>, `fail` raises in schedule, `delay_seconds` slows the schedule down (the scan stays running), and
// `upload` is an upload reference (`x-scantor: upload`) that the schedule ignores. The task config's `text` is copied
// into every result and `sleep_seconds` pauses every run.

export const RESULTSET_TASK = 'resultset'

const MANIFEST = `scantor: 1
name: ${RESULTSET_TASK}
language: python
description: "Test task of the api-results specs: per-item outcomes, files, a slow or failing schedule."
defaults:
  timeout: 4m
  resources:
    cpus: 0.25
    memory: 256MiB
`

const DOCKERFILE = `ARG SCANTOR_BASE
FROM \${SCANTOR_BASE}
COPY . .
`

const DOCKERIGNORE = `__pycache__/
.scantor/
`

const MAIN = `"""resultset: per-item outcomes for the api-results specs (tests/helpers/api-results-task.ts)."""

import json
import time
from collections.abc import Iterator

from pydantic import BaseModel, Field

import scantor


class ScanConfig(scantor.Config):
    items: list[str] = Field(default=["a", "b", "c"], max_length=10000, description="One analysis per item.")
    fail: bool = Field(default=False, description="Raise scantor.Fatal in schedule before the first item.")
    count: int = Field(default=0, ge=0, le=100000, description="Further items ok-0 … ok-<count-1> after items.")
    delay_seconds: float = Field(default=0, ge=0, le=60, description="Pause before each item.")
    upload: str | None = Field(default=None, json_schema_extra={"x-scantor": "upload"}, description="An upload id.")


class AnalysisConfig(scantor.Config):
    item: str
    index: int


class TaskConfig(scantor.Config):
    text: str = Field(default="hello", max_length=200, description="Copied into every result.")
    sleep_seconds: float = Field(default=0, ge=0, le=3600, description="Pause in every run.")


class Nested(BaseModel):
    upper: str
    index: int


class Result(BaseModel):
    item: str
    index: int
    value: str
    text: str
    nested: Nested
    report: scantor.FileRef | None


def schedule(ctx: scantor.Context, scan_config: ScanConfig, task_config: TaskConfig) -> Iterator[AnalysisConfig]:
    if scan_config.fail:
        raise scantor.Fatal("schedule failed on purpose")
    items = [*scan_config.items, *(f"ok-{n}" for n in range(scan_config.count))]
    for index, item in enumerate(items):
        if scan_config.delay_seconds > 0:
            time.sleep(scan_config.delay_seconds)
        yield AnalysisConfig(item=item, index=index)


def run(ctx: scantor.Context, analysis_config: AnalysisConfig, task_config: TaskConfig) -> Result:
    item = analysis_config.item
    kind, _, arg = item.partition(":")
    print(f"stdout {item}")
    ctx.log("info", "running", item=item)
    if task_config.sleep_seconds > 0:
        time.sleep(task_config.sleep_seconds)
    if kind == "fatal":
        raise scantor.Fatal(arg or "fatal on purpose")
    if kind == "flaky" and ctx.attempt <= int(arg):
        raise RuntimeError(f"failure in attempt {ctx.attempt}")
    value = item
    if kind == "raw":
        value = str(json.loads(arg))
    report: scantor.FileRef | None = None
    if kind == "file":
        report = ctx.files.put(arg or "report.txt", f"report of {item}\\n", "text/plain")
    nested = Nested(upper=item.upper(), index=analysis_config.index)
    return Result(item=item, index=analysis_config.index, value=value, text=task_config.text, nested=nested, report=report)


task = scantor.Task(
    task_config=TaskConfig,
    scan_config=ScanConfig,
    analysis_config=AnalysisConfig,
    result=Result,
    schedule=schedule,
    run=run,
)
`

export interface ResultsetOptions {
  /** an extra build step that sleeps this long after `COPY . .`, so the build cache never skips it */
  buildSeconds?: number
  /** a comment appended to main.py, so the same task name gets new content */
  marker?: string
}

/** Writes the resultset task into a new temporary folder; remove it with `removeResultsetTask`. */
export async function writeResultsetTask(options: ResultsetOptions = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${RESULTSET_TASK}-`))
  const dockerfile = options.buildSeconds ? `${DOCKERFILE}RUN sleep ${options.buildSeconds}\n` : DOCKERFILE
  await writeFile(join(dir, 'scantor.yaml'), MANIFEST)
  await writeFile(join(dir, 'Dockerfile'), dockerfile)
  await writeFile(join(dir, '.dockerignore'), DOCKERIGNORE)
  await writeFile(join(dir, 'main.py'), options.marker ? `${MAIN}\n# ${options.marker}\n` : MAIN)
  return dir
}

export async function removeResultsetTask(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/** The JSON form of a `raw:` item whose decoded value is `value`. */
export const rawItem = (value: string) => `raw:${JSON.stringify(value)}`
