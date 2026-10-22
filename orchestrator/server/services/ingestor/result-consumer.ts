import type { Config } from '../../utils/config'
import { GLOBAL_QUEUES } from '../../utils/amqp'
import { ingestMessages, ingestWholeBatchFailures } from '../metrics/catalogue'
import { analysisId } from './build-document'
import { authenticateResultMessage } from './identity'
import { type IngestItem, messageItem } from './items'
import type { BatchProcessor } from './processor'
import { type Delivery, QueueConsumer, type QueueConsumerOptions } from './queue-consumer'

/*
 * The result consumer on scantor.results.ingest (docs/queue.md §6.1–§6.7). Checks 1–3 run on arrival and reject
 * unauthenticated or malformed messages to scantor.dead (security events are written by the dead-letter consumer).
 * Everything else joins the current batch, which flushes at SCANTOR_INGEST_BATCH_SIZE messages,
 * SCANTOR_INGEST_BATCH_MAX_BYTES of bodies, or SCANTOR_INGEST_FLUSH_INTERVAL after its first message. Exactly one
 * flush runs at a time; deliveries arriving meanwhile form the next batch (bounded by the prefetch). A flush acks
 * with one cumulative ack after MongoDB acknowledged the writes. A whole-batch failure nacks everything and backs off;
 * three such failures in a row while MongoDB is healthy switch the failing messages to isolation mode.
 */

export const ISOLATION_AFTER_FAILURES = 3

interface Pending {
  delivery: Delivery
  item: IngestItem
}

export type ResultConsumerConfig = Pick<Config, 'ingestPrefetch' | 'ingestBatchSize' | 'ingestBatchMaxBytes' | 'ingestFlushIntervalMs' | 'maxResultBytes'>

export class ResultConsumer extends QueueConsumer {
  private pending: Pending[] = []
  private pendingBytes = 0
  private timer: NodeJS.Timeout | null = null
  private flushing: Promise<void> | null = null
  private flushRequested = false
  private healthyFailures = 0
  /** analysis ids written one per bulkWrite until they were processed once */
  private readonly isolate = new Set<string>()

  constructor(
    options: Omit<QueueConsumerOptions, 'queue' | 'prefetch'>,
    private readonly config: ResultConsumerConfig,
    private readonly processor: BatchProcessor,
  ) {
    super({ ...options, queue: GLOBAL_QUEUES.resultsIngest, prefetch: config.ingestPrefetch })
  }

  protected onDelivery(delivery: Delivery): void {
    const identity = authenticateResultMessage(delivery.message)
    if (!identity.ok) {
      this.reject(delivery)
      const type = delivery.message.properties.type
      ingestMessages.inc({ kind: type === 'attempt' ? 'attempt' : 'result', outcome: 'rejected' })
      this.log.debug('rejected an unauthenticated or malformed result message', { reason: identity.reason })
      return
    }
    this.pending.push({ delivery, item: messageItem(identity.message, this.config) })
    this.pendingBytes += identity.message.bytes
    if (this.pending.length === 1) this.timer = setTimeout(() => this.requestFlush(), this.config.ingestFlushIntervalMs)
    if (this.pending.length >= this.config.ingestBatchSize || this.pendingBytes >= this.config.ingestBatchMaxBytes) this.requestFlush()
  }

  protected onDeliveriesReturned(): void {
    this.takeBatch()
  }

  protected async drain(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.flushing
  }

  private takeBatch(): Pending[] {
    const batch = this.pending
    this.pending = []
    this.pendingBytes = 0
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    return batch
  }

  private requestFlush(): void {
    if (this.flushing) {
      this.flushRequested = true
      return
    }
    this.flushing = (async () => {
      try {
        do {
          this.flushRequested = false
          await this.flushOnce()
        } while (this.flushRequested && !this.stopped && !this.backingOff)
      } catch (error) {
        // flushOnce settles every delivery itself; reaching this means a bug, and the broker redelivers whatever
        // stays unacknowledged when the channel closes.
        this.log.error('ingest flush failed unexpectedly', { err: error })
      } finally {
        this.flushing = null
      }
    })()
  }

  private async flushOnce(): Promise<void> {
    // Deliveries of a channel that closed meanwhile are back in the queue already.
    const batch = this.takeBatch().filter((entry) => this.isCurrent(entry.delivery))
    if (batch.length === 0) return
    const items = batch.map((entry) => entry.item)
    let result
    try {
      result = await this.processor.process(items, this.isolate)
    } catch (error) {
      await this.wholeBatchFailed(items, error)
      return
    }
    for (const item of items) this.isolate.delete(analysisId(item.scanId, item.seq))
    this.ack(batch.at(-1)!.delivery, true)
    this.healthyFailures = 0
    await this.processor.finish(result)
  }

  private async wholeBatchFailed(items: readonly IngestItem[], error: unknown): Promise<void> {
    if (this.stopped) return
    ingestWholeBatchFailures.inc()
    this.log.warn('ingest batch failed as a whole; nacking it and backing off', { messages: items.length, err: error })
    const healthy = await this.recoverFromFailure()
    if (!healthy) {
      this.healthyFailures = 0
      return
    }
    this.healthyFailures += 1
    if (this.healthyFailures >= ISOLATION_AFTER_FAILURES) {
      this.healthyFailures = 0
      for (const item of items) this.isolate.add(analysisId(item.scanId, item.seq))
      this.log.warn('isolation mode: the failing messages are written one by one on their next delivery', { messages: items.length })
    }
  }
}
