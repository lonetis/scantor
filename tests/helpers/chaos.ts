import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request, type APIRequestContext } from '@playwright/test'
import type { Analysis } from '#shared/types/analyses'
import type { Health } from '#shared/types/instance'
import type { Node, NodeJoin } from '#shared/types/nodes'
import type { Scan } from '#shared/types/scans'
import type { Worker } from '#shared/types/workers'
import { ApiError, ok, type ApiClient } from './api-client'
import { CONTAINERS, docker, innerDocker, stackEnv } from './docker'
import { env } from './env'
import { SMALL_SETTINGS } from './scans'
import { removeDir } from './tasks'

// Helpers of the chaos project (docs/testing.md §8.7): the chaos probe task, tolerant polling while platform
// components are down, the stack's RabbitMQ management API and rabbitmqctl, the orchestrator's own listener
// (bypassing Traefik, whose route follows the container's health), the remote node remote-1 (its daemon and its
// token file), forged result messages and metrics. Every fault a test injects is undone by the test itself in a
// `finally` block; `waitForHealthyPlatform` is the precondition of every chaos case.

// ── the chaos probe task ────────────────────────────────────────────────────────────────────────────────

/**
 * main.py of the chaos probe: a custom schedule of `count` items (deterministic unless `random_items`, optionally
 * slow) and analyses that sleep, fail by attempt or until a deadline, fail fatally, or kill their worker's runtime.
 */
const CHAOS_PY = `"""chaos probe: analyses that sleep, fail or kill their worker, chosen by the task config (chaos tests)."""

import asyncio
import os
import random
import signal
import time
from collections.abc import Iterator

from pydantic import BaseModel, Field

import scantor


class TaskConfig(scantor.Config):
    seconds: float = Field(default=0, ge=0, le=3600, description="Work per analysis (cancellable).")
    fast_seqs: int = Field(default=0, ge=0, description="The first n seqs skip the work.")
    fail_attempts: int = Field(default=0, ge=0, le=20, description="Attempts that raise before one succeeds.")
    fail_before: float = Field(default=0, ge=0, description="Epoch seconds: attempts before this time raise.")
    fatal_seqs: list[int] = Field(default_factory=list, description="These seqs raise scantor.Fatal.")
    poison_seqs: list[int] = Field(default_factory=list, description="These seqs kill the runtime of their worker.")


class ScanConfig(scantor.Config):
    count: int = Field(default=5, ge=1, le=100000)
    delay_seconds: float = Field(default=0, ge=0, le=10, description="Pause before each item.")
    random_items: bool = Field(default=False, description="Yield a random nonce (a non-deterministic schedule).")


class AnalysisConfig(scantor.Config):
    index: int
    nonce: float


class Result(BaseModel):
    index: int
    attempt: int


def schedule(ctx: scantor.Context, scan_config: ScanConfig, task_config: TaskConfig) -> Iterator[AnalysisConfig]:
    for index in range(scan_config.count):
        if scan_config.delay_seconds > 0:
            time.sleep(scan_config.delay_seconds)
        yield AnalysisConfig(index=index, nonce=random.random() if scan_config.random_items else 0.0)


async def run(ctx: scantor.Context, analysis_config: AnalysisConfig, task_config: TaskConfig) -> Result:
    index = analysis_config.index
    if index in task_config.poison_seqs:
        # The runtime is this process's parent (docker-init is PID 1): killing it ends the worker container while
        # this delivery is unacknowledged, which counts toward the queue's delivery limit.
        os.kill(os.getppid(), signal.SIGKILL)
        await asyncio.sleep(3600)
    if index >= task_config.fast_seqs and task_config.seconds > 0:
        await asyncio.sleep(task_config.seconds)
    if index in task_config.fatal_seqs:
        raise scantor.Fatal(f"chaos fatal error of item {index}")
    if ctx.attempt <= task_config.fail_attempts:
        raise RuntimeError(f"chaos failure in attempt {ctx.attempt}")
    if time.time() < task_config.fail_before:
        raise RuntimeError("chaos failure before fail_before")
    return Result(index=index, attempt=ctx.attempt)


task = scantor.Task(
    task_config=TaskConfig,
    scan_config=ScanConfig,
    analysis_config=AnalysisConfig,
    result=Result,
    schedule=schedule,
    run=run,
)
`

const CHAOS_MANIFEST = `scantor: 1
name: chaos-probe
language: python
description: "Chaos test task: a custom schedule and analyses that sleep, fail or kill their worker."
defaults:
  timeout: 2m
  maxAttempts: 3
`

/** Task config of the chaos probe (see CHAOS_PY). */
export interface ChaosTaskConfig {
  seconds?: number
  fast_seqs?: number
  fail_attempts?: number
  fail_before?: number
  fatal_seqs?: number[]
  poison_seqs?: number[]
}

/** Scan config of the chaos probe. */
export interface ChaosScanConfig {
  count: number
  delay_seconds?: number
  random_items?: boolean
}

/**
 * Writes the chaos probe to a new temporary folder (remove it with `removeDir`). With `slowBuildSeconds` the
 * Dockerfile gets a `RUN … sleep` step with a fresh nonce, so the build is never cached and lasts that long.
 */
export async function writeChaosTask(options: { slowBuildSeconds?: number } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'chaos-probe-'))
  const slow = options.slowBuildSeconds ? `RUN echo "${randomUUID()}" > /tmp/chaos-build-nonce && sleep ${options.slowBuildSeconds}\n` : ''
  await writeFile(join(dir, 'Dockerfile'), `ARG SCANTOR_BASE\nFROM \${SCANTOR_BASE}\n${slow}COPY . .\n`)
  await writeFile(join(dir, '.dockerignore'), '__pycache__/\n.scantor/\n')
  await writeFile(join(dir, 'scantor.yaml'), CHAOS_MANIFEST)
  await writeFile(join(dir, 'main.py'), CHAOS_PY)
  return dir
}

export { removeDir }

// ── polling ─────────────────────────────────────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Polls `read` until `done(value)` holds. Errors thrown by `read` (a component that is down) count as "not yet";
 * on timeout the error names `what` and the last value or error.
 */
export async function waitFor<T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  options: { timeoutMs: number; intervalMs?: number },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs
  let last: { value?: T; error?: unknown }
  for (;;) {
    try {
      const value = await read()
      if (done(value)) return value
      last = { value }
    } catch (error) {
      last = { error }
    }
    if (Date.now() >= deadline) {
      const detail = last.error !== undefined ? String((last.error as Error).message ?? last.error) : JSON.stringify(last.value)
      throw new Error(`timed out after ${options.timeoutMs / 1000} s waiting for ${what}; last: ${detail?.slice(0, 3000)}`)
    }
    await delay(options.intervalMs ?? 1000)
  }
}

/** Lets time pass on purpose: the behaviour under test is what happens during that time (e.g. a paused scan). */
export const holdFor = (ms: number) => delay(Math.max(0, ms))

/**
 * A request context authenticated with the tenant's API key, for worker-scoped fixtures and hooks. The request
 * timeout is above every `wait` the suite uses (120 s).
 */
export function apiKeyContext(apiKey: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: env.publicUrl,
    extraHTTPHeaders: { Origin: env.publicUrl, Authorization: `Bearer ${apiKey}` },
    timeout: 150_000,
  })
}

// ── health ──────────────────────────────────────────────────────────────────────────────────────────────

/** `GET /api/health` through Traefik with its HTTP status (503 is a valid answer). */
export async function publicHealth(): Promise<{ status: number; body: Health }> {
  const response = await fetch(`${env.publicUrl}/api/health`, { signal: AbortSignal.timeout(20_000) })
  return { status: response.status, body: (await response.json()) as Health }
}

/**
 * The precondition of every chaos case: /api/health is 200 `ok` without alarms and remote-1 is online, so a case
 * never starts on the leftovers of the previous one.
 */
export async function waitForHealthyPlatform(adminApi: ApiClient, timeoutMs = 120_000): Promise<void> {
  const remote = readRemoteNode()
  await waitFor(
    'a healthy platform (health ok without alarms, remote-1 online)',
    async () => ({ health: await publicHealth(), remote: (await getNode(adminApi, remote.id)).state }),
    (state) => state.health.status === 200 && state.health.body.status === 'ok' && state.health.body.alarms.length === 0 && state.remote === 'online',
    { timeoutMs, intervalMs: 1000 },
  )
}

// ── scans ───────────────────────────────────────────────────────────────────────────────────────────────

export async function getScan(api: ApiClient, scanId: string): Promise<Scan> {
  return ok(await api.getScan(scanId), 'getScan')
}

function describeScan(scan: Scan): string {
  return JSON.stringify({
    state: scan.state,
    stateReason: scan.stateReason,
    conditions: scan.conditions,
    scheduling: { ...scan.scheduling, resolved: undefined },
    stats: scan.stats,
    workers: scan.workers,
  })
}

/**
 * Polls getScan (1 s, no `wait`, errors tolerated) until `done(scan)`. Unlike the scans fixture's long-poll it
 * survives an orchestrator that is restarting or paused. `everyPoll` runs after each unfinished poll; what it throws
 * (an invariant that must hold meanwhile) fails at once.
 */
export async function waitForScan(
  api: ApiClient,
  scanId: string,
  what: string,
  done: (scan: Scan) => boolean,
  timeoutMs: number,
  everyPoll?: () => Promise<void>,
): Promise<Scan> {
  const deadline = Date.now() + timeoutMs
  let last: Scan | undefined
  let lastError: unknown
  for (;;) {
    try {
      last = await getScan(api, scanId)
      if (done(last)) return last
    } catch (error) {
      lastError = error
    }
    if (everyPoll) await everyPoll()
    if (Date.now() >= deadline) {
      throw new Error(`scan ${scanId}: timed out after ${timeoutMs / 1000} s waiting for ${what}; ${last ? describeScan(last) : String(lastError)}`)
    }
    await delay(1000)
  }
}

const TERMINAL: readonly Scan['state'][] = ['completed', 'failed', 'cancelled', 'deleted']

/** Waits for the given state; throws with diagnostics when the scan ends in another terminal state. */
export async function waitForScanState(api: ApiClient, scanId: string, state: Scan['state'], timeoutMs: number): Promise<Scan> {
  const scan = await waitForScan(api, scanId, `state ${state}`, (s) => s.state === state || TERMINAL.includes(s.state), timeoutMs)
  if (scan.state !== state) throw new Error(`scan ${scanId} ended ${scan.state} instead of ${state}: ${describeScan(scan)}`)
  return scan
}

/** Exact counts by status (aggregateAnalyses), as the scans fixture computes them, for polling. */
export async function statusCounts(api: ApiClient, scanId: string): Promise<Record<string, number>> {
  const result = ok(await api.aggregateAnalyses(scanId, [{ $group: { _id: '$status', n: { $sum: 1 } } }]), 'aggregateAnalyses')
  const counts: Record<string, number> = {}
  for (const row of result.items as { _id: string; n: number }[]) counts[row._id] = row.n
  return counts
}

export type AnalysisRow = Pick<Analysis, 'id' | 'seq' | 'round' | 'status' | 'attempt'> & Partial<Analysis>

/** Every analysis of a scan (≤ 1000) in seq order with the given extra fields. */
export async function analysesOf(api: ApiClient, scanId: string, fields: string[] = []): Promise<AnalysisRow[]> {
  const projection: Record<string, 1> = { seq: 1, round: 1, status: 1, attempt: 1 }
  for (const field of fields) projection[field] = 1
  const result = ok(await api.queryAnalyses(scanId, { filter: {}, projection, sort: { seq: 1 }, limit: 1000 }), 'queryAnalyses')
  return result.items as AnalysisRow[]
}

export async function scanWorkers(api: ApiClient, scanId: string): Promise<Worker[]> {
  return ok(await api.listScanWorkers(scanId, { limit: 200 }), 'listScanWorkers').items
}

export async function inflightOf(api: ApiClient, scanId: string): Promise<{ seq: number; workerId: string; nodeId: string }[]> {
  return ok(
    await api.call<{ items: { seq: number; workerId: string; nodeId: string }[] }>('listInflightAnalyses', { path: { scanId } }),
    'listInflightAnalyses',
  ).items
}

export async function scanEvents(api: ApiClient, scanId: string, type: string): Promise<{ type: string; data?: Record<string, unknown> }[]> {
  return ok(
    await api.call<{ items: { type: string; data?: Record<string, unknown> }[] }>('listScanEvents', { path: { scanId }, query: { type, limit: 200 } }),
    'listScanEvents',
  ).items
}

/** Expects exactly one analysis document per seq 0 … total − 1. */
export function expectOnePerSeq(rows: { seq: number }[], total: number): void {
  const seqs = rows.map((row) => row.seq)
  const expected = Array.from({ length: total }, (_, index) => index)
  if (JSON.stringify(seqs) !== JSON.stringify(expected)) throw new Error(`expected one analysis per seq 0…${total - 1}, got ${JSON.stringify(seqs)}`)
}

const ACTIVE_WORKER_STATES: readonly Worker['state'][] = ['assigned', 'pulling', 'starting', 'running', 'backoff', 'draining']
export const isActiveWorker = (worker: Worker) => ACTIVE_WORKER_STATES.includes(worker.state)

/** Waits until a worker of the role runs a container (optionally on the given node); returns it. */
export async function runningWorker(api: ApiClient, scanId: string, role: Worker['role'], nodeId?: string, timeoutMs = 180_000): Promise<Worker> {
  const matches = (w: Worker) => w.role === role && w.state === 'running' && w.container !== null && (!nodeId || w.nodeId === nodeId)
  const workers = await waitFor(
    `a running ${role} of ${scanId}`,
    () => scanWorkers(api, scanId),
    (all) => all.some(matches),
    { timeoutMs },
  )
  return workers.find(matches)!
}

// ── forged result messages (docs/queue.md §5.3) ─────────────────────────────────────────────────────────

/** Fields of an analysis document a result message is rebuilt from. */
export const RESULT_FIELDS = ['config', 'result', 'error', 'files', 'logTail', 'timings', 'workerId', 'nodeId', 'executionId', 'attempts', 'updatedAt']

/** The body of a result message for an analysis document, as the runtime publishes it; `overrides` replace fields. */
export function resultMessage(scanId: string, analysis: AnalysisRow, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const epoch = (value: string | null | undefined) => (value ? Date.parse(value) : Date.now())
  return {
    v: 1,
    kind: 'result',
    analysisId: `${scanId}-${analysis.seq}`,
    scanId,
    seq: analysis.seq,
    round: analysis.round,
    attempt: analysis.attempt,
    executionId: analysis.executionId,
    workerId: analysis.workerId,
    nodeId: analysis.nodeId,
    config: analysis.config,
    status: analysis.status,
    result: analysis.status === 'succeeded' ? analysis.result : null,
    error: null,
    files: [],
    logTail: analysis.logTail ?? '',
    timings: {
      scheduledAt: epoch(analysis.timings?.scheduledAt),
      startedAt: epoch(analysis.timings?.startedAt),
      finishedAt: epoch(analysis.timings?.finishedAt),
      durationMs: analysis.timings?.durationMs ?? 0,
    },
    ...overrides,
  }
}

// ── worker containers ─────────────────────────────────────────────────────────────────────────────────

export const workerContainerName = (workerId: string) => `scantor-w-${workerId}`

/** Container names `scantor-w-*` of a scan in remote-1's dockerd (running and exited). */
export async function remoteScanContainers(scanId: string): Promise<string[]> {
  const { stdout } = await innerDocker.remote(['ps', '-a', '--filter', `label=scantor.scan=${scanId}`, '--format', '{{.Names}}'])
  return stdout.split('\n').filter(Boolean).sort()
}

/** `docker inspect` State of a container in remote-1's dockerd, or null when it does not exist. */
export async function remoteContainerState(name: string): Promise<{ Running: boolean; ExitCode: number; StartedAt: string } | null> {
  const result = await innerDocker.remote(['inspect', '--format', '{{json .State}}', name], { allowFailure: true })
  if (result.exitCode !== 0) return null
  return JSON.parse(result.stdout) as { Running: boolean; ExitCode: number; StartedAt: string }
}

// ── RabbitMQ ────────────────────────────────────────────────────────────────────────────────────────────

const VHOST = 'scantor'
export const scanQueueName = (scanId: string) => `scantor.scan.${scanId}`
export const scanUserName = (scanId: string) => `scan-${scanId}`
export const INGEST_QUEUE = 'scantor.results.ingest'

/** One request to the stack's RabbitMQ management API (runner loopback) as its admin; 404 → `body: null`. */
async function management<T>(method: 'GET' | 'DELETE', path: string): Promise<{ status: number; body: T | null }> {
  const stack = stackEnv()
  const port = stack.SCANTOR_RABBITMQ_MANAGEMENT_PORT || '15672'
  const auth = Buffer.from(`${stack.SCANTOR_RABBITMQ_USER}:${stack.SCANTOR_RABBITMQ_PASSWORD}`).toString('base64')
  const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (response.status === 404) return { status: 404, body: null }
  if (!response.ok) throw new Error(`RabbitMQ management ${method} ${path}: ${response.status} ${await response.text()}`)
  const text = await response.text()
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as T) }
}

export interface QueueInfo {
  name: string
  messages?: number
  messages_ready?: number
  messages_unacknowledged?: number
  consumers?: number
}

export const broker = {
  /** A queue of the scantor vhost, or null when it does not exist. */
  async queue(name: string): Promise<QueueInfo | null> {
    return (await management<QueueInfo>('GET', `/queues/${VHOST}/${encodeURIComponent(name)}`)).body
  },
  async userExists(user: string): Promise<boolean> {
    return (await management('GET', `/users/${encodeURIComponent(user)}`)).status !== 404
  },
  /** Open AMQP connections of a user. */
  async connectionsOf(user: string): Promise<number> {
    const { body } = await management<{ user: string }[]>('GET', '/connections?columns=user')
    return (body ?? []).filter((connection) => connection.user === user).length
  },
  /** Deletes a queue with every ready, delayed and unacknowledged message (what an operator might do). */
  async deleteQueue(name: string): Promise<void> {
    await management('DELETE', `/queues/${VHOST}/${encodeURIComponent(name)}`)
  },
}

async function rabbitmqctl(args: string[]): Promise<string> {
  const result = await innerDocker.exec(CONTAINERS.rabbitmq, ['rabbitmqctl', '-q', ...args])
  if (result.exitCode !== 0) throw new Error(`rabbitmqctl ${args.join(' ')} exited with ${result.exitCode}: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

/** The broker's memory high watermark as rabbitmqctl takes it back: `['absolute', '1536MiB']` or `['relative', '0.4']`. */
export async function memoryWatermark(): Promise<[string, string]> {
  const raw = await rabbitmqctl(['eval', 'vm_memory_monitor:get_vm_memory_high_watermark().'])
  const absolute = /^\{absolute,"?([^"}]+)"?\}$/.exec(raw)
  if (absolute) return ['absolute', absolute[1]!]
  if (/^[0-9.]+$/.test(raw)) return ['relative', raw]
  const relative = /^\{relative,([0-9.]+)\}$/.exec(raw)
  if (relative) return ['relative', relative[1]!]
  throw new Error(`unexpected memory watermark ${raw}`)
}

export async function setMemoryWatermark([mode, value]: [string, string]): Promise<void> {
  if (mode === 'absolute') await rabbitmqctl(['set_vm_memory_high_watermark', 'absolute', value])
  else await rabbitmqctl(['set_vm_memory_high_watermark', value])
}

/**
 * Raises a memory alarm (watermark 1 byte) for the duration of `body` and restores the previous watermark. When the
 * restore fails, RabbitMQ is restarted, which reloads the configured watermark.
 */
export async function withMemoryAlarm<T>(body: () => Promise<T>): Promise<T> {
  const watermark = await memoryWatermark()
  try {
    await setMemoryWatermark(['absolute', '1'])
    return await body()
  } finally {
    try {
      await setMemoryWatermark(watermark)
    } catch {
      await innerDocker.restart(CONTAINERS.rabbitmq)
    }
  }
}

// ── the orchestrator ────────────────────────────────────────────────────────────────────────────────────

/** The orchestrator's own listener, published on the runner's loopback (no Traefik in between). */
export function orchestratorDirectUrl(): string {
  return `http://127.0.0.1:${stackEnv().SCANTOR_PORT || '3000'}`
}

export interface DirectResponse {
  status: number
  contentType: string
  text: string
  json: unknown
}

/** A GET to the orchestrator's own listener with a short timeout; network errors throw. */
export async function directGet(path: string, headers: Record<string, string> = {}): Promise<DirectResponse> {
  const response = await fetch(`${orchestratorDirectUrl()}${path}`, { headers: { Origin: env.publicUrl, ...headers }, signal: AbortSignal.timeout(5000) })
  const text = await response.text()
  const contentType = response.headers.get('content-type') ?? ''
  let json: unknown = null
  if (contentType.includes('json') && text) json = JSON.parse(text)
  return { status: response.status, contentType, text, json }
}

/**
 * A request context with the tenant's API key on the orchestrator's own listener. Traefik drops the route of a paused
 * container and adds it back only after the unpause event, so requests right after `docker unpause` go here.
 */
export function directApiContext(apiKey: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: orchestratorDirectUrl(),
    extraHTTPHeaders: { Origin: env.publicUrl, Authorization: `Bearer ${apiKey}` },
    timeout: 30_000,
  })
}

/**
 * Waits until scan starts are accepted again after a broker alarm: /api/health and the start path cache the alarm
 * state separately (docs/queue.md §10), so a healthy /api/health does not mean that startScan has seen the alarm end.
 * The probe's task config is invalid, which startScan checks after the alarm (422 configInvalid), so no scan is created.
 */
export async function waitForScanStartsAccepted(api: ApiClient, revision: string, invalidTaskConfig: Record<string, unknown>): Promise<void> {
  const response = await waitFor(
    'startScan without brokerAlarm',
    () => api.startScan({ revision, taskConfig: invalidTaskConfig, settings: SMALL_SETTINGS }),
    (r) => r.status !== 503,
    { timeoutMs: 60_000, intervalMs: 1000 },
  )
  if (response.status !== 422) throw new ApiError('the startScan probe with an invalid task config', response)
}

/** `docker stop` of the orchestrator (its compose stop grace is 30 s). */
export async function stopOrchestrator(): Promise<void> {
  await docker(['stop', CONTAINERS.orchestrator], { timeoutMs: 90_000 })
}

export async function startOrchestrator(): Promise<void> {
  await docker(['start', CONTAINERS.orchestrator])
}

/**
 * Waits until the orchestrator answers API requests again: first its own listener (boot finished), then the public
 * URL through Traefik (which routes again once the container's health check passed).
 */
export async function waitForOrchestrator(apiKey: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const auth = { Authorization: `Bearer ${apiKey}` }
  await waitFor(
    'the orchestrator to finish booting',
    () => directGet('/api/scans?limit=1', auth),
    (r) => r.status === 200,
    { timeoutMs, intervalMs: 500 },
  )
  await waitFor(
    'the public URL to reach the orchestrator',
    async () => (await fetch(`${env.publicUrl}/api/scans?limit=1`, { headers: { Origin: env.publicUrl, ...auth }, signal: AbortSignal.timeout(5000) })).status,
    (status) => status === 200,
    { timeoutMs: Math.max(10_000, deadline - Date.now()), intervalMs: 500 },
  )
}

/** One sample of a Prometheus metric (sum over the series whose labels include `labels`). */
export async function metricValue(adminApi: ApiClient, name: string, labels: Record<string, string> = {}): Promise<number> {
  const response = await adminApi.call('getMetrics', { validate: false })
  if (response.status !== 200) throw new ApiError('getMetrics', response)
  let total = 0
  for (const line of response.raw.toString('utf8').split('\n')) {
    if (line.startsWith('#')) continue
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+(\S+)/.exec(line)
    if (!match || match[1] !== name) continue
    const series: Record<string, string> = {}
    for (const pair of (match[2] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) series[pair[1]!] = pair[2]!
    if (Object.entries(labels).every(([key, value]) => series[key] === value)) total += Number(match[3])
  }
  return total
}

/** A white-box `/api/runtime/*` client with a worker token (helpers/keys.ts derivation). */
export function workerRequest(token: string, version: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: env.publicUrl,
    extraHTTPHeaders: { Authorization: `Bearer ${token}`, 'X-Scantor-Version': version, 'User-Agent': `scantor-runtime/${version}` },
    timeout: 30_000,
  })
}

// ── nodes and remote-1 ──────────────────────────────────────────────────────────────────────────────────

export interface RemoteNodeFile {
  id: string
  name: string
  pool: string
  labels: Record<string, string>
  token: string
}

/** remote-1 as the runner joined it (/run/scantor-test/remote-node.json, kept current by `rejoinRemoteDaemon`). */
export function readRemoteNode(): RemoteNodeFile {
  return JSON.parse(readFileSync(env.paths.remoteNode, 'utf8')) as RemoteNodeFile
}

export async function getNode(adminApi: ApiClient, nodeId: string): Promise<Node> {
  return ok(await adminApi.call<Node>('getNode', { path: { nodeId } }), 'getNode')
}

/** `updateNode` as admin: pool, labels and cordon of a shared node (only the chaos project changes them). */
export async function updateNode(
  adminApi: ApiClient,
  nodeId: string,
  body: { pool?: string; labels?: Record<string, string>; cordoned?: boolean },
): Promise<Node> {
  return ok(await adminApi.call<Node>('updateNode', { path: { nodeId }, body }), 'updateNode')
}

export async function waitForNodeState(adminApi: ApiClient, nodeId: string, state: Node['state'], timeoutMs: number): Promise<Node> {
  return waitFor(
    `node ${nodeId} ${state}`,
    () => getNode(adminApi, nodeId),
    (node) => node.state === state,
    { timeoutMs, intervalMs: 1000 },
  )
}

/** The built-in node (its pool selects it alone in a nodeSelector). */
export async function builtinNode(adminApi: ApiClient): Promise<Node> {
  const builtin = ok(await adminApi.listNodes(), 'listNodes').items.find((node) => node.builtIn)
  if (!builtin) throw new Error('no built-in node')
  return builtin
}

export async function nodeEvents(adminApi: ApiClient, nodeId: string): Promise<{ type: string; at: string }[]> {
  return ok(await adminApi.call<{ items: { type: string; at: string }[] }>('listNodeEvents', { path: { nodeId }, query: { limit: 200 } }), 'listNodeEvents')
    .items
}

/** Logs of remote-1's daemon container `scantor-node` since an ISO time. */
export async function remoteDaemonLogs(since: string): Promise<string> {
  const logs = await innerDocker.remote(['logs', '--since', since, 'scantor-node'])
  return logs.stdout + logs.stderr
}

/**
 * Replaces remote-1's daemon with the join command of a (rotated) token, exactly as the runner joined it
 * (tests/docker/join-remote-node.mjs): `docker run` inside the remote node with the test CA as SCANTOR_CA_CERT.
 * Then records the new token in remote-node.json, which other specs read.
 */
export async function rejoinRemoteDaemon(join: NodeJoin, token: string): Promise<void> {
  const match = /^docker run (.*) (\S+) node$/.exec(join.dockerRun.replace('${SCANTOR_NODE_TOKEN}', token))
  if (!match) throw new Error('unexpected join command shape')
  const caPem = await readFile(env.caCertFile, 'utf8')
  await innerDocker.remote(['rm', '-f', 'scantor-node'], { allowFailure: true })
  const started = await innerDocker.exec(CONTAINERS.remoteNode, ['sh', '-c', `docker run -e SCANTOR_CA_CERT ${match[1]} ${match[2]} node`], {
    env: { SCANTOR_CA_CERT: caPem },
  })
  if (started.exitCode !== 0) throw new Error(`starting remote-1's daemon failed: ${started.stderr.replaceAll(token, '<token>')}`)
  writeFileSync(env.paths.remoteNode, JSON.stringify({ ...readRemoteNode(), token }, null, 2), { mode: 0o600 })
}

// ── live credentials (SEC-024) ──────────────────────────────────────────────────────────────────────────

/** The better-auth session tokens of every storage state in tests/.auth (sessions of all runs that are still live). */
export function storedSessionTokens(): Record<string, string> {
  const tokens: Record<string, string> = {}
  for (const file of readdirSync(env.paths.auth)) {
    if (!file.endsWith('.json') || file === 'openapi.json' || file === 'authz.json') continue
    let state: { cookies?: { name: string; value: string }[] }
    try {
      state = JSON.parse(readFileSync(join(env.paths.auth, file), 'utf8')) as typeof state
    } catch {
      continue // a file another run is rewriting right now
    }
    for (const cookie of state.cookies ?? []) {
      if (cookie.name.includes('session_token')) tokens[`the session token of ${file}`] = decodeURIComponent(cookie.value).split('.')[0]!
    }
  }
  return tokens
}

/** Names of the containers of a dockerd that the suite did not create itself (label scantor.test=true). */
export async function platformContainers(run: (args: string[]) => Promise<{ stdout: string }>): Promise<string[]> {
  const { stdout } = await run(['ps', '-a', '--format', '{{.Names}}\t{{.Label "scantor.test"}}'])
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(([, testLabel]) => testLabel !== 'true')
    .map(([name]) => name!)
}
