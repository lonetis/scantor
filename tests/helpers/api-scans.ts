import { isDeepStrictEqual } from 'node:util'
import { request } from '@playwright/test'
import type { ItemList, JobRef, Page } from '#shared/types/common'
import type { Job } from '#shared/types/jobs'
import type { Event } from '#shared/types/events'
import type { Condition, InflightList, Scan, WorkerLogs } from '#shared/types/scans'
import type { ScansFixture, TasksFixture, Tenant } from '../fixtures'
import { ApiClient, ApiError, ok, type ApiResponse } from './api-client'
import { lifecycleTask } from './api-scans-tasks'
import { stackEnv } from './docker'
import { env } from './env'
import type { OpenApiIndex } from './openapi'
import { scanCounts, SMALL_SETTINGS, startScan, TERMINAL_STATES, waitForScanState, type StartScanBody } from './scans'
import { exampleTaskDir, removeDir, uploadAndPublish, type UploadedTask } from './tasks'
import { unique } from './unique'

// Shared code of api/scans.spec.ts and e2e/lifecycle.spec.ts: fixture bodies that keep the specs fast (the tenant's
// API key, one build per task kind and worker, a parallel scan cleanup), the instance limits of the test stack,
// settings that keep a scan's workers unplaceable (a `running` scan that consumes no node capacity), error-envelope
// access and bounded polling that throws with the last observed value.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────

// The specs act through the tenants' `default` API keys, which authenticate like the owner's session (AUTH-001) and
// are held in memory, so the clients depend on no storage-state file under tests/.auth (concurrent runs against one
// kept-alive stack write their own there) and can be created per worker without a sign-in.
//
// Long polls hold a request for up to 120 s (`wait`, docs/api.md §1.9: uploadTask and getRevision while the stack's
// build queue is busy, getJob behind the shared scanDelete queue), longer than Playwright's default request timeout
// of 30 s, so these clients allow a bit more than the longest wait.

/** Request timeout of the specs' API clients: the longest `wait` (120 s) plus a margin. */
export const LONG_POLL_TIMEOUT_MS = 150_000

/** Test fixture body (`api`): an ApiClient with the worker tenant's API key. */
export async function tenantKeyApi({ openapi, user }: { openapi: OpenApiIndex; user: Tenant }, use: (api: ApiClient) => Promise<void>): Promise<void> {
  await withKeyClient(openapi, user, use)
}

/** Worker fixture body: an ApiClient with the worker tenant's API key. */
export async function workerKeyApi({ openapi, user }: { openapi: OpenApiIndex; user: Tenant }, use: (api: ApiClient) => Promise<void>): Promise<void> {
  await withKeyClient(openapi, user, use)
}

/** Worker fixture body: an ApiClient with the second tenant's API key. */
export async function otherKeyApi({ openapi, otherUser }: { openapi: OpenApiIndex; otherUser: Tenant }, use: (api: ApiClient) => Promise<void>): Promise<void> {
  await withKeyClient(openapi, otherUser, use)
}

/** Runs `use` with an ApiClient that authenticates with the tenant's API key; disposes the context afterwards. */
export async function withKeyClient<T>(openapi: OpenApiIndex, tenant: Pick<Tenant, 'apiKey'>, use: (api: ApiClient) => Promise<T>): Promise<T> {
  const context = await request.newContext({
    baseURL: env.publicUrl,
    extraHTTPHeaders: { Origin: env.publicUrl, Authorization: `Bearer ${tenant.apiKey}` },
    timeout: LONG_POLL_TIMEOUT_MS,
  })
  try {
    return await use(new ApiClient(context, openapi))
  } finally {
    await context.dispose()
  }
}

/** Task kinds every test of a worker shares: the `sleep` example (template `repeat`) and the generated lifecycle task. */
export type SharedTaskKind = 'sleep' | 'lifecycle'

export interface SharedTasks {
  /** The worker's ready revision of a task kind, built on first use and reused by every later test of the worker. */
  get(kind: SharedTaskKind): Promise<UploadedTask>
}

async function buildShared(api: ApiClient, kind: SharedTaskKind, name: string): Promise<UploadedTask> {
  if (kind === 'sleep') return uploadAndPublish(api, exampleTaskDir('sleep'), name)
  const dir = await lifecycleTask()
  try {
    return await uploadAndPublish(api, dir, name)
  } finally {
    await removeDir(dir)
  }
}

/**
 * Worker fixture body: builds each shared task kind once per worker (publishing a revision builds an image, the most
 * expensive step of most tests, and the stack builds only two images at a time for every spec). The builds of every
 * kind in `prefetch` start when the fixture is set up (declare it `auto`, so that is the start of the worker), so
 * they run while the worker's first tests do other work. A failed build is not cached, so the next test tries again.
 * At worker teardown the tasks are deleted; one that a scan still holds is left to the purge of the worker's tenant,
 * which removes it with everything else the tenant owns.
 */
export function sharedTasksFixture(prefetch: SharedTaskKind[]) {
  return async ({ workerApi }: { workerApi: ApiClient }, use: (shared: SharedTasks) => Promise<void>): Promise<void> => {
    const builds = new Map<SharedTaskKind, Promise<UploadedTask>>()
    const names: string[] = []
    const build = (kind: SharedTaskKind) => {
      let pending = builds.get(kind)
      if (!pending) {
        const name = unique(`scans-${kind}`)
        names.push(name)
        pending = buildShared(workerApi, kind, name)
        builds.set(kind, pending)
        pending.catch(() => builds.delete(kind))
      }
      return pending
    }
    for (const kind of prefetch) void build(kind).catch(() => undefined)
    await use({ get: build })
    // Builds still running are awaited, so their tasks can be deleted.
    await Promise.allSettled(builds.values())
    for (const name of names) {
      const response = await workerApi.deleteTask(name)
      if (response.status !== 202 && response.status !== 404 && response.status !== 409) throw new ApiError(`deleteTask ${name}`, response)
    }
  }
}

/**
 * Test fixture body replacing `scans`: the same operations, but the teardown only cancels the test's scans that are
 * still active (in parallel), which stops their workers at once. The scans are not deleted one by one: the scanDelete
 * job runs two at a time for the whole stack and holds each slot for its settle delay (more than 10 s), so per-test
 * deletions would queue up behind each other and behind every other spec's. The purge of the worker's tenant at
 * worker teardown deletes all of its scans in one job; a scan's terminal state already frees its task for the
 * `tasks` fixture, whose teardown runs afterwards.
 */
export async function cancellingScansFixture(
  // Depends on `tasks`, so its teardown runs before the tasks are deleted.
  { api, tasks: _tasks }: { api: ApiClient; tasks: TasksFixture },
  use: (scans: ScansFixture) => Promise<void>,
): Promise<void> {
  const started = new Set<string>()
  await use({
    start: async (body) => {
      const scan = await startScan(api, body)
      started.add(scan.id)
      return scan
    },
    wait: (scanId, options = {}) => waitForScanState(api, scanId, options.state ?? 'completed', options.timeoutMs),
    counts: (scanId) => scanCounts(api, scanId),
    track: (scanId) => void started.add(scanId),
  })
  const results = await Promise.allSettled([...started].map((scanId) => cancelIfActive(api, scanId)))
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failure) throw failure.reason
}

/** Cancels a scan that is creating, running or paused; a terminal, deleting, deleted or unknown scan is left alone. */
export async function cancelIfActive(api: ApiClient, scanId: string): Promise<void> {
  const current = await api.getScan(scanId)
  if (current.status === 404) return
  const scan = ok(current, 'getScan')
  if (!ACTIVE_STATES.includes(scan.state)) return
  const cancelled = await api.cancelScan(scanId)
  // 409: the scan finished (or was deleted) in the meantime.
  if (cancelled.status !== 200 && cancelled.status !== 409) throw new ApiError(`cancelScan ${scanId}`, cancelled)
}

const ACTIVE_STATES: readonly Scan['state'][] = ['creating', 'running', 'paused']

/** Long-polls a job until it is no longer queued or running; the job queues are shared by the whole stack. */
export async function waitForJob(api: ApiClient, jobId: string, timeoutMs: number): Promise<Job> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const wait = Math.max(1, Math.min(50, Math.ceil((deadline - Date.now()) / 1000)))
    const job = ok(await api.getJob(jobId, wait), 'getJob')
    if (job.state !== 'queued' && job.state !== 'running') return job
    if (Date.now() >= deadline) throw new Error(`job ${jobId} (${job.kind}) is still ${job.state} after ${timeoutMs / 1000} s`)
  }
}

// ── instance limits and settings ───────────────────────────────────────────────────────────────────

/** A pool no node belongs to: the scan becomes `running`, but its workers stay `pending` (selectorMismatch). */
export const UNPLACEABLE_POOL = 'api-scans-nowhere'

/** SMALL_SETTINGS on the unplaceable pool. */
export const UNPLACEABLE_SETTINGS = { ...SMALL_SETTINGS, nodeSelector: { pool: UNPLACEABLE_POOL } } as const

/** Parses a byte size of .env.example (`1MiB`, `64KiB`, `512`). */
export function parseByteSize(value: string): number {
  const match = /^([0-9]+)(KiB|MiB|GiB|TiB)?$/.exec(value)
  if (!match) throw new Error(`not a byte size: ${value}`)
  const unit = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 }[match[2] as 'KiB' | 'MiB' | 'GiB' | 'TiB'] ?? 1
  return Number(match[1]) * unit
}

function integer(values: Record<string, string>, name: string): number {
  const value = Number(values[name])
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is not an integer in the stack's .env: ${values[name]}`)
  return value
}

/** The instance limits the scan routes enforce, read from the stack's generated .env. */
export function scanLimits() {
  const values = stackEnv()
  return {
    maxWorkersPerScan: integer(values, 'SCANTOR_MAX_WORKERS_PER_SCAN'),
    maxProcessesPerWorker: integer(values, 'SCANTOR_MAX_PROCESSES_PER_WORKER'),
    confirmThreshold: integer(values, 'SCANTOR_SCAN_CONFIRM_THRESHOLD'),
    maxAnalysesPerScan: integer(values, 'SCANTOR_MAX_ANALYSES_PER_SCAN'),
    maxScanConfigBytes: parseByteSize(values.SCANTOR_MAX_SCAN_CONFIG_BYTES ?? ''),
    deliveryLimit: integer(values, 'SCANTOR_DELIVERY_LIMIT'),
    scanQueueMaxReady: integer(values, 'SCANTOR_SCAN_QUEUE_MAX_READY'),
    tombstoneDays: integer(values, 'SCANTOR_TOMBSTONE_DAYS'),
  }
}

// ── API access ──────────────────────────────────────────────────────────────────────────────────────

export interface ErrorEnvelope {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

/** The error of a non-2xx response; throws with the response when the status or code differ. */
export function apiErrorOf(response: ApiResponse, status: number, code: string): ErrorEnvelope['error'] {
  const body = response.body as Partial<ErrorEnvelope>
  if (response.status !== status || body.error?.code !== code) {
    throw new Error(`expected ${status} ${code}, got ${response.status}: ${JSON.stringify(response.body).slice(0, 2000)}`)
  }
  return body.error
}

/**
 * Calls startScan with small settings unless the body sets them, and registers a created scan with `track`, so error
 * cases that unexpectedly succeed are still cleaned up.
 */
export async function tryStartScan(api: ApiClient, track: (scanId: string) => void, body: StartScanBody & Record<string, unknown>): Promise<ApiResponse<Scan>> {
  const response = await api.startScan({ settings: SMALL_SETTINGS, ...body })
  if (response.status === 201) track(response.body.id)
  return response
}

/** The scan operations without a typed wrapper in ApiClient, by operationId (docs/api.md §4.13). */
export function scanOps(api: ApiClient) {
  const path = (scanId: string) => ({ scanId })
  return {
    pause: (scanId: string) => api.call<Scan>('pauseScan', { path: path(scanId) }),
    resume: (scanId: string) => api.call<Scan>('resumeScan', { path: path(scanId) }),
    scale: (scanId: string, body: { workers?: number; processes?: number }) => api.call<Scan>('scaleScan', { path: path(scanId), body }),
    restart: (scanId: string, body: { name?: string; settings?: Record<string, unknown> } = {}) => api.call<Scan>('restartScan', { path: path(scanId), body }),
    retryFailed: (scanId: string) => api.call<{ scan: Scan; job: JobRef }>('retryFailedAnalyses', { path: path(scanId) }),
    conditions: (scanId: string) => api.call<ItemList<Condition>>('listScanConditions', { path: path(scanId) }),
    events: (scanId: string, query: { type?: string; limit?: number; cursor?: string } = {}) =>
      api.call<Page<Event>>('listScanEvents', { path: path(scanId), query }),
    inflight: (scanId: string) => api.call<InflightList>('listInflightAnalyses', { path: path(scanId) }),
    workerLogs: (scanId: string, workerId: string, query: { wait?: number; tailBytes?: number } = {}) =>
      api.call<WorkerLogs>('getWorkerLogs', { path: { scanId, workerId }, query }),
  }
}

/** The scan (getScan without wait). */
export async function getScan(api: ApiClient, scanId: string): Promise<Scan> {
  return ok(await api.getScan(scanId), 'getScan')
}

/** Event types of a scan, newest first (one page of up to 200). */
export async function eventTypes(api: ApiClient, scanId: string, type?: string): Promise<string[]> {
  const page = ok(await scanOps(api).events(scanId, { type, limit: 200 }), 'listScanEvents')
  return page.items.map((event) => event.type)
}

/** Waits until the reconciler finished the scan's topology (state running). */
export function waitRunning(api: ApiClient, scanId: string, timeoutMs = 60_000): Promise<Scan> {
  return waitFor(
    `scan ${scanId} running`,
    () => getScan(api, scanId),
    (scan) => scan.state === 'running',
    { timeoutMs, intervalMs: 250 },
  )
}

/** Whether a scan state is terminal (completed, failed, cancelled). */
export const isTerminal = (state: Scan['state']) => TERMINAL_STATES.includes(state)

// ── polling ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Calls `read` every `intervalMs` (default 500) until `done` holds for its value and returns that value; throws with
 * the last value when `timeoutMs` passes.
 */
export async function waitFor<T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  options: { timeoutMs: number; intervalMs?: number },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() >= deadline) throw new Error(`${what} did not happen within ${options.timeoutMs / 1000} s; last value: ${JSON.stringify(value)}`)
    await sleep(options.intervalMs ?? 500)
  }
}

/** Reads `read` repeatedly for `durationMs` and throws as soon as a value differs from the first one. */
export async function expectStableFor<T>(what: string, read: () => Promise<T>, options: { durationMs: number; intervalMs?: number }): Promise<T> {
  const first = await read()
  const end = Date.now() + options.durationMs
  while (Date.now() < end) {
    await sleep(options.intervalMs ?? 2000)
    const next = await read()
    if (!isDeepStrictEqual(next, first)) throw new Error(`${what} changed from ${JSON.stringify(first)} to ${JSON.stringify(next)}`)
  }
  return first
}
