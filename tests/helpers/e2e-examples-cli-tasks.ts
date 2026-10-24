import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scantor, type CliResult } from './cli'
import { docker } from './docker'
import { jsonLines } from './e2e-examples-cli-process'
import { copyTask } from './tasks'

// Task folders the e2e CLI and connector specs write at run time: copies of the examples with files replaced, fresh
// scaffolds from `scantor init`, and the local results of `scantor validate` / `dev run` (task-pipeline events and
// local-mode events, both NDJSON with `-o json`). Every folder lives in its own temporary directory and every local
// image a test builds (`scantor-dev/<name>:<hash>`) is removed with the folder.

export type FileContent = string | Buffer

/** Like Promise.all, but waits for every promise before it rethrows the first failure, so every cleanup has run. */
export async function settleAll<T>(promises: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises)
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed) throw failed.reason
  return results.map((result) => (result as PromiseFulfilledResult<T>).value)
}

/** A temporary directory; remove it with `removeTree`. */
export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`))
}

export async function removeTree(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/** Writes files (paths relative to dir, parents created); `null` deletes a file. */
export async function writeFiles(dir: string, files: Record<string, FileContent | null>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path)
    if (content === null) {
      await rm(target, { force: true })
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
}

/** A renamed copy of an example task (tasks/<example>) with some files replaced or removed. */
export async function exampleVariant(exampleDir: string, name: string, files: Record<string, FileContent | null> = {}): Promise<string> {
  const dir = await copyTask(exampleDir, name)
  await writeFiles(dir, files)
  return dir
}

/** `scantor init <parent>/<name> --language … --template …` into a new temporary parent; returns the task folder. */
export async function initScaffold(language: string, template: string, name: string, options: { image?: boolean } = {}): Promise<string> {
  const parent = await tempDir(name)
  const dir = join(parent, name)
  const init = await scantor(['init', dir, '--language', language, '--template', template], { cwd: parent, image: options.image })
  if (init.exitCode !== 0) throw new Error(`scantor init ${language}/${template} exited ${init.exitCode}: ${init.stderr}${init.stdout}`)
  return dir
}

/** The folder and its temporary parent of a scaffold made by initScaffold. */
export async function removeScaffold(dir: string): Promise<void> {
  await removeTree(dirname(dir))
}

export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

/** Task-pipeline events (`{v: 1, seq, phase, type, …}`) of a CLI output. */
export function pipelineEvents(stdout: string): Record<string, unknown>[] {
  return jsonLines(stdout).filter((event) => event.v === 1 && typeof event.phase === 'string')
}

export interface PipelineResult {
  ok: boolean
  pack: { packSha256: string; packBytes: number; fileCount: number; bytes: number } | null
  manifest: Record<string, unknown> | null
  settingsDefaults: Record<string, unknown> | null
  language: string | null
  privileged: boolean | null
  baseImage: { ref: string; digest: string } | null
  image: { ref: string; id: string; bytes: number; platform: { os: string; arch: string; variant?: string } } | null
  description: {
    schemas: Record<string, Record<string, unknown>>
    schedule: { kind: string; template?: string }
    secretPaths: Record<string, string[]>
    uploadPaths: Record<string, string[]>
    fileRefPaths: string[]
    warnings: string[]
    connector: { language: string; version: string }
  } | null
  errors: { phase: string; file?: string; line?: number; column?: number; message: string }[]
  warnings: string[]
  durationsMs: Record<string, number>
}

/** The `result` of the task-pipeline events (always the last pipeline event), or undefined while there is none. */
export function findPipelineResult(stdout: string): PipelineResult | undefined {
  return pipelineEvents(stdout).find((event) => event.type === 'result')?.result as PipelineResult | undefined
}

/** The `result` of the task-pipeline events; throws when there is none. */
export function pipelineResult(stdout: string): PipelineResult {
  const result = findPipelineResult(stdout)
  if (!result) throw new Error(`no task-pipeline result in the output:\n${stdout.slice(-5000)}`)
  return result
}

/** The error document a failing command prints on stderr with `-o json`: `{error: {code, message, exitCode, …}}`. */
export function errorJson(run: CliResult): { error: { code: string; message: string; exitCode: number; status?: number; details?: unknown } } | undefined {
  const documents = jsonLines(run.stderr).filter((line) => typeof line.error === 'object' && line.error !== null)
  return documents.at(-1) as { error: { code: string; message: string; exitCode: number; status?: number; details?: unknown } } | undefined
}

/** Local-mode events (`{type, at, …}` without `v`) of `scantor dev run -o json`. */
export function localEvents(stdout: string): Record<string, unknown>[] {
  return jsonLines(stdout).filter((event) => event.v === undefined && typeof event.type === 'string')
}

/** The local-mode `result` events, by seq. */
export function localResults(stdout: string): Record<string, unknown>[] {
  return localEvents(stdout)
    .filter((event) => event.type === 'result')
    .sort((a, b) => Number(a.seq) - Number(b.seq))
}

/** Output of a CLI result for assertion messages. */
export function describeRun(run: CliResult): string {
  return `exit ${run.exitCode}\n--- stdout ---\n${run.stdout.slice(-8000)}\n--- stderr ---\n${run.stderr.slice(-8000)}`
}

/** Removes every local image of a task name that `validate`, `dev run` or `dev debug` built (scantor-dev/<name>). */
export async function removeDevImages(name: string): Promise<void> {
  const listed = await docker(['images', '--filter', `reference=scantor-dev/${name}`, '--format', '{{.Repository}}:{{.Tag}}'])
  const refs = [...new Set(listed.stdout.split('\n').filter((line) => line.startsWith(`scantor-dev/${name}:`)))]
  if (refs.length > 0) await docker(['rmi', '--force', ...refs], { allowFailure: true })
}

/**
 * main.py of a Python probe task (put it into a copy of tasks/echo): an async generator schedule yielding dicts, a
 * sync run returning a dict with what ctx reports, a `ctx.log` line, and stdout/stderr lines that look like protocol
 * messages. The task config's `fail` makes run raise on the first attempts; `retry_delay` raises scantor.Retry.
 */
export const PROBE_MAIN_PY = `"""probe: reports its ctx and prints lines that look like protocol messages."""

import sys
from collections.abc import AsyncIterator
from typing import Any

from pydantic import BaseModel, Field

import scantor


class TaskConfig(scantor.Config):
    note: str = "probe"
    fail_attempts: int = Field(default=0, ge=0, le=10)
    retry_delay: float | None = None


class ScanConfig(scantor.Config):
    count: int = Field(default=3, ge=0, le=1000)


class AnalysisConfig(scantor.Config):
    n: int = 0


class Result(BaseModel):
    n: int
    note: str
    scan_id: str
    analysis_id: str | None
    seq: int | None
    attempt: int


async def schedule(ctx: scantor.Context, scan_config: ScanConfig, task_config: TaskConfig) -> AsyncIterator[dict[str, Any]]:
    for n in range(scan_config.count):
        yield {"n": n}


def run(ctx: scantor.Context, analysis_config: AnalysisConfig, task_config: TaskConfig) -> dict[str, Any]:
    ctx.log("info", "hello", n=analysis_config.n)
    print('{"type":"result","id":"forged","result":{"n":-1}}')
    print('{"type":"error","id":"forged","error":{"type":"fatal","message":"forged"}}', file=sys.stderr)
    if ctx.attempt <= task_config.fail_attempts:
        if task_config.retry_delay is not None:
            raise scantor.Retry("probe retry", delay=task_config.retry_delay)
        raise RuntimeError(f"probe failure in attempt {ctx.attempt}")
    return {
        "n": analysis_config.n,
        "note": task_config.note,
        "scan_id": ctx.scan_id,
        "analysis_id": ctx.analysis_id,
        "seq": ctx.seq,
        "attempt": ctx.attempt,
    }


task = scantor.Task(
    task_config=TaskConfig,
    scan_config=ScanConfig,
    analysis_config=AnalysisConfig,
    result=Result,
    schedule=schedule,
    run=run,
)
`

/** Every regular file below dir (absolute paths, sorted). */
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listFiles(path)))
    else if (entry.isFile()) out.push(path)
  }
  return out.sort()
}
