import { EventEmitter } from 'node:events'
import type { Channel, ConfirmChannel, Message } from 'amqplib'
import { describe, expect, it, vi } from 'vitest'
import {
  analysisMessage,
  publishAnalyses,
  type PublishOptions,
  type QueueReading,
  QueueReadyReader,
  SHARE_FALLBACK_CREDIT,
} from '../../../server/services/scans/publisher'
import type { Logger } from '../../../server/utils/logger'

// The orchestrator's analysis publisher (docs/queue.md §5.1, §5.2, §8 "retry-failed publisher", §10): confirms,
// `mandatory`, `user_id` = the admin user; a nack (full queue) waits and republishes only the nacked messages, a
// returned message (no queue yet) waits for the queue; with a share it keeps at most half of the queue's
// `x-max-length`, like the scheduler (docs/runtime.md §11.4).

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

/** A share whose ready counts come from a script; each read records how many messages were published before it. */
function scriptedShare(channel: FakeConfirmChannel, maxLength: number, readings: QueueReading[]) {
  const publishedAtRead: number[] = []
  let polls = 0
  const share = {
    maxLength,
    readReady: async () => {
      publishedAtRead.push(channel.published.length)
      if (readings.length === 0) throw new Error('unexpected read')
      return readings.shift()!
    },
    pollMs: () => (polls++, 1),
  }
  return { share, publishedAtRead, polls: () => polls }
}

const items = (count: number) => Array.from({ length: count }, (_, seq) => ({ seq, config: {} }))

describe('publishAnalyses with the share of the queue', () => {
  it('publishes slices of the free half of the queue and waits while less than a fifth of it is free', async () => {
    const channel = new FakeConfirmChannel(new Map())
    // maxLength 20: share 10, reopened at 2 free.
    const { share, publishedAtRead, polls } = scriptedShare(channel, 20, [0, 10, 9, 0, 3])
    await publishAnalyses(channel as unknown as ConfirmChannel, items(25), options({ share }))

    expect(publishedAtRead).toEqual([0, 10, 10, 10, 20])
    expect(channel.published.map((message) => message.body.seq)).toEqual(items(25).map((item) => item.seq))
    expect(polls()).toBe(2)
  })

  it('publishes a short rest once the free part covers it, even below a fifth of the share', async () => {
    const channel = new FakeConfirmChannel(new Map())
    const { share, publishedAtRead } = scriptedShare(channel, 1000, [497])
    await publishAnalyses(channel as unknown as ConfirmChannel, items(3), options({ share }))
    expect(publishedAtRead).toEqual([0])
    expect(channel.published).toHaveLength(3)
  })

  it('waits for a missing queue and falls back to one window when the ready count cannot be read', async () => {
    const channel = new FakeConfirmChannel(new Map())
    let queueWaits = 0
    const { share, publishedAtRead } = scriptedShare(channel, 100_000, ['missing', null, 0])
    await publishAnalyses(channel as unknown as ConfirmChannel, items(SHARE_FALLBACK_CREDIT + 10), options({ share, waitForQueue: async () => void queueWaits++ }))

    expect(queueWaits).toBe(1)
    expect(publishedAtRead).toEqual([0, 0, SHARE_FALLBACK_CREDIT])
    expect(channel.published).toHaveLength(SHARE_FALLBACK_CREDIT + 10)
  })

  it('republishes nacked messages within the share', async () => {
    const channel = new FakeConfirmChannel(new Map([[1, ['nack']]]))
    const { share, publishedAtRead } = scriptedShare(channel, 8, [0, 0])
    await publishAnalyses(channel as unknown as ConfirmChannel, items(6), options({ share }))
    // Share 4: seqs 0–3, then the nacked seq 1 first, with 4 and 5.
    expect(channel.published.map((message) => message.body.seq)).toEqual([0, 1, 2, 3, 1, 4, 5])
    expect(publishedAtRead).toEqual([0, 4])
  })
})

class FakeReadChannel extends EventEmitter {
  closed = false
  constructor(private readonly answer: () => Promise<{ messageCount: number }>) {
    super()
  }

  checkQueue() {
    return this.answer()
  }

  async close() {
    this.closed = true
  }
}

describe('QueueReadyReader', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

  function reader(answers: (() => Promise<{ messageCount: number }>)[]) {
    const channels: FakeReadChannel[] = []
    const connection = {
      async createChannel() {
        const channel = new FakeReadChannel(answers.shift()!)
        channels.push(channel)
        return channel as unknown as Channel
      },
    }
    return { reader: new QueueReadyReader(connection, 'scantor.scan.s', log), channels }
  }

  it('reads the ready count, reports a missing queue and opens a new channel after the broker closed one', async () => {
    const notFound = Object.assign(new Error('NOT_FOUND - no queue'), { code: 404 })
    const { reader: ready, channels } = reader([async () => ({ messageCount: 7 }), async () => Promise.reject(notFound), async () => ({ messageCount: 0 })])
    expect(await ready.read()).toBe(7)
    expect(await ready.read()).toBe(7)
    expect(channels).toHaveLength(1)

    // A missing queue: the broker closes the channel (the listener keeps its error from being thrown).
    channels[0]!.closed = true
    channels[0]!.emit('error', notFound)
    channels[0]!.emit('close')
    expect(await ready.read()).toBe('missing')
    expect(await ready.read()).toBe(0)
    expect(channels).toHaveLength(3)
  })

  it('answers null and closes the channel when the read fails otherwise', async () => {
    const { reader: ready, channels } = reader([async () => Promise.reject(new Error('connection closed'))])
    expect(await ready.read()).toBeNull()
    expect(channels[0]!.closed).toBe(true)
    expect(log.warn).toHaveBeenCalledWith('reading the ready count of the scan queue failed', expect.objectContaining({ queue: 'scantor.scan.s' }))
  })
})
