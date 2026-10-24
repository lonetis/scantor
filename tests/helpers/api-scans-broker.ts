import { randomUUID } from 'node:crypto'
import type { ApiClient } from './api-client'
import { connectAsScan, EXCHANGES } from './amqp'
import { stackEnv } from './docker'

// Views of a scan's RabbitMQ objects for the lifecycle specs (docs/queue.md §3.3–§4.3, §8): the queue
// `scantor.scan.<id>` with its arguments and consumers, its binding, the user `scan-<id>` with its permissions. Every
// read is one request to the stack's RabbitMQ management API as its admin (published on the runner's loopback,
// SCANTOR_ADMIN_BIND_ADDRESS), fast enough to poll the order in which the user and the queue disappear. The write
// helpers only touch objects of the calling test: an orphan pair for the sweep test, a purge of the test's own scan
// queue and a delayed late result of the test's own scan.

const VHOST = 'scantor'

export const scanQueueName = (scanId: string) => `scantor.scan.${scanId}`
export const scanUserName = (scanId: string) => `scan-${scanId}`

/** One request to the management API as the stack's RabbitMQ admin; `body: null` for 404. */
async function management<T>(method: 'GET' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; body: T | null }> {
  const stack = stackEnv()
  const port = stack.SCANTOR_RABBITMQ_MANAGEMENT_PORT || '15672'
  const auth = Buffer.from(`${stack.SCANTOR_RABBITMQ_USER}:${stack.SCANTOR_RABBITMQ_PASSWORD}`).toString('base64')
  const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (response.status === 404) return { status: 404, body: null }
  if (!response.ok) throw new Error(`RabbitMQ management ${method} ${path}: ${response.status} ${await response.text()}`)
  const text = await response.text()
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as T) }
}

const queuePath = (scanId: string) => `/queues/${VHOST}/${encodeURIComponent(scanQueueName(scanId))}`
const userPath = (scanId: string) => `/users/${encodeURIComponent(scanUserName(scanId))}`

export interface ScanQueue {
  name: string
  type: string
  /** queue arguments by name (`x-delivery-limit`, `x-overflow`, …) */
  arguments: Record<string, unknown>
  /**
   * Whether the management API reports the queue's statistics yet: it omits the counts of a queue until their first
   * collection (seconds after the declare, more under load), and the counts below then read 0.
   */
  statsReported: boolean
  consumers: number
  messagesReady: number
  messagesUnacknowledged: number
  /** messages published with a future `x-opt-delivery-time` (retries waiting for their backoff) */
  messagesDelayed: number
}

interface RawQueue {
  name: string
  type: string
  arguments: Record<string, unknown>
  consumers?: number
  messages_ready?: number
  messages_unacknowledged?: number
  messages_delayed?: number
}

/** The scan's queue, or null when it does not exist. */
export async function scanQueue(scanId: string): Promise<ScanQueue | null> {
  const { body: raw } = await management<RawQueue>('GET', queuePath(scanId))
  if (!raw) return null
  return {
    name: raw.name,
    type: raw.type,
    arguments: raw.arguments,
    statsReported: raw.consumers !== undefined && raw.messages_ready !== undefined,
    consumers: raw.consumers ?? 0,
    messagesReady: raw.messages_ready ?? 0,
    messagesUnacknowledged: raw.messages_unacknowledged ?? 0,
    messagesDelayed: raw.messages_delayed ?? 0,
  }
}

/** Whether the RabbitMQ user `scan-<id>` exists. */
export async function scanUserExists(scanId: string): Promise<boolean> {
  return (await management('GET', userPath(scanId))).status !== 404
}

/**
 * Existence of the scan's queue and user, read in this order. Removal is final, so an observation `{queue: false,
 * user: true}` proves that the user outlived the queue (the reverse read order could not tell).
 */
export async function scanBrokerObjects(scanId: string): Promise<{ queue: boolean; user: boolean }> {
  const queue = (await scanQueue(scanId)) !== null
  const user = await scanUserExists(scanId)
  return { queue, user }
}

/** Bindings whose destination is the scan's queue (`{source, routingKey}`, the default exchange excluded). */
export async function scanQueueBindings(scanId: string): Promise<{ source: string; routingKey: string }[]> {
  const { body } = await management<{ source: string; routing_key: string }[]>('GET', `${queuePath(scanId)}/bindings`)
  return (body ?? []).filter((binding) => binding.source !== '').map((binding) => ({ source: binding.source, routingKey: binding.routing_key }))
}

/** Vhost permissions of the scan user (`{vhost, configure, write, read}`). */
export async function scanUserPermissions(scanId: string): Promise<{ vhost: string; configure: string; write: string; read: string }[]> {
  return (await management<{ vhost: string; configure: string; write: string; read: string }[]>('GET', `${userPath(scanId)}/permissions`)).body ?? []
}

/** Topic permissions of the scan user (one entry per exchange). */
export async function scanUserTopicPermissions(scanId: string): Promise<{ vhost: string; exchange: string; write: string; read: string }[]> {
  return (await management<{ vhost: string; exchange: string; write: string; read: string }[]>('GET', `${userPath(scanId)}/topic-permissions`)).body ?? []
}

/** Creates an orphan pair for the sweep test: the user `scan-<id>` and the quorum queue `scantor.scan.<id>`. */
export async function createOrphanScanObjects(fakeScanId: string, password: string): Promise<void> {
  await management('PUT', userPath(fakeScanId), { password, tags: '' })
  await management('PUT', queuePath(fakeScanId), { durable: true, auto_delete: false, arguments: { 'x-queue-type': 'quorum' } })
}

/**
 * Purges the scan's own queue as the scan's RabbitMQ user, ready and delayed messages included (a scan user may purge
 * its own queue, docs/queue.md §4.2). Stall detection then records the purged analyses as `lost` (docs/queue.md §9).
 */
export async function purgeOwnScanQueue(scanId: string): Promise<number> {
  const session = await connectAsScan(scanId)
  try {
    const { messageCount } = await session.channel.purgeQueue(scanQueueName(scanId))
    return messageCount
  } finally {
    await session.close()
  }
}

/** A late result: the broker hands it to the ingestor only at `deliverAt` (epoch ms). */
export interface DelayedResult {
  seq: number
  deliverAt: number
}

/**
 * Publishes, as the scan's RabbitMQ user (so the scan must still be active), one valid succeeded result of the
 * lifecycle task per entry, which the broker delivers to the ingest queue only at its `deliverAt`
 * (`x-opt-delivery-time`, docs/queue.md §3.3): results that reach the ingestor after their scan was deleted. The
 * messages are pipelined and confirmed together, so hundreds take well under a second; a refused one rejects.
 */
export async function publishDelayedResults(scanId: string, results: DelayedResult[]): Promise<void> {
  const session = await connectAsScan(scanId)
  // A refusal closes the channel with an error event; it is reported instead of the bare confirm failure.
  let refused: Error | undefined
  const onError = (error: Error) => void (refused = error)
  session.channel.on('error', onError)
  try {
    const now = Date.now()
    for (const { seq, deliverAt } of results) {
      const body = {
        v: 1,
        kind: 'result',
        analysisId: `${scanId}-${seq}`,
        scanId,
        seq,
        round: 1,
        attempt: 1,
        executionId: randomUUID(),
        workerId: randomUUID(),
        nodeId: randomUUID(),
        config: { value: seq },
        status: 'succeeded',
        result: { value: seq, attempt: 1, api_token_sha256: null, report: null },
        error: null,
        files: [],
        logTail: `late result published by the test for seq ${seq}\n`,
        timings: { scheduledAt: now, startedAt: now, finishedAt: now, durationMs: 0 },
      }
      session.channel.publish(EXCHANGES.results, scanId, Buffer.from(JSON.stringify(body)), {
        contentType: 'application/json',
        persistent: true,
        userId: session.user,
        type: 'result',
        messageId: randomUUID(),
        headers: { 'x-opt-delivery-time': deliverAt },
      })
    }
    try {
      await session.channel.waitForConfirms()
    } catch (error) {
      throw refused ?? error
    }
  } finally {
    session.channel.off('error', onError)
    await session.close()
  }
}

/** The sum of `scantor_ingest_messages_total{kind="result",outcome}` in the admin's metrics scrape. */
export async function ingestedResults(adminApi: ApiClient, outcome: string): Promise<number> {
  const response = await adminApi.call('getMetrics')
  if (response.status !== 200) throw new Error(`getMetrics answered ${response.status}`)
  let sum = 0
  for (const line of response.raw.toString('utf8').split('\n')) {
    const match = /^scantor_ingest_messages_total\{(.*)\}\s+(\S+)/.exec(line)
    if (match && match[1]!.includes('kind="result"') && match[1]!.includes(`outcome="${outcome}"`)) sum += Number(match[2])
  }
  return sum
}
