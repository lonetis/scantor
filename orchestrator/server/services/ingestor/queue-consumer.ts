import type { Channel, ConsumeMessage } from 'amqplib'
import type { Logger } from '../../utils/logger'

/*
 * The AMQP side shared by the ingestor's two consumers (docs/queue.md §6.1, §6.6, §7): one channel with a prefetch
 * on the ingestor's connection, reopened whenever it closes (the recovering connection waits for the broker), and
 * the whole-batch failure protocol: cancel the consumer, nack every outstanding delivery with requeue (not counted
 * toward the delivery limit), back off 1 s → 30 s (×2, full jitter) until MongoDB answers as a writable primary,
 * then consume again. Deliveries carry the generation of their channel; settling a delivery of a closed channel is
 * skipped, because the broker already returned it to the queue.
 */

export interface Delivery {
  message: ConsumeMessage
  /** the channel the delivery arrived on */
  generation: number
  /** incremented whenever every outstanding delivery was nacked, which invalidates their delivery tags */
  epoch: number
}

export interface QueueConsumerOptions {
  connection: { createChannel(): Promise<Channel> }
  queue: string
  prefetch: number
  consumerTag: string
  log: Logger
  /** true when MongoDB answers as a writable primary */
  pingWritable: () => Promise<boolean>
}

const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 30_000
const RECONSUME_DELAY_MS = 5000

function fullJitter(delay: number): number {
  return Math.floor(Math.random() * delay)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export abstract class QueueConsumer {
  protected readonly log: Logger
  private channel: Channel | null = null
  private generation = 0
  private epoch = 0
  private consuming = false
  private opening: Promise<void> | null = null
  protected stopped = true
  /** true while recovering from a whole-batch failure */
  protected backingOff = false

  constructor(protected readonly options: QueueConsumerOptions) {
    this.log = options.log
  }

  /** Handles one delivery of the current channel. */
  protected abstract onDelivery(delivery: Delivery): void

  /** The channel was lost or every outstanding delivery was requeued: forget unsettled deliveries. */
  protected abstract onDeliveriesReturned(): void

  /** Waits for in-flight processing before the channel closes (stop). */
  protected abstract drain(): Promise<void>

  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    await this.open()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    const channel = this.channel
    if (channel && this.consuming) {
      await channel.cancel(this.options.consumerTag).catch((error: unknown) => this.log.debug('cancelling the consumer failed', { err: error }))
    }
    this.consuming = false
    await this.drain()
    this.channel = null
    await channel?.close().catch((error: unknown) => this.log.debug('closing the channel failed', { err: error }))
  }

  /** True when `delivery` belongs to the open channel. */
  protected isCurrent(delivery: Delivery): boolean {
    return this.channel !== null && delivery.generation === this.generation && delivery.epoch === this.epoch
  }

  protected ack(delivery: Delivery, allUpTo = false): void {
    if (!this.isCurrent(delivery)) return
    try {
      this.channel!.ack(delivery.message, allUpTo)
    } catch (error) {
      this.log.debug('ack failed; the broker redelivers', { err: error })
    }
  }

  protected reject(delivery: Delivery): void {
    if (!this.isCurrent(delivery)) return
    try {
      this.channel!.reject(delivery.message, false)
    } catch (error) {
      this.log.debug('reject failed; the broker redelivers', { err: error })
    }
  }

  private open(): Promise<void> {
    this.opening ??= this.openLoop().finally(() => {
      this.opening = null
    })
    return this.opening
  }

  private async openLoop(): Promise<void> {
    let delay = BACKOFF_MIN_MS
    while (!this.stopped) {
      try {
        const channel = await this.options.connection.createChannel()
        const generation = ++this.generation
        channel.on('close', () => this.channelClosed(generation))
        channel.on('error', (error: unknown) => this.log.warn('ingest channel error', { queue: this.options.queue, err: error }))
        await channel.prefetch(this.options.prefetch)
        this.channel = channel
        if (!this.backingOff) await this.consume()
        return
      } catch (error) {
        this.log.warn('opening the consumer failed; retrying', { queue: this.options.queue, err: error })
        await sleep(BACKOFF_MIN_MS + fullJitter(delay))
        delay = Math.min(BACKOFF_MAX_MS, delay * 2)
      }
    }
  }

  private channelClosed(generation: number): void {
    if (generation !== this.generation) return
    this.channel = null
    this.consuming = false
    this.onDeliveriesReturned()
    if (this.stopped) return
    this.log.warn('ingest channel closed; reopening', { queue: this.options.queue })
    void this.open()
  }

  private async consume(): Promise<void> {
    const channel = this.channel
    if (!channel || this.consuming || this.stopped) return
    const generation = this.generation
    await channel.consume(
      this.options.queue,
      (message) => {
        if (message === null) {
          this.consumerCancelledByBroker(generation)
          return
        }
        this.onDelivery({ message, generation, epoch: this.epoch })
      },
      { noAck: false, consumerTag: this.options.consumerTag },
    )
    this.consuming = true
  }

  /** The broker cancelled the consumer (queue deleted or consumer timeout): consume again after a pause. */
  private consumerCancelledByBroker(generation: number): void {
    if (generation !== this.generation) return
    this.consuming = false
    this.log.warn('the broker cancelled the ingest consumer; consuming again shortly', { queue: this.options.queue })
    setTimeout(() => {
      if (this.stopped || this.backingOff || generation !== this.generation) return
      this.consume().catch((error: unknown) => this.log.warn('consuming again failed', { queue: this.options.queue, err: error }))
    }, RECONSUME_DELAY_MS)
  }

  /**
   * The whole-batch failure protocol of docs/queue.md §6.6. Resolves once consuming again (or stopped) and returns
   * whether MongoDB answered as a writable primary at the first ping, which separates poison batches from outages.
   */
  protected async recoverFromFailure(): Promise<boolean> {
    this.backingOff = true
    const channel = this.channel
    try {
      if (channel && this.consuming) await channel.cancel(this.options.consumerTag)
    } catch (error) {
      this.log.debug('cancelling the consumer failed', { err: error })
    }
    this.consuming = false
    try {
      // After cancel-ok no further deliveries arrive, so this returns exactly the outstanding ones.
      channel?.nackAll(true)
    } catch (error) {
      this.log.debug('nack failed; the broker redelivers when the channel closes', { err: error })
    }
    this.epoch += 1
    this.onDeliveriesReturned()

    let delay = BACKOFF_MIN_MS
    let firstHealthy: boolean | null = null
    while (!this.stopped) {
      await sleep(fullJitter(delay))
      const healthy = await this.options.pingWritable().catch(() => false)
      firstHealthy ??= healthy
      if (healthy) break
      delay = Math.min(BACKOFF_MAX_MS, delay * 2)
    }
    this.backingOff = false
    if (!this.stopped) {
      if (this.channel) {
        await this.consume().catch((error: unknown) => {
          this.log.warn('consuming again failed; reopening the channel', { err: error })
          void this.channel?.close().catch(() => undefined)
        })
      } else {
        await this.open()
      }
    }
    return firstHealthy ?? false
  }
}
