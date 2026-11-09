import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { parseDocument } from 'yaml'
import type { Analysis } from '#shared/types/analyses'
import type { JobAccepted } from '#shared/types/common'
import type { FileContent } from '#shared/types/exports'
import type { Revision } from '#shared/types/revisions'
import type { Scan } from '#shared/types/scans'
import type {
  DeleteScriptFileResult,
  Script,
  ScriptFileContent,
  ScriptFileList,
  ScriptRun,
  ScriptRunLogLine,
  ScriptRunLogsPage,
  UploadScriptResult,
  WriteScriptFilesResult,
} from '#shared/types/scripts'
import { TERMINAL_SCRIPT_RUN_STATES, type ScriptRunState } from '#shared/utils/enums'
import type { test as fixturesTest } from '../fixtures'
import { ApiClient, ApiError, ok, type ApiResponse } from './api-client'
import { byteSize, tarGz, waitForJob } from './api-tasks-support'
import { docker, stackEnv } from './docker'
import { allAnalyses } from './e2e-runtime'
import { env } from './env'
import { startScanAndWait } from './scans'
import { exampleTaskDir, uploadAndPublish } from './tasks'
import { unique } from './unique'
import { newApiContext } from './users'

// Scripts and script runs in tests (docs/scripts.md, docs/testing.md §7.8): script folders as file maps (fixture
// folders of tests/fixtures/scripts/<name> or the generated `probe` script below) packed into deterministic tar.gz
// uploads with the manifest name rewritten, thin wrappers of the script, file and run operations, waits for runs and
// log lines with diagnostics, the inner Docker's view of run containers and images, and the worker-scoped scan of the
// example task `files` that the end-to-end runs read (`scriptsTest`).

export const SCRIPT_MANIFEST = 'scantor-script.yaml'
const MIB = 1024 * 1024

/** Entries a script pack never contains (local outputs, VCS and Finder data). */
const SKIPPED = new Set(['.git', '.scantor', 'node_modules', '__pycache__', '.venv', '.DS_Store'])

/** A script folder as relative path → content. */
export type ScriptFiles = Record<string, string | Buffer>

export const fixtureScriptDir = (name: string) => join(env.paths.tests, 'fixtures', 'scripts', name)
export const scriptRunContainerName = (scriptRunId: string) => `scantor-s-${scriptRunId}`
export const scriptImageRef = (scriptId: string, packSha256: string) => `scripts/${scriptId}:${packSha256}`

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ── script folders ──────────────────────────────────────────────────────────────────────────────────

/** The files of a script folder on disk, sorted by path. */
export async function readScriptFiles(dir: string): Promise<ScriptFiles> {
  const files: ScriptFiles = {}
  const walk = async (current: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIPPED.has(entry.name)) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files[relative(dir, path).split(sep).join('/')] = await readFile(path)
    }
  }
  await walk(dir)
  return files
}

function manifestOf(files: ScriptFiles): string {
  const manifest = files[SCRIPT_MANIFEST]
  if (manifest === undefined) throw new Error(`the script folder has no ${SCRIPT_MANIFEST}`)
  return manifest.toString()
}

/** The `name` of the folder's scantor-script.yaml. */
export function scriptManifestName(files: ScriptFiles): string {
  const name = parseDocument(manifestOf(files)).get('name')
  if (typeof name !== 'string') throw new Error(`${SCRIPT_MANIFEST} has no name`)
  return name
}

/** A top-level value of the folder's scantor-script.yaml. */
export function scriptManifestValue(files: ScriptFiles, key: string): unknown {
  return parseDocument(manifestOf(files)).toJS()?.[key]
}

/** The manifest with top-level keys replaced (`name`, `defaults`, …); comments and formatting are kept. */
export function editScriptManifest(manifest: string, changes: Record<string, unknown>): string {
  const doc = parseDocument(manifest)
  if (doc.errors.length > 0) throw new Error(`invalid ${SCRIPT_MANIFEST}: ${doc.errors[0]?.message}`)
  for (const [key, value] of Object.entries(changes)) doc.set(key, value)
  return doc.toString()
}

/** The folder with its manifest renamed. */
export function renameScript(files: ScriptFiles, name: string): ScriptFiles {
  return { ...files, [SCRIPT_MANIFEST]: editScriptManifest(manifestOf(files), { name }) }
}

/** A deterministic tar.gz of a script folder (sorted entries, zero mtimes and owners). */
export function scriptArchive(files: ScriptFiles): Promise<Buffer> {
  return tarGz(
    Object.keys(files)
      .sort()
      .map((name) => ({ name, content: files[name]! })),
  )
}

/** The text of a file of a script folder. */
export function scriptFileText(files: ScriptFiles, path: string): string {
  const content = files[path]
  if (content === undefined) throw new Error(`the script folder has no ${path}`)
  return content.toString()
}

const PROBE_MANIFEST = `scantor: 1
name: probe
language: python
description: A test script whose config selects what it does.
defaults:
  resources:
    cpus: 0.5
    memoryMiB: 256
`

/** The Dockerfile of the Python script scaffold. */
export const SCRIPT_DOCKERFILE =
  'ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY . .\n'

const PROBE_MAIN = String.raw`"""probe: a test script whose config selects what it does (generated by tests/helpers/scripts.ts).

ok: reads nothing; secrets: prints every secret (and its own run token) on stdout and stderr and returns their
SHA-256; wait: stores before.txt, writes a line into the open output stream.txt and waits until it is stopped;
fail: raises inside the open output stream.txt; exit: ends the process with code count without reporting;
memory: allocates far beyond its memory; logs: one 20 KiB line, a flood of short lines, then (in a new 10 s
window) 2000 lines of 2 KiB; outputs: stores count outputs. Every mode that returns reports progress, saves a
checkpoint and logs "probe finished".
"""

import hashlib
import os
import sys
import time
from typing import Any, Literal

from pydantic import BaseModel, Field

import scantor
from scantor.script import Script, ScriptContext


class Config(scantor.Config):
    mode: Literal["ok", "secrets", "wait", "fail", "exit", "memory", "logs", "outputs"] = "ok"
    label: str = Field(default="probe", max_length=64)
    count: int = Field(default=1, ge=0, le=1000)


class Summary(BaseModel):
    mode: str
    label: str
    scans: list[str]
    totals: list[int]
    limit: int | None
    secrets: dict[str, str]
    resumed: Any = None
    outputs: list[str]


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def wait_until_cancelled(ctx: ScriptContext) -> None:
    while True:
        ctx.check_cancelled()
        time.sleep(0.2)


def run(ctx: ScriptContext, config: Config) -> Summary:
    secrets: dict[str, str] = {}
    outputs: list[str] = []
    match config.mode:
        case "secrets":
            for name in sorted(ctx.secrets):
                value = ctx.secrets[name]
                print(f"stdout {name}={value}", flush=True)
                print(f"stderr {name}={value}", file=sys.stderr, flush=True)
                secrets[name] = digest(value)
            print("token " + os.environ.get("SCANTOR_SCRIPT_TOKEN", ""), flush=True)
        case "wait":
            ctx.outputs.put("before.txt", f"{config.label} before the wait", "text/plain")
            with ctx.outputs.open("stream.txt") as file:
                print(f"{config.label} first line", file=file)
                ctx.log("probe waiting", label=config.label)
                wait_until_cancelled(ctx)
        case "fail":
            with ctx.outputs.open("stream.txt") as file:
                print(f"{config.label} first line", file=file)
                raise RuntimeError(f"probe failure {config.label}")
        case "exit":
            os._exit(config.count)
        case "memory":
            chunks = [bytearray(16 * 1024 * 1024) for _ in range(512)]
            ctx.log("allocated", chunks=len(chunks))
        case "logs":
            print("L" * 20 * 1024, flush=True)
            for n in range(45_000):
                print(f"flood {n}")
            time.sleep(11)
            for n in range(2_000):
                print(f"bulk {n:04d} " + "b" * 2048)
        case "outputs":
            for n in range(config.count):
                outputs.append(ctx.outputs.put(f"out-{n}.txt", f"output {n}", "text/plain").name)
        case "ok":
            pass
    ctx.progress(1, 1, f"{config.mode} done")
    ctx.checkpoint({"label": config.label})
    ctx.log("probe finished", mode=config.mode, label=config.label)
    return Summary(
        mode=config.mode,
        label=config.label,
        scans=[scan.name for scan in ctx.scans],
        totals=[scan.counts.total for scan in ctx.scans],
        limit=ctx.limit,
        secrets=secrets,
        resumed=ctx.resume_state,
        outputs=outputs,
    )


script = Script(run=run, config=Config, result=Summary)
`

/** The config of the probe script. */
export interface ProbeConfig {
  mode?: 'ok' | 'secrets' | 'wait' | 'fail' | 'exit' | 'memory' | 'logs' | 'outputs'
  label?: string
  count?: number
}

/** The result of the probe script. */
export interface ProbeResult {
  mode: string
  label: string
  scans: string[]
  totals: number[]
  limit: number | null
  secrets: Record<string, string>
  resumed: unknown
  outputs: string[]
}

/** The stdout line the probe logs once it waits (mode `wait`): from then on its container runs and its outputs are open. */
export const probeWaiting = (label: string) => (line: ScriptRunLogLine) => line.stream === 'stdout' && line.text === `probe waiting label="${label}"`

/** The generated probe script (manifest name `probe`); `overrides` replaces files (null removes one). */
export function probeScriptFiles(overrides: Record<string, string | Buffer | null> = {}): ScriptFiles {
  const files: ScriptFiles = {
    '.dockerignore': '__pycache__/\n*.pyc\n.venv/\n',
    Dockerfile: SCRIPT_DOCKERFILE,
    'main.py': PROBE_MAIN,
    'requirements.txt': '# The probe needs nothing beyond the connector.\n',
    [SCRIPT_MANIFEST]: PROBE_MANIFEST,
  }
  for (const [path, content] of Object.entries(overrides)) {
    if (content === null) delete files[path]
    else files[path] = content
  }
  return files
}

// ── instance limits of the test stack ───────────────────────────────────────────────────────────────

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

function durationMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value.trim())
  if (!match) throw new Error(`not a duration: ${JSON.stringify(value)}`)
  return Number(match[1]) * DURATION_UNITS[match[2]!]!
}

function stackValue(name: string): string {
  const value = stackEnv()[name]
  if (value === undefined) throw new Error(`${name} is missing from the test stack's .env`)
  return value
}

/** The script-run limits of the test stack (its generated .env; tests/docker/stack.env sets some of them). */
export function scriptRunLimits() {
  return {
    timeoutMs: durationMs(stackValue('SCANTOR_SCRIPT_RUN_TIMEOUT')),
    maxCpus: Number(stackValue('SCANTOR_SCRIPT_RUN_MAX_CPUS')),
    maxMemoryMiB: Math.floor(byteSize(stackValue('SCANTOR_SCRIPT_RUN_MAX_MEMORY')) / MIB),
    maxOutputs: Number(stackValue('SCANTOR_SCRIPT_RUN_MAX_OUTPUTS')),
    maxLogBytes: byteSize(stackValue('SCANTOR_SCRIPT_RUN_MAX_LOG_BYTES')),
    retentionDays: Number(stackValue('SCANTOR_SCRIPT_RUN_RETENTION_DAYS')),
    maxScanConfigBytes: byteSize(stackValue('SCANTOR_MAX_SCAN_CONFIG_BYTES')),
  }
}

// ── scripts and their files ─────────────────────────────────────────────────────────────────────────

export function createScript(api: ApiClient, body: { name: string; description?: string }) {
  return api.call<Script>('createScript', { body })
}

export function getScript(api: ApiClient, script: string) {
  return api.call<Script>('getScript', { path: { script } })
}

export function uploadScript(api: ApiClient, archive: Buffer, query: { force?: boolean } = {}) {
  return api.call<UploadScriptResult>('uploadScript', { body: archive, headers: { 'Content-Type': 'application/gzip' }, query })
}

/** Uploads a script folder under `name` (the manifest is renamed); 201 expected. */
export async function uploadScriptFiles(api: ApiClient, files: ScriptFiles, name: string, query: { force?: boolean } = {}): Promise<Script> {
  return ok(await uploadScript(api, await scriptArchive(renameScript(files, name)), query), 'uploadScript').script
}

export function listScriptFiles(api: ApiClient, script: string, query: { path?: string; recursive?: boolean } = {}) {
  return api.call<ScriptFileList>('listScriptFiles', { path: { script }, query })
}

export function readScriptFile(api: ApiClient, script: string, path: string) {
  return api.call<ScriptFileContent>('readScriptFile', { path: { script }, query: { path } })
}

export function writeScriptFiles(api: ApiClient, script: string, files: Record<string, string | { base64: string }>) {
  return api.call<WriteScriptFilesResult>('writeScriptFiles', { path: { script }, body: { files } })
}

export function deleteScriptFile(api: ApiClient, script: string, path: string, recursive?: boolean) {
  return api.call<DeleteScriptFileResult>('deleteScriptFile', { path: { script }, query: { path, recursive } })
}

/**
 * Deletes a script and waits until its scriptDelete job succeeded: the job defers itself while it waits for the
 * script's runs to stop, so the wait goes on while the job is queued or running. A script that is gone counts as
 * deleted.
 */
export async function deleteScriptAndWait(api: ApiClient, script: string, timeoutMs = 240_000): Promise<void> {
  const deleted = await api.call<JobAccepted>('deleteScript', { path: { script } })
  if (deleted.status === 404) return
  if (deleted.status !== 202) throw new ApiError(`deleteScript ${script}`, deleted)
  const job = await waitForJob(api, deleted.body.job.id, timeoutMs)
  if (job.state !== 'succeeded') throw new Error(`the scriptDelete job of ${script} ended ${job.state}: ${JSON.stringify(job.error)}`)
}

// ── script runs ─────────────────────────────────────────────────────────────────────────────────────

export interface StartScriptRunBody {
  scans: string[]
  config?: Record<string, unknown>
  secrets?: Record<string, string>
  settings?: { timeoutMs?: number; resources?: { cpus?: number; memoryMiB?: number }; limit?: number }
  confirm?: boolean
}

export interface RestartScriptRunBody {
  resume?: boolean
  config?: Record<string, unknown>
  settings?: { timeoutMs?: number; resources?: { cpus?: number; memoryMiB?: number }; limit?: number | null }
  confirm?: boolean
}

export function startScriptRun(api: ApiClient, script: string, body: StartScriptRunBody | Record<string, unknown>, wait?: number) {
  return api.call<ScriptRun>('startScriptRun', { path: { script }, body, query: { wait } })
}

export function getScriptRun(api: ApiClient, scriptRunId: string, wait?: number) {
  return api.call<ScriptRun>('getScriptRun', { path: { scriptRunId }, query: { wait } })
}

export function cancelScriptRun(api: ApiClient, scriptRunId: string) {
  return api.call<ScriptRun>('cancelScriptRun', { path: { scriptRunId } })
}

export function restartScriptRun(api: ApiClient, scriptRunId: string, body: RestartScriptRunBody = {}, wait?: number) {
  return api.call<ScriptRun>('restartScriptRun', { path: { scriptRunId }, body, query: { wait } })
}

export function getScriptRunLogs(api: ApiClient, scriptRunId: string, query: { afterLine?: number; limit?: number } = {}) {
  return api.call<ScriptRunLogsPage>('getScriptRunLogs', { path: { scriptRunId }, query })
}

/** Starts a run (201 expected) and returns it. */
export async function startRun(api: ApiClient, script: string, body: StartScriptRunBody): Promise<ScriptRun> {
  const response = await startScriptRun(api, script, body)
  if (response.status !== 201) throw new ApiError(`startScriptRun ${script}`, response)
  return response.body
}

/** A run's state, errors, exit code and the end of its log, for failure messages. */
export function describeScriptRun(run: ScriptRun): string {
  const tail = (run.logTail ?? []).slice(-20).map((line) => `${line.stream}: ${line.text.slice(0, 300)}`)
  return JSON.stringify({ state: run.state, errors: run.errors, error: run.error, exitCode: run.exitCode, progress: run.progress, logTail: tail }, null, 1)
}

/**
 * Waits until a run is in one of `states` (default: any terminal state) and returns it; long-polls getScriptRun for
 * terminal states and polls every second for the others. Throws with the run's state, errors and log tail when it
 * settles in another terminal state or the time runs out.
 */
export async function waitForScriptRun(
  api: ApiClient,
  scriptRunId: string,
  states: ScriptRunState | readonly ScriptRunState[] = TERMINAL_SCRIPT_RUN_STATES,
  timeoutMs = 300_000,
): Promise<ScriptRun> {
  const wanted: readonly ScriptRunState[] = typeof states === 'string' ? [states] : states
  const terminal: readonly ScriptRunState[] = TERMINAL_SCRIPT_RUN_STATES
  const polled = wanted.some((state) => !terminal.includes(state))
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000)
    const run = ok(await getScriptRun(api, scriptRunId, polled ? 0 : Math.max(1, Math.min(50, remaining))), 'getScriptRun')
    if (wanted.includes(run.state)) return run
    if (terminal.includes(run.state)) throw new Error(`script run ${scriptRunId} ended ${run.state} instead of ${wanted.join('|')}: ${describeScriptRun(run)}`)
    if (Date.now() >= deadline)
      throw new Error(`script run ${scriptRunId} did not reach ${wanted.join('|')} within ${timeoutMs / 1000} s: ${describeScriptRun(run)}`)
    if (polled) await sleep(1000)
  }
}

/** Starts a run and waits until it settled in `state` (default completed). */
export async function runScript(
  api: ApiClient,
  script: string,
  body: StartScriptRunBody,
  options: { state?: ScriptRunState; timeoutMs?: number } = {},
): Promise<ScriptRun> {
  const run = await startRun(api, script, body)
  return waitForScriptRun(api, run.id, options.state ?? 'completed', options.timeoutMs)
}

/** Every retained line of a run's log, page by page. */
export async function allScriptRunLogs(api: ApiClient, scriptRunId: string, limit = 1000): Promise<ScriptRunLogLine[]> {
  const lines: ScriptRunLogLine[] = []
  let afterLine: number | undefined
  for (;;) {
    const page = ok(await getScriptRunLogs(api, scriptRunId, { afterLine, limit }), 'getScriptRunLogs')
    lines.push(...page.lines)
    if (page.lines.length === 0) return lines
    afterLine = page.nextLine
  }
}

/**
 * Waits until the run's log has a line that `match` accepts and returns it (reading only new lines each round). Fails
 * once the run has been terminal for 15 s without such a line (the job writes its last lines right after the state
 * change), or when the time runs out.
 */
export async function waitForScriptRunLog(
  api: ApiClient,
  scriptRunId: string,
  match: (line: ScriptRunLogLine) => boolean,
  timeoutMs = 240_000,
): Promise<ScriptRunLogLine> {
  const deadline = Date.now() + timeoutMs
  let afterLine = 0
  for (;;) {
    const page = ok(await getScriptRunLogs(api, scriptRunId, { afterLine, limit: 1000 }), 'getScriptRunLogs')
    const found = page.lines.find(match)
    if (found) return found
    afterLine = page.nextLine
    if (page.lines.length > 0) continue
    const run = ok(await getScriptRun(api, scriptRunId), 'getScriptRun')
    const settledLongAgo = run.finishedAt !== null && Date.now() - Date.parse(run.finishedAt) > 15_000
    if (settledLongAgo || Date.now() >= deadline) {
      throw new Error(`the log of script run ${scriptRunId} has no matching line (${run.log.lines} lines): ${describeScriptRun(run)}`)
    }
    await sleep(1000)
  }
}

/** The stored output of a run by name. */
export function outputNamed(run: ScriptRun, name: string): ScriptRun['outputs'][number] {
  const output = run.outputs.find((candidate) => candidate.name === name)
  if (!output) throw new Error(`script run ${run.id} has no output ${name}: ${JSON.stringify(run.outputs.map((o) => o.name))}`)
  return output
}

/** The whole text of a stored output through readScriptRunOutput (paged with nextOffset). */
export async function readOutputText(api: ApiClient, scriptRunId: string, outputId: string): Promise<string> {
  const parts: Buffer[] = []
  let offset = 0
  for (;;) {
    const page = ok(await api.call<FileContent>('readScriptRunOutput', { path: { scriptRunId, outputId }, query: { offset } }), 'readScriptRunOutput')
    parts.push(Buffer.from(page.content, page.encoding === 'base64' ? 'base64' : 'utf8'))
    if (page.nextOffset === null) return Buffer.concat(parts).toString('utf8')
    offset = page.nextOffset
  }
}

// ── the inner Docker's view ─────────────────────────────────────────────────────────────────────────

/** The Docker state (`running`, `exited`, …) of the run's container `scantor-s-<id>`, or null without one. */
export async function scriptRunContainerState(scriptRunId: string): Promise<string | null> {
  const { exitCode, stdout } = await docker(['inspect', '--format', '{{.State.Status}}', scriptRunContainerName(scriptRunId)], { allowFailure: true })
  return exitCode === 0 ? stdout.trim() : null
}

/** Waits until the run's container is removed. */
export async function waitForScriptRunContainerGone(scriptRunId: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = await scriptRunContainerState(scriptRunId)
    if (state === null) return
    if (Date.now() >= deadline) throw new Error(`the container of script run ${scriptRunId} is still ${state} after ${timeoutMs / 1000} s`)
    await sleep(1000)
  }
}

/** Whether the master's Docker engine has the image. */
export async function imageExists(ref: string): Promise<boolean> {
  return (await docker(['image', 'inspect', ref], { allowFailure: true })).exitCode === 0
}

// ── the scan of the example task `files` ────────────────────────────────────────────────────────────

/** The items of the files scan: one analysis each (seq = index), with 7 files (default `copies` 2). */
export const FILES_ITEMS: readonly string[] = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliett', 'kilo', 'lima']

/** One row of the files-report CSV (`seq,item,files,bytes,upper`). */
export interface FilesReportRow {
  seq: number
  item: string
  files: number
  bytes: number
  upper: string
}

export interface FilesScan {
  /** the published revision of the example task `files` */
  revision: Revision
  /** the completed scan of FILES_ITEMS */
  scan: Scan
  /** what files-report computes for each succeeded analysis, in seq order */
  rows: FilesReportRow[]
}

/** The rows files-report writes for the succeeded analyses of a scan of the task `files`. */
export function filesReportRows(analyses: readonly Analysis[]): FilesReportRow[] {
  return analyses
    .filter((analysis) => analysis.status === 'succeeded')
    .sort((a, b) => a.seq - b.seq)
    .map((analysis) => {
      const item = (analysis.result as { item: string }).item
      return {
        seq: analysis.seq,
        item,
        files: analysis.files.length,
        bytes: analysis.files.reduce((sum, file) => sum + file.size, 0),
        upper: item.toUpperCase(),
      }
    })
}

/** The files.csv files-report writes for these rows (CSV with CRLF line ends). */
export function filesReportCsv(rows: readonly FilesReportRow[]): string {
  return ['seq,item,files,bytes,upper', ...rows.map((row) => `${row.seq},${row.item},${row.files},${row.bytes},${row.upper}`)]
    .map((line) => `${line}\r\n`)
    .join('')
}

/** The result files-report returns for these rows. */
export function filesReportResult(scanName: string, rows: readonly FilesReportRow[], resumed: boolean) {
  return {
    scan: scanName,
    analyses: rows.length,
    files: rows.reduce((sum, row) => sum + row.files, 0),
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    resumed,
  }
}

async function createFilesScan(api: ApiClient): Promise<FilesScan> {
  const { revision } = await uploadAndPublish(api, exampleTaskDir('files'), unique('files'))
  const scan = await startScanAndWait(api, { revision: revision.ref, name: unique('files-scan'), scanConfig: { items: [...FILES_ITEMS] } }, 240_000)
  const rows = filesReportRows(await allAnalyses(api, scan.id))
  if (rows.length !== FILES_ITEMS.length) throw new Error(`the files scan ${scan.id} has ${rows.length} succeeded analyses, expected ${FILES_ITEMS.length}`)
  return { revision, scan, rows }
}

function extendWithFilesScan(base: typeof fixturesTest) {
  return base.extend<object, { filesScan: FilesScan }>({
    filesScan: [
      async ({ user, openapi }, use) => {
        const request = await newApiContext({ storageState: user.storageState })
        try {
          await use(await createFilesScan(new ApiClient(request, openapi)))
        } finally {
          await request.dispose()
        }
      },
      { scope: 'worker', timeout: 420_000 },
    ],
  })
}

const extendedTests = new WeakMap<typeof fixturesTest, ReturnType<typeof extendWithFilesScan>>()

/**
 * The fixtures' test with the worker-scoped `filesScan`: the example task `files` published in the worker's tenant and
 * one completed scan of FILES_ITEMS, created on first use (a build and a scan) and read by the runs of every later
 * test of the worker. Both go with the tenant at worker teardown. Every spec gets the same extended test, so spec files
 * share their workers (Playwright starts separate workers for different worker fixtures) and one scan per worker.
 */
export function scriptsTest(base: typeof fixturesTest): ReturnType<typeof extendWithFilesScan> {
  let extended = extendedTests.get(base)
  if (!extended) {
    extended = extendWithFilesScan(base)
    extendedTests.set(base, extended)
  }
  return extended
}

/** The error envelope of a non-2xx response. */
export function apiErrorOf(response: ApiResponse, status: number, code: string): { code: string; message: string; details?: Record<string, unknown> } {
  const error = (response.body as { error?: { code: string; message: string; details?: Record<string, unknown> } }).error
  if (response.status !== status || error?.code !== code) {
    throw new Error(`expected ${status} ${code}, got ${response.status}: ${JSON.stringify(response.body).slice(0, 2000)}`)
  }
  return error
}
