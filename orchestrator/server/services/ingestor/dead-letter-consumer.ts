import type { ConsumeMessage } from 'amqplib'
import type { Config } from '../../utils/config'
import { GLOBAL_QUEUES } from '../../utils/amqp'
import { deadLetters } from '../metrics/catalogue'
import { analysisId, type DeathInfo } from './build-document'
import { authenticateResultMessage, parseJsonObject, scanIdOfUserId } from './identity'
import { deadLetterItem, messageItem } from './items'
import { checkAnalysisMessage } from './messages'
import type { BatchProcessor } from './processor'
import { type Delivery, QueueConsumer, type QueueConsumerOptions } from './queue-consumer'
import type { RejectionEvents } from './security-events'
import { BatchWriteError, isTransientMongoError } from './writer'

/*
 * The dead-letter consumer on scantor.dead.ingest (docs/queue.md §7), one message at a time. The source comes from
 * the broker-set `x-first-death-*` headers, which a publisher cannot forge:
 *
 *   scantor.scan.<id>, delivery_limit  → the analysis killed every worker that received it: failed / `crash`
 *   scantor.scan.<id>, other reason    → failed / `platform` "dead-lettered (<reason>)"
 *   scantor.results.ingest, rejected   → security.ingestRejected event (rate-limited), nothing else is written
 *   scantor.results.ingest, delivery_limit → processed alone through the normal path (isolated)
 *   anything else                      → logged and acknowledged
 *
 * Writes use the same guarded upserts as results, so a crash record never overwrites a real result. Transient
 * MongoDB failures nack, back off and consume again; every other outcome is acknowledged.
 */

export const DEAD_LETTER_PREFETCH = 50
const SCAN_QUEUE_PREFIX = 'scantor.scan.'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type DeadLetterConfig = Pick<Config, 'deliveryLimit' | 'maxResultBytes' | 'rabbitmqUser'>

function header(message: ConsumeMessage, name: string): unknown {
  return (message.properties.headers as Record<string, unknown> | undefined)?.[name]
}

function headerText(message: ConsumeMessage, name: string): string {
  const value = header(message, name)
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

function headerCount(message: ConsumeMessage, name: string): number | null {
  const value = header(message, name)
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export class DeadLetterConsumer extends QueueConsumer {
  private chain: Promise<void> = Promise.resolve()

  constructor(
    options: Omit<QueueConsumerOptions, 'queue' | 'prefetch'>,
    private readonly config: DeadLetterConfig,
    private readonly processor: BatchProcessor,
    private readonly rejections: RejectionEvents,
  ) {
    super({ ...options, queue: GLOBAL_QUEUES.deadIngest, prefetch: DEAD_LETTER_PREFETCH })
  }

  protected onDelivery(delivery: Delivery): void {
    this.chain = this.chain
      .then(() => this.handle(delivery))
      .catch((error: unknown) => this.log.error('dead-letter handling failed', { err: error }))
  }

  protected onDeliveriesReturned(): void {
    // Deliveries are processed one at a time from the chain; returned ones are skipped by isCurrent.
  }

  protected async drain(): Promise<void> {
    await this.chain
  }

  private async handle(delivery: Delivery): Promise<void> {
    if (!this.isCurrent(delivery) || this.backingOff) return
    try {
      await this.dispatch(delivery.message)
    } catch (error) {
      const transient = error instanceof BatchWriteError ? error.transient : isTransientMongoError(error)
      if (transient && !this.stopped) {
        this.log.warn('dead letter could not be written; backing off', { err: error })
        await this.recoverFromFailure()
        return
      }
      this.log.error('dead letter could not be handled; acknowledged', { err: error })
    }
    this.ack(delivery)
  }

  private async dispatch(message: ConsumeMessage): Promise<void> {
    const queue = headerText(message, 'x-first-death-queue')
    const reason = headerText(message, 'x-first-death-reason') || 'unknown'
    if (queue.startsWith(SCAN_QUEUE_PREFIX)) {
      deadLetters.inc({ source: 'scan', reason })
      await this.scanDeadLetter(message, queue.slice(SCAN_QUEUE_PREFIX.length), reason)
      return
    }
    if (queue === GLOBAL_QUEUES.resultsIngest) {
      deadLetters.inc({ source: 'results', reason })
      if (reason === 'rejected') await this.rejectedResult(message)
      else if (reason === 'delivery_limit') await this.unackedResult(message)
      else this.log.error('unexpected dead-letter reason for a result message', { reason })
      return
    }
    this.log.error('dead letter from an unexpected source; acknowledged', { queue: queue.slice(0, 200), reason })
  }

  /** An analysis message dead-lettered by its scan queue. */
  private async scanDeadLetter(message: ConsumeMessage, scanId: string, reason: string): Promise<void> {
    const userId: unknown = message.properties.userId
    const validUser =
      userId === undefined || userId === null || userId === this.config.rabbitmqUser || (typeof userId === 'string' && scanIdOfUserId(userId) === scanId)
    if (!UUID.test(scanId) || message.fields.routingKey !== scanId || !validUser) {
      this.log.error('dead-lettered analysis with an inconsistent identity; dropped', { reason })
      return
    }
    const parsed = parseJsonObject(message.content)
    if (!parsed.ok) {
      this.log.error('dead-lettered analysis is not a JSON object; dropped', { scanId, problem: parsed.reason })
      return
    }
    const checked = checkAnalysisMessage(parsed.body)
    if (!checked.ok) {
      this.log.error('dead-lettered analysis is not a valid analysis message; dropped', { scanId, problem: checked.error })
      return
    }
    const analysis = checked.value
    if (analysis.scanId !== scanId || analysis.analysisId !== analysisId(scanId, analysis.seq)) {
      this.log.error('dead-lettered analysis belongs to another scan; dropped', { scanId })
      return
    }
    const death: DeathInfo = {
      reason,
      queue: `${SCAN_QUEUE_PREFIX}${scanId}`,
      deliveryCount: headerCount(message, 'x-delivery-count'),
      acquiredCount: headerCount(message, 'x-acquired-count'),
    }
    const result = await this.processor.process([deadLetterItem(analysis, death, this.config.deliveryLimit)])
    await this.processor.finish(result)
  }

  /** A result message the result consumer rejected (checks 1–3): only a rate-limited security event. */
  private async rejectedResult(message: ConsumeMessage): Promise<void> {
    const identity = authenticateResultMessage(message)
    const reason = identity.ok ? 'unknown' : identity.reason
    const userId: unknown = message.properties.userId
    await this.rejections.record(reason, message.fields.routingKey, typeof userId === 'string' ? userId : null)
  }

  /** A result delivered four times without an ack (repeated orchestrator crashes): processed alone. */
  private async unackedResult(message: ConsumeMessage): Promise<void> {
    const identity = authenticateResultMessage(message)
    if (!identity.ok) {
      this.log.warn('dead-lettered result message is not attributable; dropped', { reason: identity.reason })
      return
    }
    const item = messageItem(identity.message, this.config)
    const result = await this.processor.process([item], new Set([analysisId(item.scanId, item.seq)]))
    await this.processor.finish(result)
  }
}
