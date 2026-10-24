import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { request as playwrightRequest, type APIRequestContext } from '@playwright/test'
import type { Job } from '#shared/types/jobs'
import type { Revision } from '#shared/types/revisions'
import type { Scan } from '#shared/types/scans'
import type { TestRun } from '#shared/types/test-runs'
import type { UploadedTask } from './tasks'
import { ApiClient, ApiError, ok, type ApiResponse, type CallOptions } from './api-client'
import { rawItem, removeResultsetTask, writeResultsetTask } from './api-results-task'
import { docker, innerDocker, stackEnv } from './docker'
import { childEnv, env } from './env'
import type { OpenApiIndex } from './openapi'
import { SMALL_SETTINGS, startScan, TERMINAL_STATES, type StartScanBody } from './scans'
import { packTask } from './tasks'
import { unique } from './unique'
import { newApiContext } from './users'

// Shared helpers of the api-results specs (test runs, uploads, analyses, exports, files, jobs, waits, metrics and
// cross-scan ingestion): the resultset task (helpers/api-results-task.ts) uploaded and published, scans that stay
// running without any worker, a worker-lifetime results scan for read-only specs, the SSE, CSV and Prometheus
// parsers, presigned downloads and read-only calls of the RabbitMQ management API.

/** Settings whose node selector matches no node: the scan becomes `running` (queue and RabbitMQ user exist) but no
 * worker is ever placed (condition workersPending/selectorMismatch), so it stays unsettled at no cost. */
export const UNPLACEABLE_SETTINGS = {
  workers: 1,
  processes: 1,
  resources: { cpus: 0.25, memoryMiB: 256 },
  nodeSelector: { pool: 'api-results-nowhere' },
} as const

/** Fast retries for analyses that fail on purpose (backoff.initialMs has a lower bound of 1 s). */
export const FAST_RETRIES = { backoff: { initialMs: 1000, factor: 1, maxMs: 1000, jitter: false } } as const

interface TasksLike {
  track(task: string): void
}

/**
 * ApiClient.call with its own request timeout: the request contexts keep Playwright's default of 30 s, which a
 * `wait` above about 25 s can exceed. Resolves the operation and validates 2xx JSON bodies like ApiClient.call.
 */
export async function callLong<T = unknown>(api: ApiClient, operationId: string, options: CallOptions, timeoutMs: number): Promise<ApiResponse<T>> {
  const op = api.openapi.get(operationId)
  const url = op.path.replace(/\{([^}]+)\}/g, (_, name: string) => encodeURIComponent(String(options.path?.[name])))
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) params[key] = String(value)
  const response = await api.request.fetch(url, {
    method: op.method.toUpperCase(),
    params,
    headers: options.body === undefined ? options.headers : { 'Content-Type': 'application/json', ...options.headers },
    data: options.body === undefined ? undefined : JSON.stringify(options.body),
    maxRedirects: 0,
    timeout: timeoutMs,
  })
  const raw = await response.body()
  const headers = response.headers()
  const isJson = (headers['content-type'] ?? '').includes('json') && raw.length > 0
  const body = (isJson ? JSON.parse(raw.toString('utf8')) : {}) as T
  if (isJson && response.status() >= 200 && response.status() < 300) {
    const problems = api.openapi.validateResponse(operationId, response.status(), body)
    if (problems.length > 0) throw new Error(`${operationId} ${response.status()}: the body does not match the documented schema:\n  ${problems.join('\n  ')}`)
  }
  return { status: response.status(), headers, body, raw }
}

/** Uploads and publishes a task folder under `name` and waits (20 s long-polls) until its revision is ready. */
export async function publishTask(api: ApiClient, dir: string, name: string, timeoutMs = 170_000): Promise<UploadedTask> {
  const uploaded = ok(await api.uploadTask(await packTask(dir, { name }), { publish: true, wait: 20 }), 'uploadTask')
  if (!uploaded.revision) throw new Error(`uploadTask of ${name} published no revision`)
  const revision = await settledRevision(api, uploaded.task.id, uploaded.revision.id, timeoutMs)
  if (revision.state !== 'ready') throw new Error(`revision ${revision.ref} failed: ${JSON.stringify(revision.errors)}`)
  return { task: uploaded.task, revision }
}

/** Long-polls getRevision (20 s per request) until the revision is ready or failed. */
export async function settledRevision(api: ApiClient, task: string, revisionId: string, timeoutMs = 170_000): Promise<Revision> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const revision = ok(await api.getRevision(task, revisionId, 20), 'getRevision')
    if (revision.state === 'ready' || revision.state === 'failed') return revision
    if (Date.now() >= deadline) throw new Error(`revision ${revision.ref} is still ${revision.state} after ${timeoutMs / 1000} s`)
  }
}

/** Uploads the resultset task as a workspace only (no revision, nothing published); tracked for deletion. */
export async function uploadResultsetWorkspace(api: ApiClient, tasks: TasksLike, name = unique('resultset')): Promise<UploadedTask['task']> {
  const dir = await writeResultsetTask()
  try {
    tasks.track(name)
    const uploaded = ok(await api.uploadTask(await packTask(dir, { name }), { publish: false }), 'uploadTask')
    if (uploaded.revision) throw new Error(`uploadTask with publish=false published ${uploaded.revision.ref}`)
    return uploaded.task
  } finally {
    await removeResultsetTask(dir)
  }
}

/** Long-polls getScan (20 s per request, below the request context's 30 s timeout) until the scan is in `states`. */
export async function settleScan(
  api: ApiClient,
  scanId: string,
  states: Scan['state'] | readonly Scan['state'][] = 'completed',
  timeoutMs = 180_000,
): Promise<Scan> {
  const wanted: readonly Scan['state'][] = typeof states === 'string' ? [states] : states
  const deadline = Date.now() + timeoutMs
  for (;;) {
    // getScan settles on every state but creating and running, so those are polled.
    const polled = wanted.includes('creating') || wanted.includes('running')
    const scan = ok(await api.getScan(scanId, polled ? 0 : 20), 'getScan')
    if (wanted.includes(scan.state)) return scan
    if (['completed', 'failed', 'cancelled', 'deleted'].includes(scan.state) || Date.now() >= deadline) {
      throw new Error(
        `scan ${scanId} is ${scan.state}, expected ${wanted.join('|')}: ${JSON.stringify({ stateReason: scan.stateReason, conditions: scan.conditions, scheduling: scan.scheduling, progress: scan.progress, workers: scan.workers })}`,
      )
    }
    if (polled) await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/** Long-polls getJob (20 s per request) until the job succeeded, failed or was cancelled. */
export async function settledJob(api: ApiClient, jobId: string, timeoutMs = 120_000): Promise<Job> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = ok(await api.call<Job>('getJob', { path: { jobId }, query: { wait: 20 } }), 'getJob')
    if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return job
    if (Date.now() >= deadline) throw new Error(`job ${jobId} (${job.kind}) is still ${job.state} after ${timeoutMs / 1000} s`)
  }
}

/**
 * A published resultset task of a worker's tenant that lives as long as the worker (the `resultsetTask` fixture of
 * helpers/api-results-fixtures.ts), so its image is built once per worker. close() cancels the scans started through
 * `start` that are still active. The task and its scans are deleted with the tenant at worker teardown
 * (docs/testing.md §7.7): the userPurge job deletes all scans of a user with one settle delay, while one scanDelete job
 * per scan waits at least 12 s and the whole stack runs two of them at a time.
 */
export interface SharedTask {
  api: ApiClient
  taskName: string
  revision: Revision
  /** starts a scan of the revision (small settings unless the body sets them); cancelled by close() */
  start(body: Omit<StartScanBody, 'revision'>): Promise<Scan>
  close(): Promise<void>
}

export async function openSharedTask(tenant: { storageState: string }, openapi: OpenApiIndex): Promise<SharedTask> {
  const request = await newApiContext({ storageState: tenant.storageState })
  const api = new ApiClient(request, openapi)
  const taskName = unique('resultset')
  const scans: string[] = []
  const close = async () => {
    try {
      await cancelActiveScans(api, scans)
    } finally {
      await request.dispose()
    }
  }
  try {
    const dir = await writeResultsetTask()
    let uploaded: UploadedTask
    try {
      uploaded = await publishTask(api, dir, taskName)
    } finally {
      await removeResultsetTask(dir)
    }
    const start = async (body: Omit<StartScanBody, 'revision'>) => {
      const scan = await startScan(api, { ...body, revision: uploaded.revision.ref })
      scans.push(scan.id)
      return scan
    }
    return { api, taskName, revision: uploaded.revision, start, close }
  } catch (error) {
    await close()
    throw error
  }
}

/**
 * White-box: applies the final step of a scan's scanDelete job (the tombstone update of
 * orchestrator/server/services/scans/delete.ts `tombstoneUpdate`) to a `deleting` scan, so a test reaches `deleted`
 * without waiting behind the stack's scanDelete queue (two jobs at a time, each at least 12 s). The queued job then
 * finds the scan deleted and ends; the scan's leftovers (analyses, files, events) go with the tenant's purge.
 */
export async function finishScanDeletion(scanId: string): Promise<void> {
  const tombstoneDays = Number(stackEnv().SCANTOR_TOMBSTONE_DAYS ?? 7)
  const out = await innerDocker.mongosh(
    `const now = new Date();
     print(db.scans.updateOne({ _id: ${JSON.stringify(scanId)}, state: 'deleting' }, { $set: {
       state: 'deleted', deletedAt: now, updatedAt: now, purgeAfter: new Date(now.getTime() + ${tombstoneDays} * 86400000),
       taskConfig: {}, scanConfig: {}, secrets: { taskConfig: {}, scanConfig: {} }, uploadIds: [], conditions: [],
       'scheduling.resolved': {} } }).modifiedCount);
     print(db.scans.findOne({ _id: ${JSON.stringify(scanId)} }, { state: 1 })?.state)`,
    { as: 'root' },
  )
  // The job itself may have finished first when its queue was empty.
  const state = out.split('\n').at(-1)
  if (state !== 'deleted') throw new Error(`scan ${scanId} is ${state}, not deleted, after the tombstone update`)
}

/** Cancels the scans that are still active (without waiting); deleting, deleted and missing scans are skipped. */
export async function cancelActiveScans(api: ApiClient, scanIds: readonly string[]): Promise<void> {
  for (const scanId of scanIds) {
    const current = await api.getScan(scanId)
    if (current.status === 404) continue
    const scan = ok(current, 'getScan')
    if (TERMINAL_STATES.includes(scan.state) || scan.state === 'deleting' || scan.state === 'deleted') continue
    const cancelled = await api.cancelScan(scanId)
    if (cancelled.status !== 200 && cancelled.status !== 409) throw new ApiError(`cancelScan ${scanId}`, cancelled)
  }
}

// ── downloads ─────────────────────────────────────────────────────────────────────────────────────────

export interface Download {
  status: number
  headers: Record<string, string>
  body: Buffer
}

/** GETs a presigned URL without credentials or Origin (the test CA is trusted through NODE_EXTRA_CA_CERTS). */
export async function download(url: string): Promise<Download> {
  const context: APIRequestContext = await playwrightRequest.newContext()
  try {
    const response = await context.get(url, { maxRedirects: 0 })
    return { status: response.status(), headers: response.headers(), body: await response.body() }
  } finally {
    await context.dispose()
  }
}

export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

// ── server-sent events ────────────────────────────────────────────────────────────────────────────────

export interface ServerSentEvent {
  event: string
  data: unknown
}

/** Parses a complete `text/event-stream` body; comment lines (heartbeats) are skipped. */
export function parseEventStream(text: string): ServerSentEvent[] {
  const events: ServerSentEvent[] = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (data.length > 0) events.push({ event, data: JSON.parse(data.join('\n')) as unknown })
  }
  return events
}

/** Reads a test run's event stream until the server ends it. */
export async function readTestRunStream(api: ApiClient, testRunId: string, timeoutMs = 180_000): Promise<{ contentType: string; events: ServerSentEvent[] }> {
  const response = await api.request.get(`/api/test-runs/${testRunId}/stream`, { timeout: timeoutMs })
  if (response.status() !== 200) throw new Error(`streamTestRun answered ${response.status()}: ${await response.text()}`)
  return { contentType: response.headers()['content-type'] ?? '', events: parseEventStream(await response.text()) }
}

/** Waits (20 s long-polls) until a test run is completed, failed or cancelled. */
export async function settledTestRun(api: ApiClient, testRunId: string, timeoutMs = 180_000): Promise<TestRun> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const run = ok(await api.call<TestRun>('getTestRun', { path: { testRunId }, query: { wait: 20 } }), 'getTestRun')
    if (['completed', 'failed', 'cancelled'].includes(run.state)) return run
    if (Date.now() >= deadline) throw new Error(`test run ${testRunId} is still ${run.state} after ${timeoutMs / 1000} s`)
  }
}

/** Ids of the containers named `scantor-t-<testRunId>` (running or not). */
export async function testRunContainers(testRunId: string): Promise<string[]> {
  const { stdout } = await docker(['ps', '-aq', '--filter', `name=^scantor-t-${testRunId}$`])
  return stdout.split('\n').filter(Boolean)
}

/** The Docker state (`created`, `running`, `exited`, …) of `scantor-t-<testRunId>`, or null without such a container. */
export async function testRunContainerState(testRunId: string): Promise<string | null> {
  const { exitCode, stdout } = await docker(['inspect', '--format', '{{.State.Status}}', `scantor-t-${testRunId}`], { allowFailure: true })
  return exitCode === 0 ? stdout.trim() : null
}

export interface ContainerCreation {
  /** resolves with the container id once Docker reports the `create` event of the container */
  created: Promise<string>
  /** stops watching (also after the event) */
  stop(): void
}

/**
 * Watches the inner Docker's event stream for the creation of the container named `name`, so a test can act in the
 * gap between a container's creation and its start. The stream starts with the call; `created` rejects when the
 * watch ends (stop, `timeoutMs` or a failing `docker events`) without the event.
 */
export function watchContainerCreation(name: string, timeoutMs: number): ContainerCreation {
  const child = spawn(
    'docker',
    [
      'events',
      '--filter',
      'type=container',
      '--filter',
      'event=create',
      '--filter',
      `container=${name}`,
      '--format',
      '{{.Actor.ID}} {{.Actor.Attributes.name}}',
    ],
    { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const timer = setTimeout(() => child.kill(), timeoutMs)
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
  const created = new Promise<string>((resolve, reject) => {
    let buffered = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      for (const line of buffered.split('\n').slice(0, -1)) {
        const [id, containerName] = line.trim().split(' ')
        if (id && containerName === name) {
          resolve(id)
          child.kill()
        }
      }
      buffered = buffered.slice(buffered.lastIndexOf('\n') + 1)
    })
    child.once('error', (error) => reject(error))
    child.once('close', (code) => reject(new Error(`docker events for ${name} ended (${code}) without its create event: ${stderr.trim()}`)))
  })
  created.catch(() => undefined).finally(() => clearTimeout(timer))
  return { created, stop: () => child.kill() }
}

/**
 * Waits until a sleeping run is `running` and its analysis has started inside the `scantor-t-<id>` container (the
 * run's `stdout <item>` line is in the container's output). A cancellation that arrives while the container is being
 * started is lost (the job attaches its abort listener only after the start), so tests cancel only afterwards.
 */
export async function waitUntilAnalysisRuns(api: ApiClient, testRunId: string, item: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const run = ok(await api.call<TestRun>('getTestRun', { path: { testRunId }, query: { analyses: false } }), 'getTestRun')
    if (run.state !== 'queued' && run.state !== 'building' && run.state !== 'running')
      throw new Error(`test run ${testRunId} is ${run.state}, expected running`)
    if (run.state === 'running' && (await testRunContainers(testRunId)).length === 1) {
      // The container can be gone between the two calls; the next round decides then.
      const output = await innerDocker.logs(`scantor-t-${testRunId}`).catch((error: unknown) => String(error))
      if (output.includes(`stdout ${item}`)) return
    }
    if (Date.now() >= deadline) throw new Error(`the analysis ${item} of test run ${testRunId} did not start within ${timeoutMs / 1000} s (state ${run.state})`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/** The `testRun` job of a test run (testTask creates it before it answers); the newest jobs of the user come first. */
export async function testRunJob(api: ApiClient, testRunId: string): Promise<Job> {
  const page = ok(await api.call<{ items: Job[] }>('listJobs', { query: { kind: 'testRun', limit: 200 } }), 'listJobs')
  const job = page.items.find((candidate) => candidate.subject.kind === 'testRun' && candidate.subject.id === testRunId)
  if (!job) throw new Error(`no testRun job lists test run ${testRunId}`)
  return job
}

// ── CSV ───────────────────────────────────────────────────────────────────────────────────────────────

/** Parses RFC 4180 CSV with CRLF row ends; returns the rows as arrays of unescaped cells. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
    } else if (char === '"' && cell === '') {
      quoted = true
    } else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\r' && text[i + 1] === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i++
    } else {
      cell += char
    }
  }
  if (cell !== '' || row.length > 0) throw new Error('the CSV does not end with CRLF')
  return rows
}

// ── Prometheus text ───────────────────────────────────────────────────────────────────────────────────

export interface MetricSample {
  name: string
  labels: Record<string, string>
  value: number
}

/** The samples of a Prometheus text exposition (version 0.0.4). */
export function parseMetrics(text: string): MetricSample[] {
  const samples: MetricSample[] = []
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line)
    if (!match) throw new Error(`not a Prometheus sample: ${line}`)
    const labels: Record<string, string> = {}
    for (const pair of (match[2] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[pair[1]!] = pair[2]!.replace(/\\(.)/g, '$1')
    samples.push({ name: match[1]!, labels, value: Number(match[3]) })
  }
  return samples
}

/** The sum of the samples of `name` whose labels include `labels`. */
export function metricValue(samples: readonly MetricSample[], name: string, labels: Record<string, string> = {}): number {
  return samples
    .filter((sample) => sample.name === name && Object.entries(labels).every(([key, value]) => sample.labels[key] === value))
    .reduce((sum, sample) => sum + sample.value, 0)
}

/** Scrapes /api/metrics as the admin. */
export async function scrapeMetrics(adminApi: ApiClient): Promise<MetricSample[]> {
  const response = await adminApi.call('getMetrics')
  if (response.status !== 200) throw new Error(`getMetrics answered ${response.status}`)
  return parseMetrics(response.raw.toString('utf8'))
}

// ── RabbitMQ management API (read-only) ───────────────────────────────────────────────────────────────

/** The management API of the stack's RabbitMQ, published on the runner's loopback (SCANTOR_ADMIN_BIND_ADDRESS). */
export function rabbitManagementUrl(path: string): string {
  const port = stackEnv().SCANTOR_RABBITMQ_MANAGEMENT_PORT ?? '15672'
  return `http://127.0.0.1:${port}/api${path}`
}

/** A GET of the management API as `user` (default: the stack's RabbitMQ admin). */
export async function rabbitManagementGet<T = unknown>(path: string, credentials?: { user: string; password: string }): Promise<{ status: number; body: T }> {
  const stack = stackEnv()
  const { user, password } = credentials ?? { user: stack.SCANTOR_RABBITMQ_USER!, password: stack.SCANTOR_RABBITMQ_PASSWORD! }
  const response = await fetch(rabbitManagementUrl(path), {
    headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` },
  })
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // not JSON (for example an HTML or plain-text error page): keep the text
  }
  return { status: response.status, body: body as T }
}

// ── streamed uploads ──────────────────────────────────────────────────────────────────────────────────

/**
 * POSTs `totalBytes` of `a` to /api/uploads with `Transfer-Encoding: chunked` (no Content-Length, so only the
 * streaming cap of the route can reject it) as the bearer of `apiKey`. Resolves with the response, or with the
 * transport error when the connection breaks before one arrives.
 */
export function streamUpload(apiKey: string, totalBytes: number, name: string): Promise<{ status: number; body: string } | { error: string }> {
  return new Promise((resolve) => {
    const url = new URL(`${env.publicUrl}/api/uploads`)
    url.searchParams.set('name', name)
    const request = httpsRequest(
      url,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'text/plain', 'Transfer-Encoding': 'chunked' },
        ca: readFileSync(env.caCertFile),
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
        response.on('error', (error) => resolve({ error: String(error) }))
      },
    )
    request.setTimeout(120_000, () => request.destroy(new Error('no response within 120 s')))
    request.on('error', (error) => resolve({ error: String(error) }))
    const chunk = Buffer.alloc(1024 * 1024, 0x61)
    let sent = 0
    const write = () => {
      while (sent < totalBytes) {
        const size = Math.min(chunk.length, totalBytes - sent)
        sent += size
        if (!request.write(size === chunk.length ? chunk : chunk.subarray(0, size))) {
          request.once('drain', write)
          return
        }
      }
      request.end()
    }
    write()
  })
}

// ── the results scan ──────────────────────────────────────────────────────────────────────────────────

/**
 * The items of the results scan the analyses, exports and files specs read (one analysis per item, seq = index):
 * a file, values that start with spreadsheet formula characters or need CSV quoting, two fatal failures, an item
 * that fails 11 times before it succeeds (run it with RESULTS_SCAN_SETTINGS) and plain successes up to seq 59.
 */
export const RESULT_ITEMS: readonly string[] = [
  'file:report.txt',
  rawItem('=1+1'),
  rawItem('+1'),
  rawItem('-1'),
  rawItem('@SUM(A1)'),
  rawItem('\tx'),
  rawItem('\rx'),
  rawItem('a,b "q"\nline'),
  'fatal:boom',
  'fatal:bang',
  'flaky:11',
  ...Array.from({ length: 49 }, (_, n) => `ok-${n}`),
]

/** Seqs of RESULT_ITEMS by role. */
export const RESULT_SEQS = { file: 0, formulas: [1, 2, 3, 4, 5, 6], quoted: 7, failed: [8, 9], flaky: 10, total: 60 } as const

/** Two processes; 12 attempts with 1 s backoff, so the flaky item succeeds in its last attempt. */
export const RESULTS_SCAN_SETTINGS = { ...SMALL_SETTINGS, processes: 2, maxAttempts: 12, ...FAST_RETRIES } as const

// ── long-running requests ─────────────────────────────────────────────────────────────────────────────

/**
 * A pipeline that needs no data beyond one analysis but makes MongoDB iterate `outer × inner` documents (two nested
 * $range/$unwind stages counted by one $group), built only from allowlisted stages. MongoDB counts roughly 10⁷–10⁸
 * of them per second, so 2·10⁸ runs for seconds and 10¹⁰ always exceeds SCANTOR_QUERY_MAX_TIME (30 s).
 */
export function countingPipeline(outer: number, inner: number): Record<string, unknown>[] {
  return [
    { $limit: 1 },
    { $project: { a: { $range: [0, outer] } } },
    { $unwind: '$a' },
    { $project: { b: { $range: [0, inner] } } },
    { $unwind: '$b' },
    { $group: { _id: null, n: { $sum: 1 } } },
  ]
}

/** A raw request with its own client timeout (ApiClient keeps Playwright's 30 s default). */
export async function rawJson<T = unknown>(
  api: ApiClient,
  method: 'GET' | 'POST',
  path: string,
  options: { data?: unknown; headers?: Record<string, string>; params?: Record<string, string | number>; timeoutMs: number },
): Promise<{ status: number; headers: Record<string, string>; body: T; text: string }> {
  const response = await api.request.fetch(path, {
    method,
    data: options.data,
    headers: options.headers,
    params: options.params,
    timeout: options.timeoutMs,
    maxRedirects: 0,
  })
  const text = await response.text()
  let body: unknown = {}
  if ((response.headers()['content-type'] ?? '').includes('json') && text.length > 0) body = JSON.parse(text)
  return { status: response.status(), headers: response.headers(), body: body as T, text }
}

/**
 * exportScanInline: the JSONL or CSV stream as raw bytes, with the JSON error body parsed (ApiClient would try to
 * parse `application/x-ndjson` as one JSON document).
 */
export async function exportInline<T = unknown>(api: ApiClient, scanId: string, query: Record<string, string | number> = {}): Promise<ApiResponse<T>> {
  const path = api.openapi.get('exportScanInline').path.replace('{scanId}', encodeURIComponent(scanId))
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(query)) params[key] = String(value)
  const response = await api.request.get(path, { params, maxRedirects: 0 })
  const raw = await response.body()
  const headers = response.headers()
  const isJson = /^application\/json/.test(headers['content-type'] ?? '')
  return { status: response.status(), headers, body: (isJson && raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {}) as T, raw }
}
