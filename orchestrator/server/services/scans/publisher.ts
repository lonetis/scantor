import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { ConfirmChannel, Message } from 'amqplib'
import { EXCHANGES } from '../../utils/amqp'

// Publishing analysis messages from the orchestrator (the scanRetryFailed job, docs/queue.md §5.1, §5.2, §8): one
// confirm channel, `mandatory`, `user_id` = the admin user. A nack means the scan queue is full (`x-overflow:
// reject-publish`): wait 2 s ± 20 % and republish only the nacked messages. A returned message means the queue
// (or its binding) does not exist yet: wait until the topology loop recreated it, then republish.

export interface AnalysisItem {
  seq: number
  config: unknown
}

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
  now?: () => number
}

export function analysisMessage(scanId: string, round: number, item: AnalysisItem, scheduledAt: number): Record<string, unknown> {
  return { v: 1, analysisId: `${scanId}-${item.seq}`, scanId, seq: item.seq, round, attempt: 1, config: item.config, scheduledAt }
}

function backpressureWait(): number {
  return Math.round(2000 * (0.8 + Math.random() * 0.4))
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

/** Publishes every item until the broker confirmed it into the scan queue. */
export async function publishAnalyses(channel: ConfirmChannel, items: AnalysisItem[], options: PublishOptions): Promise<void> {
  let remaining = items
  while (remaining.length > 0) {
    options.signal.throwIfAborted()
    const outcomes = await publishOnce(channel, remaining, options)
    const returned = outcomes.filter((outcome) => outcome.returned).map((outcome) => outcome.item)
    const nacked = outcomes.filter((outcome) => !outcome.returned && outcome.nacked).map((outcome) => outcome.item)
    if (returned.length > 0) await options.waitForQueue()
    else if (nacked.length > 0) await sleep((options.backoffMs ?? backpressureWait)(), options.signal)
    remaining = [...returned, ...nacked].sort((a, b) => a.seq - b.seq)
  }
}
