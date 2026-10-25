import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { Channel, ConfirmChannel, Message } from 'amqplib'
import { EXCHANGES } from '../../utils/amqp'
import type { Logger } from '../../utils/logger'

// Publishing analysis messages from the orchestrator (the scanRetryFailed job, docs/queue.md §5.1, §5.2, §8): one
// confirm channel, `mandatory`, `user_id` = the admin user. A nack means the scan queue is full (`x-overflow:
// reject-publish`): wait 2 s ± 20 % and republish only the nacked messages. A returned message means the queue
// (or its binding) does not exist yet: wait until the topology loop recreated it, then republish.
//
// Like the scheduler (docs/runtime.md §11.4), the publisher keeps at most half of the queue's `x-max-length` (the
// share): delayed retries count toward the limit and a full queue refuses them, so the other half is left to the
// retries of the runners. Before each slice it reads the ready count (a passive queue.declare; a quorum queue counts
// neither delayed nor unacknowledged messages there) and publishes at most `share − ready` items, once that is at
// least a fifth of the share; meanwhile it reads again every 250 ms ± 20 %.

export interface AnalysisItem {
  seq: number
  config: unknown
}

/** The ready count of the scan queue, 'missing' when the queue does not exist, null when it cannot be read. */
export type QueueReading = number | 'missing' | null

export interface QueueShare {
  /** the scan queue's `x-max-length` (SCANTOR_SCAN_QUEUE_MAX_READY); the publisher keeps at most half of it */
  maxLength: number
  readReady: () => Promise<QueueReading>
  /** wait between reads while the share is used up (default 250 ms ± 20 %) */
  pollMs?: () => number
}

/** Items one slice may publish when the ready count cannot be read: one scheduler window, so only the broker's limit applies. */
export const SHARE_FALLBACK_CREDIT = 512

export interface PublishOptions {
  scanId: string
  round: number
  /** the admin user name: the broker validates `user_id` against the connection's user */
  userId: string
  /** `scantor-orchestrator/<version>` */
  appId: string
  signal: AbortSignal
  /** resolves once the scan queue exists (called after messages were returned) */
  waitForQueue: () => Promise<void>
  /** backpressure wait after nacks (default 2 s ± 20 %) */
  backoffMs?: () => number
  /** keep at most half of the queue (docs/runtime.md §11.4); without it only the broker's limit applies */
  share?: QueueShare
  now?: () => number
}

export function analysisMessage(scanId: string, round: number, item: AnalysisItem, scheduledAt: number): Record<string, unknown> {
  return { v: 1, analysisId: `${scanId}-${item.seq}`, scanId, seq: item.seq, round, attempt: 1, config: item.config, scheduledAt }
}

function backpressureWait(): number {
  return Math.round(2000 * (0.8 + Math.random() * 0.4))
}

function sharePollWait(): number {
  return Math.round(250 * (0.8 + Math.random() * 0.4))
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

interface Outcome {
  item: AnalysisItem
  nacked: boolean
  returned: boolean
}

async function publishOnce(channel: ConfirmChannel, items: AnalysisItem[], options: PublishOptions): Promise<Outcome[]> {
  const returned = new Set<string>()
  const onReturn = (message: Message) => {
    const id = message.properties.messageId as string | undefined
    if (id) returned.add(id)
  }
  channel.on('return', onReturn)
  try {
    const now = (options.now ?? Date.now)()
    const pending: Promise<{ item: AnalysisItem; messageId: string; nacked: boolean }>[] = []
    for (const item of items) {
      const messageId = randomUUID()
      const body = Buffer.from(JSON.stringify(analysisMessage(options.scanId, options.round, item, now)), 'utf8')
      let written = true
      pending.push(
        new Promise((resolve) => {
          written = channel.publish(
            EXCHANGES.analyses,
            options.scanId,
            body,
            {
              contentType: 'application/json',
              deliveryMode: 2,
              type: 'analysis',
              messageId,
              userId: options.userId,
              appId: options.appId,
              timestamp: Math.floor(now / 1000),
              mandatory: true,
            },
            (error: unknown) => resolve({ item, messageId, nacked: Boolean(error) }),
          )
        }),
      )
      // The socket buffer is full: wait until it drained before writing more (configs are up to 64 KiB each).
      if (!written) await once(channel, 'drain', { signal: options.signal })
    }
    const results = await Promise.all(pending)
    return results.map((result) => ({ item: result.item, nacked: result.nacked, returned: returned.has(result.messageId) }))
  } finally {
    channel.off('return', onReturn)
  }
}

/**
 * How many of `wanted` items may be published now (all of them without a share): the free part of the share once it
 * is at least a fifth of the share (or `wanted`, when fewer are left), waiting while it is not.
 */
export async function shareCredit(wanted: number, options: Pick<PublishOptions, 'share' | 'signal' | 'waitForQueue'>): Promise<number> {
  const share = options.share
  const limit = share ? Math.floor(share.maxLength / 2) : 0
  if (!share || limit <= 0) return wanted
  const reopenAt = Math.min(wanted, Math.max(1, Math.ceil(limit / 5)))
  for (;;) {
    options.signal.throwIfAborted()
    const ready = await share.readReady()
    if (ready === null) return Math.min(wanted, SHARE_FALLBACK_CREDIT)
    if (ready === 'missing') {
      // The management API can still list a queue that was just deleted, so wait between reads in any case.
      await options.waitForQueue()
      await sleep((share.pollMs ?? sharePollWait)(), options.signal)
      continue
    }
    const free = limit - ready
    if (free >= reopenAt) return Math.min(wanted, free)
    await sleep((share.pollMs ?? sharePollWait)(), options.signal)
  }
}

/** Publishes every item until the broker confirmed it into the scan queue. */
export async function publishAnalyses(channel: ConfirmChannel, items: AnalysisItem[], options: PublishOptions): Promise<void> {
  let remaining = items
  while (remaining.length > 0) {
    options.signal.throwIfAborted()
    const credit = await shareCredit(remaining.length, options)
    const outcomes = await publishOnce(channel, remaining.slice(0, credit), options)
    const returned = outcomes.filter((outcome) => outcome.returned).map((outcome) => outcome.item)
    const nacked = outcomes.filter((outcome) => !outcome.returned && outcome.nacked).map((outcome) => outcome.item)
    if (returned.length > 0) await options.waitForQueue()
    else if (nacked.length > 0) await sleep((options.backoffMs ?? backpressureWait)(), options.signal)
    remaining = [...returned, ...nacked, ...remaining.slice(credit)].sort((a, b) => a.seq - b.seq)
  }
}

/**
 * Reads the ready count of one queue with a passive queue.declare on a channel of its own: a missing queue makes
 * the broker close that channel, so the next read opens a new one.
 */
export class QueueReadyReader {
  private channel: Channel | null = null

  constructor(
    private readonly connection: { createChannel(): Promise<Channel> },
    private readonly queue: string,
    private readonly log: Logger,
  ) {}

  async read(): Promise<QueueReading> {
    try {
      const channel = this.channel ?? (await this.open())
      return (await channel.checkQueue(this.queue)).messageCount
    } catch (error) {
      // 404 NOT_FOUND: the broker closed the channel; after any other failure the channel is not trusted either.
      if ((error as { code?: unknown }).code === 404) {
        this.channel = null
        return 'missing'
      }
      this.log.warn('reading the ready count of the scan queue failed', { queue: this.queue, err: error })
      await this.close()
      return null
    }
  }

  private async open(): Promise<Channel> {
    const channel = await this.connection.createChannel()
    // The broker closes the channel on a missing queue; without a listener that error would be thrown.
    channel.on('error', (error: Error) => this.log.debug('the queue read channel closed', { queue: this.queue, err: error }))
    channel.on('close', () => {
      if (this.channel === channel) this.channel = null
    })
    this.channel = channel
    return channel
  }

  async close(): Promise<void> {
    const channel = this.channel
    this.channel = null
    await channel?.close().catch((error: unknown) => this.log.debug('closing the queue read channel failed', { queue: this.queue, err: error }))
  }
}
