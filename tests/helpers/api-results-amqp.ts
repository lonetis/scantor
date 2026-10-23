import { randomUUID } from 'node:crypto'
import type { Channel } from 'amqplib'
import type { AmqpSession } from './amqp'
import { stackEnv } from './docker'
import { innerDocker } from './docker'
import { rabbitManagementUrl } from './api-results'

// Hand-built AMQP messages and broker probes for the ingestion security specs (security/cross-scan.spec.ts): result
// and analysis bodies as a runtime would publish them (docs/queue.md §5), refusals observed on throwaway channels,
// the admin-only security events and the RabbitMQ management API as the stack's admin.

export interface ResultOverrides {
  [key: string]: unknown
}

/** A schema-valid succeeded result message of `scanId` for `seq` (round 1, attempt 1); fields can be overridden. */
export function resultMessage(scanId: string, seq: number, overrides: ResultOverrides = {}): Record<string, unknown> {
  const now = Date.now()
  return {
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
    config: { item: `item-${seq}`, index: seq },
    status: 'succeeded',
    result: { value: `value-${seq}` },
    error: null,
    files: [],
    logTail: `published by the test for seq ${seq}\n`,
    timings: { scheduledAt: now, startedAt: now, finishedAt: now, durationMs: 0 },
    ...overrides,
  }
}

/** An analysis message of `scanId` for `seq` (round 1, attempt 1) as the scheduler publishes it. */
export function analysisMessage(scanId: string, seq: number, overrides: ResultOverrides = {}): Record<string, unknown> {
  return {
    v: 1,
    analysisId: `${scanId}-${seq}`,
    scanId,
    seq,
    round: 1,
    attempt: 1,
    config: { item: `item-${seq}`, index: seq },
    scheduledAt: Date.now(),
    ...overrides,
  }
}

export interface ChannelRefusal {
  /** the AMQP reply code the broker closed the channel with (403 ACCESS_REFUSED, 406 PRECONDITION_FAILED, …) */
  code: number | undefined
  message: string
}

/**
 * Runs `operation` on a new plain channel of the session's connection and returns how the broker closed the channel.
 * Throws when the operation succeeds (and the channel stays open). The connection survives a channel error.
 */
export async function channelRefusal(session: AmqpSession, operation: (channel: Channel) => Promise<unknown>): Promise<ChannelRefusal> {
  const channel = await session.connection.createChannel()
  const closed = new Promise<ChannelRefusal>((resolve) => {
    channel.once('error', (error: Error & { code?: number }) => resolve({ code: error.code, message: error.message }))
  })
  let outcome: ChannelRefusal | 'succeeded'
  try {
    await operation(channel)
    // A publish on a plain channel resolves at once; the broker's refusal arrives as a channel error.
    outcome = await Promise.race([closed, new Promise<'succeeded'>((resolve) => setTimeout(() => resolve('succeeded'), 2000))])
  } catch (error) {
    outcome = await Promise.race([closed, Promise.resolve({ code: (error as { code?: number }).code, message: String(error) })])
  }
  if (outcome === 'succeeded') {
    await channel.close()
    throw new Error('the broker accepted the operation')
  }
  return outcome
}

// ── security events (admin-only, userId null) ────────────────────────────────────────────────────────

export interface SecurityEvent {
  type: string
  userId: string | null
  scanId?: string
  message: string
  data: { reason: string; routingKey: string; userIdProperty: string | null }
}

/** The `security.ingestRejected` events whose routing key is `routingKey` (white-box: no API lists them). */
export async function ingestRejectedEvents(routingKey: string): Promise<SecurityEvent[]> {
  const out = await innerDocker.mongosh(
    `print(EJSON.stringify(db.events.find({ type: 'security.ingestRejected', 'data.routingKey': ${JSON.stringify(routingKey)} }, { _id: 0, at: 0 }).toArray(), { relaxed: true }))`,
    { as: 'root' },
  )
  return JSON.parse(out) as SecurityEvent[]
}

// ── RabbitMQ management API as the stack's admin ─────────────────────────────────────────────────────

/** A request to the management API as the stack's RabbitMQ admin. */
export async function rabbitManagement(method: 'GET' | 'DELETE', path: string): Promise<{ status: number; body: unknown }> {
  const stack = stackEnv()
  const credentials = Buffer.from(`${stack.SCANTOR_RABBITMQ_USER!}:${stack.SCANTOR_RABBITMQ_PASSWORD!}`).toString('base64')
  const response = await fetch(rabbitManagementUrl(path), { method, headers: { Authorization: `Basic ${credentials}` } })
  const text = await response.text()
  let body: unknown = text
  try {
    body = text === '' ? null : JSON.parse(text)
  } catch {
    // not JSON: keep the text
  }
  return { status: response.status, body }
}
