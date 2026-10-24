import type { Analysis } from '#shared/types/analyses'
import type { Page } from '#shared/types/common'
import type { Event } from '#shared/types/events'
import type { Condition, Scan } from '#shared/types/scans'
import type { Worker } from '#shared/types/workers'
import type { ConditionType } from '#shared/utils/enums'
import { ApiError, ok, type ApiClient } from './api-client'
import { innerDocker, stackEnv } from './docker'
import { SMALL_SETTINGS } from './scans'

// Shared code of the e2e runtime specs (templates, scheduler, retries, files, workers, placement, breaker, privileged,
// backpressure, limits). Besides the REST API of the scan's owner it only reads: the RabbitMQ management API of the
// test stack (published on the runner's loopback) for the scan's own queue and channels, and the processes of the
// scan's own worker containers. Nothing here changes shared platform objects.

// ── settings ──────────────────────────────────────────────────────────────────────────────────────────

/** Scan settings: SMALL_SETTINGS (1 runner × 1 process, 0.25 CPU, 256 MiB) with overrides. */
export function settings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...SMALL_SETTINGS, ...overrides }
}

/** A backoff without jitter: the delay after failed attempt n is min(maxMs, initialMs × factor^(n−1)). */
export function backoff(initialMs: number, factor = 1, maxMs = Math.max(initialMs, 60_000)): Record<string, unknown> {
  return { initialMs, factor, maxMs, jitter: false }
}

// ── scans and analyses ────────────────────────────────────────────────────────────────────────────────

export async function getScan(api: ApiClient, scanId: string): Promise<Scan> {
  return ok(await api.getScan(scanId), 'getScan')
}

/** Every analysis of a scan in seq order (listAnalyses pages of 1000, optionally projected to `fields`). */
export async function allAnalyses(api: ApiClient, scanId: string, fields?: string[]): Promise<Analysis[]> {
  const out: Analysis[] = []
  let afterSeq = -1
  for (;;) {
    const page = ok(
      await api.call<Page<Analysis>>('listAnalyses', { path: { scanId }, query: { afterSeq, limit: 1000, fields: fields?.join(',') } }),
      'listAnalyses',
    )
    out.push(...page.items)
    if (page.nextCursor === null || page.items.length === 0) return out
    afterSeq = Number(page.nextCursor)
  }
}

/** One analysis by seq (getAnalysis); null while it has no document yet. */
export async function analysisBySeq(api: ApiClient, scanId: string, seq: number): Promise<Analysis | null> {
  const response = await api.call<Analysis>('getAnalysis', { path: { analysisId: `${scanId}-${seq}` } })
  if (response.status === 404) return null
  return ok(response, 'getAnalysis')
}

/** Polls one analysis until `predicate` holds; throws with the last state on timeout. */
export async function waitForAnalysis(
  api: ApiClient,
  scanId: string,
  seq: number,
  predicate: (analysis: Analysis) => boolean,
  options: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<Analysis> {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000)
  for (;;) {
    const analysis = await analysisBySeq(api, scanId, seq)
    if (analysis && predicate(analysis)) return analysis
    if (Date.now() >= deadline) {
      throw new Error(`analysis ${scanId}-${seq}: ${options.what ?? 'condition'} not reached in time: ${JSON.stringify(analysis)}`)
    }
    await sleep(options.intervalMs ?? 500)
  }
}

/** Every event of a scan, oldest first, optionally of one type. */
export async function scanEvents(api: ApiClient, scanId: string, type?: string): Promise<Event[]> {
  const out: Event[] = []
  let cursor: string | undefined
  for (;;) {
    const page = ok(await api.call<Page<Event>>('listScanEvents', { path: { scanId }, query: { type, cursor, limit: 200 } }), 'listScanEvents')
    out.push(...page.items)
    if (page.nextCursor === null) return out.reverse()
    cursor = page.nextCursor
  }
}

/** Every worker of a scan, in any state. */
export async function scanWorkers(api: ApiClient, scanId: string): Promise<Worker[]> {
  const out: Worker[] = []
  let cursor: string | undefined
  for (;;) {
    const page = ok(await api.call<Page<Worker>>('listScanWorkers', { path: { scanId }, query: { cursor, limit: 200 } }), 'listScanWorkers')
    out.push(...page.items)
    if (page.nextCursor === null) return out
    cursor = page.nextCursor
  }
}

/** The scan's events and workers in compact form, for the message of a failed wait. */
export async function scanTimeline(api: ApiClient, scanId: string): Promise<string> {
  const [events, workers] = await Promise.all([scanEvents(api, scanId), scanWorkers(api, scanId)])
  return JSON.stringify({
    events: events.map((e) => [e.at, e.type, e.workerId, e.data]),
    workers: workers.map((w) => [w.id, w.role, w.state, w.stateReason?.code ?? null, w.nodeId, w.container?.id ?? null]),
  })
}

/** Runs `wait`; when it throws, rethrows with the scan's timeline appended. */
export async function withTimeline<T>(api: ApiClient, scanId: string, wait: () => Promise<T>): Promise<T> {
  try {
    return await wait()
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\ntimeline: ${await scanTimeline(api, scanId)}`, { cause: error })
  }
}

export function findCondition(scan: Scan, type: ConditionType): Condition | undefined {
  return scan.conditions.find((condition) => condition.type === type)
}

/** A compact description of a scan for assertion messages. */
export function describeScan(scan: Scan): string {
  return JSON.stringify({
    state: scan.state,
    stateReason: scan.stateReason,
    conditions: scan.conditions.map((c) => ({ type: c.type, reason: c.reason, details: c.details })),
    scheduling: { ...scan.scheduling, resolved: Object.keys(scan.scheduling.resolved) },
    workers: scan.workers,
  })
}

/** Polls getScan until `predicate` holds and returns that scan; throws with the scan's state on timeout. */
export async function pollScan(
  api: ApiClient,
  scanId: string,
  predicate: (scan: Scan) => boolean,
  options: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<Scan> {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000)
  for (;;) {
    const scan = await getScan(api, scanId)
    if (predicate(scan)) return scan
    if (Date.now() >= deadline) throw new Error(`scan ${scanId}: ${options.what ?? 'condition'} not reached in time: ${describeScan(scan)}`)
    await sleep(options.intervalMs ?? 1000)
  }
}

/** Polls `read` until `accept` holds and returns that value; throws with the last value on timeout. */
export async function pollUntil<T>(
  what: string,
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000)
  for (;;) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() >= deadline) throw new Error(`${what} not reached in time; last: ${JSON.stringify(value)}`)
    await sleep(options.intervalMs ?? 1000)
  }
}

/** POST /api/templates/{template}/estimate; returns the raw response (200 or 422). */
export function estimateTemplate(api: ApiClient, template: string, scanConfig: Record<string, unknown>) {
  return api.call<{ expectedTotal: number | null; exact: boolean; confirmationRequired: boolean; tooLarge: boolean }>('estimateTemplate', {
    path: { template },
    body: { scanConfig },
  })
}

/** The 422 `configInvalid` issues of a rejected request (paths are JSON pointers into the request body). */
export function configIssues(response: { status: number; body: unknown }): { path: string; message: string }[] {
  const body = response.body as { error?: { code?: string; details?: { issues?: { path: string; message: string }[] } } }
  if (response.status !== 422 || body.error?.code !== 'configInvalid') {
    throw new Error(`expected 422 configInvalid, got ${response.status} ${JSON.stringify(response.body)}`)
  }
  return body.error.details?.issues ?? []
}

/** The error code of a non-2xx response. */
export function errorCode(response: { status: number; body: unknown }): string | undefined {
  return (response.body as { error?: { code?: string } }).error?.code
}

/** Byte length of a string in UTF-8. */
export const utf8Bytes = (text: string) => Buffer.byteLength(text, 'utf8')

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── metrics ───────────────────────────────────────────────────────────────────────────────────────────

/** The sum of the samples of one Prometheus series of GET /api/metrics (admin) matching `labels`; 0 when absent. */
export async function metricValue(adminApi: ApiClient, name: string, labels: Record<string, string> = {}): Promise<number> {
  const response = await adminApi.call('getMetrics')
  if (response.status !== 200) throw new ApiError('getMetrics', response)
  const wanted = Object.entries(labels).map(([key, value]) => `${key}="${value}"`)
  let total = 0
  for (const line of response.raw.toString('utf8').split('\n')) {
    if (!line.startsWith(name) || line.startsWith('#')) continue
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)/.exec(line)
    if (!match || match[1] !== name) continue
    const labelText = match[2] ?? ''
    if (wanted.every((pair) => labelText.includes(pair))) total += Number(match[3])
  }
  return total
}

// ── broker (read-only management API of the stack's RabbitMQ) ─────────────────────────────────────────

const VHOST = 'scantor'

/** Connection failures to the management API worth another try: it resets connections while the broker is busy. */
const MANAGEMENT_ATTEMPTS = 5

async function management<T>(path: string): Promise<T | null> {
  const stack = stackEnv()
  const port = stack.SCANTOR_RABBITMQ_MANAGEMENT_PORT || '15672'
  const auth = Buffer.from(`${stack.SCANTOR_RABBITMQ_USER}:${stack.SCANTOR_RABBITMQ_PASSWORD}`).toString('base64')
  let response: Response
  for (let attempt = 1; ; attempt++) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/api${path}`, { headers: { Authorization: `Basic ${auth}` } })
      break
    } catch (error) {
      // fetch rejects only for network errors (a TypeError such as ECONNRESET); HTTP errors are handled below.
      if (!(error instanceof TypeError) || attempt >= MANAGEMENT_ATTEMPTS) throw error
      await sleep(500 * attempt)
    }
  }
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`RabbitMQ management ${path}: ${response.status} ${await response.text()}`)
  return (await response.json()) as T
}

export interface ScanQueue {
  messages: number
  messages_ready: number
  messages_unacknowledged: number
  messages_delayed?: number
  consumers: number
  arguments: Record<string, unknown>
}

/** The scan's quorum queue `scantor.scan.<scanId>`, or null when it does not exist. */
export function scanQueue(scanId: string): Promise<ScanQueue | null> {
  return management<ScanQueue>(`/queues/${VHOST}/${encodeURIComponent(`scantor.scan.${scanId}`)}`)
}

export interface BrokerChannel {
  name: string
  user: string
  confirm: boolean
  /** publishes the broker has neither confirmed nor refused yet */
  messages_unconfirmed?: number
  connection_details?: { name?: string }
  message_stats?: { publish?: number; confirm?: number; return_unroutable?: number; drop_unroutable?: number }
}

/** The open channels of the scan's RabbitMQ user `scan-<scanId>`. */
export async function scanChannels(scanId: string): Promise<BrokerChannel[]> {
  const channels = (await management<BrokerChannel[]>(`/channels?columns=name,user,confirm,messages_unconfirmed,connection_details,message_stats`)) ?? []
  return channels.filter((channel) => channel.user === `scan-${scanId}`)
}

/** The open connections of the scan's RabbitMQ user with the runtime's role (`scantor-runtime/<role>/<workerId>`). */
export async function scanConnections(scanId: string): Promise<{ name: string; role: string; workerId: string }[]> {
  const connections =
    (await management<{ name: string; user: string; user_provided_name?: string }[]>('/connections?columns=name,user,user_provided_name')) ?? []
  return connections
    .filter((connection) => connection.user === `scan-${scanId}`)
    .map((connection) => {
      const [, role = '', workerId = ''] = /^scantor-runtime\/([^/]+)\/(.+)$/.exec(connection.user_provided_name ?? '') ?? []
      return { name: connection.name, role, workerId }
    })
}

/**
 * The publishes of the scan's scheduler that the broker refused so far (nacks), from its channels' counters:
 * published − confirmed − still unconfirmed. RabbitMQ counts no nacks itself; the management statistics refresh every
 * few seconds, so the value lags. Null while the scheduler has no open channel.
 */
export async function schedulerNacks(scanId: string): Promise<number | null> {
  const [connections, channels] = await Promise.all([scanConnections(scanId), scanChannels(scanId)])
  const scheduler = new Set(connections.filter((connection) => connection.role === 'scheduler').map((connection) => connection.name))
  const own = channels.filter((channel) => channel.confirm && scheduler.has(channel.connection_details?.name ?? ''))
  if (own.length === 0) return null
  return own.reduce((sum, c) => sum + (c.message_stats?.publish ?? 0) - (c.message_stats?.confirm ?? 0) - (c.messages_unconfirmed ?? 0), 0)
}

// ── worker containers (read-only) ─────────────────────────────────────────────────────────────────────

/** Ids of the containers (running unless `all`) of a scan's workers on the built-in node, optionally of one worker. */
export async function workerContainers(scanId: string, options: { workerId?: string; all?: boolean } = {}): Promise<string[]> {
  const labels: Record<string, string> = { 'scantor.kind': 'worker', 'scantor.scan': scanId }
  if (options.workerId) labels['scantor.worker'] = options.workerId
  return innerDocker.containersByLabel(labels, { all: options.all ?? false })
}

/** The command lines of every process in a container (from /proc, so no ps is needed in the image). */
export async function containerProcesses(container: string): Promise<{ pid: number; cmdline: string }[]> {
  const script = 'for d in /proc/[0-9]*; do c=$(tr "\\000" " " < "$d/cmdline" 2>/dev/null); [ -n "$c" ] && echo "${d#/proc/} $c"; done'
  const result = await innerDocker.exec(container, ['sh', '-c', script])
  if (result.exitCode !== 0) throw new Error(`listing the processes of ${container} failed: ${result.stderr}`)
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(' ')
      return { pid: Number(line.slice(0, space)), cmdline: line.slice(space + 1).trim() }
    })
}

/** The Python connector processes (`python -m scantor.serve …`) of a container. */
export async function connectorProcesses(container: string): Promise<{ pid: number; cmdline: string }[]> {
  return (await containerProcesses(container)).filter((p) => p.cmdline.includes('scantor.serve'))
}
