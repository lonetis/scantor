import type { Collection, Document } from 'mongodb'
import type { EventDoc, ScanDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import { useAmqp } from '../../utils/amqp'
import { instanceId } from '../../utils/instance'
import type { Logger } from '../../utils/logger'
import { COLLECTION_NAMES, useMongo } from '../../utils/mongo'
import { DeadLetterConsumer } from './dead-letter-consumer'
import { BatchProcessor, type IngestorHooks } from './processor'
import { ResultConsumer } from './result-consumer'
import { ScanStateCache } from './scan-cache'
import { RejectionEvents } from './security-events'

/*
 * The ingestor (component `ingestor`; docs/architecture.md §4.1, docs/queue.md §6–§7): one AMQP connection
 * (`scantor-orchestrator/ingestor/<instanceId>`) with two channels, the result consumer on scantor.results.ingest
 * and the dead-letter consumer on scantor.dead.ingest. Both share the scan-state cache, the write path, the
 * counters and the circuit breaker (BatchProcessor). Scan lifecycle effects (breaker pause, completion) go through
 * the scans area's functions, injected as hooks.
 */

export type { IngestorHooks } from './processor'

export interface IngestorOptions {
  config: Config
  log: Logger
  hooks: IngestorHooks
  /** defaults to the process connection of component `ingestor` */
  connection?: { createChannel(): Promise<import('amqplib').Channel> }
  collections?: { analyses: Collection<Document>; scans: Collection<ScanDoc>; events: Collection<EventDoc> }
  pingWritable?: () => Promise<boolean>
  /** watch `scans` with a change stream (default true) */
  watchScans?: boolean
}

/** True when the shared client reaches a writable primary. */
async function pingWritablePrimary(): Promise<boolean> {
  const hello = (await useMongo().client.db('admin').command({ hello: 1 }, { timeoutMS: 5000 })) as { isWritablePrimary?: boolean }
  return hello.isWritablePrimary === true
}

export class Ingestor {
  private cache: ScanStateCache | null = null
  private processor: BatchProcessor | null = null
  private consumers: (ResultConsumer | DeadLetterConsumer)[] = []

  constructor(private readonly options: IngestorOptions) {}

  async start(): Promise<void> {
    const { config, log, hooks } = this.options
    const collections = this.options.collections ?? {
      analyses: useMongo().db.collection<Document>(COLLECTION_NAMES.analyses),
      scans: useMongo().db.collection<ScanDoc>(COLLECTION_NAMES.scans),
      events: useMongo().db.collection<EventDoc>(COLLECTION_NAMES.events),
    }
    const connection = this.options.connection ?? (await useAmqp('ingestor'))
    const pingWritable = this.options.pingWritable ?? pingWritablePrimary

    this.cache = new ScanStateCache(collections.scans, log.child({ part: 'scan-cache' }), { watch: this.options.watchScans })
    this.cache.start()
    const processor = new BatchProcessor({ analyses: collections.analyses, scans: collections.scans, cache: this.cache, config, hooks, log })
    this.processor = processor
    await processor.start()
    const common = { connection, log, pingWritable }
    const results = new ResultConsumer({ ...common, consumerTag: `scantor-ingestor-${instanceId}` }, config, processor)
    const deadLetters = new DeadLetterConsumer(
      { ...common, consumerTag: `scantor-ingestor-dead-${instanceId}`, log: log.child({ part: 'dead-letters' }) },
      config,
      processor,
      new RejectionEvents(collections.events),
    )
    this.consumers = [results, deadLetters]
    await Promise.all(this.consumers.map((consumer) => consumer.start()))
    log.info('ingestor consuming', { prefetch: config.ingestPrefetch, batchSize: config.ingestBatchSize })
  }

  async stop(): Promise<void> {
    await Promise.all(this.consumers.map((consumer) => consumer.stop()))
    this.consumers = []
    this.processor?.stop()
    this.processor = null
    await this.cache?.stop()
    this.cache = null
  }
}
