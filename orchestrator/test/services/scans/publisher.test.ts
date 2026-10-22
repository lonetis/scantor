import { EventEmitter } from 'node:events'
import type { ConfirmChannel, Message } from 'amqplib'
import { describe, expect, it } from 'vitest'
import { analysisMessage, publishAnalyses, type PublishOptions } from '../../../server/services/scans/publisher'

// The orchestrator's analysis publisher (docs/queue.md §5.1, §5.2, §8 "retry-failed publisher", §10): confirms,
// `mandatory`, `user_id` = the admin user; a nack (full queue) waits and republishes only the nacked messages, a
// returned message (no queue yet) waits for the queue.

type Outcome = 'ack' | 'nack' | 'return'

interface Published {
  exchange: string
  routingKey: string
  body: Record<string, unknown>
  options: Record<string, unknown>
}

/** A confirm channel whose broker answers each publish with the next scripted outcome for that seq. */
class FakeConfirmChannel extends EventEmitter {
  readonly published: Published[] = []

  constructor(private readonly script: Map<number, Outcome[]>) {
    super()
  }

  publish(exchange: string, routingKey: string, content: Buffer, options: Record<string, unknown>, callback: (error: unknown) => void): boolean {
    const body = JSON.parse(content.toString('utf8')) as Record<string, unknown>
    this.published.push({ exchange, routingKey, body, options })
    const outcome = this.script.get(body.seq as number)?.shift() ?? 'ack'
    queueMicrotask(() => {
      if (outcome === 'return') this.emit('return', { properties: { messageId: options.messageId } } as unknown as Message)
      callback(outcome === 'nack' ? new Error('nacked') : null)
    })
    return true
  }
}

function options(overrides: Partial<PublishOptions> = {}): PublishOptions {
  return {
    scanId: '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f',
    round: 2,
    userId: 'scantor',
    appId: 'scantor-orchestrator/1.4.0',
    signal: new AbortController().signal,
    waitForQueue: async () => {},
    backoffMs: () => 1,
    now: () => 1_761_040_805_000,
    ...overrides,
  }
}

describe('analysisMessage', () => {
  it('builds the v1 analysis message of a retried analysis', () => {
    expect(analysisMessage('s', 3, { seq: 7, config: { a: 1 } }, 1000)).toEqual({ v: 1, analysisId: 's-7', scanId: 's', seq: 7, round: 3, attempt: 1, config: { a: 1 }, scheduledAt: 1000 })
  })
})

describe('publishAnalyses', () => {
  it('publishes with confirms, mandatory, the admin user_id and the scan routing key', async () => {
    const channel = new FakeConfirmChannel(new Map())
    await publishAnalyses(channel as unknown as ConfirmChannel, [{ seq: 1, config: { x: 1 } }], options())
    expect(channel.published).toHaveLength(1)
    const [message] = channel.published
    expect(message).toMatchObject({
      exchange: 'scantor.analyses',
      routingKey: '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f',
      body: { v: 1, seq: 1, round: 2, attempt: 1, config: { x: 1 }, scheduledAt: 1_761_040_805_000 },
      options: { contentType: 'application/json', deliveryMode: 2, type: 'analysis', userId: 'scantor', appId: 'scantor-orchestrator/1.4.0', mandatory: true, timestamp: 1_761_040_805 },
    })
    expect(message!.options.messageId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('republishes only nacked messages after the backpressure wait', async () => {
    const channel = new FakeConfirmChannel(new Map([[2, ['nack', 'nack']], [3, ['nack']]]))
    let waits = 0
    await publishAnalyses(
      channel as unknown as ConfirmChannel,
      [1, 2, 3, 4].map((seq) => ({ seq, config: {} })),
      options({ backoffMs: () => (waits++, 1) }),
    )
    expect(channel.published.map((message) => message.body.seq)).toEqual([1, 2, 3, 4, 2, 3, 2])
    expect(waits).toBe(2)
    expect(new Set(channel.published.map((message) => message.options.messageId)).size).toBe(7)
  })

  it('waits for the queue when messages come back unrouted', async () => {
    const channel = new FakeConfirmChannel(new Map([[1, ['return']]]))
    let queueWaits = 0
    await publishAnalyses(channel as unknown as ConfirmChannel, [{ seq: 1, config: {} }, { seq: 2, config: {} }], options({ waitForQueue: async () => void queueWaits++ }))
    expect(channel.published.map((message) => message.body.seq)).toEqual([1, 2, 1])
    expect(queueWaits).toBe(1)
  })

  it('stops when aborted', async () => {
    const controller = new AbortController()
    const channel = new FakeConfirmChannel(new Map([[1, ['nack', 'nack', 'nack']]]))
    const promise = publishAnalyses(channel as unknown as ConfirmChannel, [{ seq: 1, config: {} }], options({ signal: controller.signal, backoffMs: () => 10_000 }))
    setTimeout(() => controller.abort(new Error('stop')), 20)
    await expect(promise).rejects.toThrow('stop')
  })
})
