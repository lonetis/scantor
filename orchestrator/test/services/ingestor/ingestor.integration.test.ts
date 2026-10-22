import { randomUUID } from 'node:crypto'
import { type ChannelModel, connect, type ConfirmChannel } from 'amqplib'
import { type AnyBulkWriteOperation, type Collection, type Db, type Document, MongoClient, MongoNetworkError } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Ingestor, type IngestorHooks } from '../../../server/services/ingestor'
import { ingestMessages, ingestWholeBatchFailures, ingestWriteFailed } from '../../../server/services/metrics/catalogue'
import { createRowFormatter, exportDocuments, exportLines } from '../../../server/services/exports/rows'
import { aggregateAnalyses, queryAnalyses } from '../../../server/services/query/execute'
import type { EventDoc, ScanDoc } from '../../../server/types/documents'
import { EXCHANGES, GLOBAL_QUEUE_ARGUMENTS, GLOBAL_QUEUES } from '../../../server/utils/amqp'
import { type Config, parseConfig } from '../../../server/utils/config'
import { useLogger } from '../../../server/utils/logger'
import { COLLECTION_NAMES, ensureIndexes } from '../../../server/utils/mongo'
import { RabbitmqManagement } from '../../../server/utils/rabbitmq-management'
import { readRepoFile } from '../../helpers/repo'

/*
 * Integration test of the ingestor (docs/queue.md §5–§7) and the user query path (docs/api.md §5.2) against a
 * throwaway MongoDB replica set (started with --noscripting) and RabbitMQ 4.4 with the management plugin. Messages
 * are published as the per-scan RabbitMQ user exactly like a runtime does (user_id scan-<scanId>, routing key
 * <scanId>), so the broker's identity enforcement is part of the test.
 *
 * Opt-in, like the other orchestrator integration tests: SCANTOR_TEST_INTEGRATION=true plus the usual connection
 * variables of .env.example pointing at the throwaway services, for example
 *
 *   SCANTOR_TEST_INTEGRATION=true SCANTOR_MONGO_URL='mongodb://127.0.0.1:27217/?authSource=admin&directConnection=true' \
 *   SCANTOR_MONGO_USER=… SCANTOR_MONGO_PASSWORD=… SCANTOR_AMQP_INTERNAL_URL=amqp://127.0.0.1:5872 \
 *   SCANTOR_RABBITMQ_MANAGEMENT_URL=http://127.0.0.1:15872 SCANTOR_RABBITMQ_USER=… SCANTOR_RABBITMQ_PASSWORD=… \
 *   npx vitest run test/services/ingestor
 *
 * Every run uses its own databases and vhost and removes them afterwards.
 */

const enabled = process.env.SCANTOR_TEST_INTEGRATION === 'true'
const infra: Config | null = enabled ? parseConfig({ ...process.env, SCANTOR_SECRET: `integration-secret-${randomUUID()}` }).config : null

function testMongoClient(): MongoClient {
  return new MongoClient(infra!.mongoUrl, {
    auth: { username: infra!.mongoUser, password: infra!.mongoPassword },
    serverSelectionTimeoutMS: 10_000,
  })
}

const RUN = randomUUID().slice(0, 8)
const VHOST = `scantor-it-${RUN}`
const DATABASE = `scantor_it_${RUN}`
const USER_A = randomUUID()
const USER_B = randomUUID()
const SCAN_A = randomUUID()
const SCAN_B = randomUUID()
const SCAN_BREAKER = randomUUID()
const SCAN_DELETING = randomUUID()
const SCAN_UNKNOWN = randomUUID()
const WORKER = randomUUID()
const NODE = randomUUID()
const DELIVERY_LIMIT = 1

const config = {
  ingestPrefetch: 100,
  ingestBatchSize: 50,
  ingestBatchMaxBytes: 16 * 1024 * 1024,
  ingestFlushIntervalMs: 100,
  maxResultBytes: 64 * 1024,
  breakerMinAttempts: 5,
  breakerRatio: 0.8,
  breakerWindowMs: 60_000,
  deliveryLimit: DELIVERY_LIMIT,
  rabbitmqUser: '',
  queryMaxTimeMs: 10_000,
  queryMaxDocs: 1000,
} as unknown as Config

function scanDoc(id: string, userId: string, overrides: Partial<ScanDoc> = {}): ScanDoc {
  const now = new Date()
  return {
    _id: id,
    userId,
    name: null,
    task: { id: randomUUID(), name: 'echo' },
    revision: {
      id: randomUUID(),
      number: 1,
      language: 'python',
      repository: 'tasks/x',
      digest: 'sha256:0',
      platform: { os: 'linux', arch: 'arm64' },
      privileged: false,
      schedule: { kind: 'custom' },
    },
    state: 'running',
    stateReason: null,
    taskConfig: {},
    scanConfig: {},
    secrets: { taskConfig: {}, scanConfig: {} },
    secretPaths: { taskConfig: [], scanConfig: [], analysisConfig: [], result: [] },
    uploadIds: [],
    settings: {
      workers: 1,
      processes: 1,
      timeoutMs: 30_000,
      maxAttempts: 3,
      backoff: { initialMs: 1000, factor: 2, maxMs: 10_000, jitter: false },
      resources: { cpus: 1, memoryMiB: 512 },
      maxAnalysesPerProcess: 1000,
      nodeSelector: { pool: 'shared', labels: {} },
      privileged: false,
    },
    round: 1,
    scheduling: { state: 'running', confirmed: 0, tailHash: null, epoch: 1, restarts: 0, resolved: {}, error: null, startedAt: now, checkpointAt: null, doneAt: null },
    stats: { pending: 0, retrying: 0, succeeded: 0, failed: 0, lost: 0, cancelled: 0, expectedTotal: null, ratePerMin: 0, recountedAt: null },
    conditions: [],
    breaker: null,
    clonedFrom: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    pausedAt: null,
    completedAt: null,
    deletedAt: null,
    ...overrides,
  }
}

const timings = { scheduledAt: 1761040805000, startedAt: 1761040896000, finishedAt: 1761040897200, durationMs: 1200 }

function resultBody(scanId: string, seq: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    kind: 'result',
    analysisId: `${scanId}-${seq}`,
    scanId,
    seq,
    round: 1,
    attempt: 1,
    executionId: randomUUID(),
    workerId: WORKER,
    nodeId: NODE,
    config: { origin: `https://example.org/${seq}` },
    status: 'succeeded',
    result: { title: `title ${seq}` },
    error: null,
    files: [],
    logTail: 'ok\n',
    timings,
    ...overrides,
  }
}

function failedBody(scanId: string, seq: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const attempt = (overrides.attempt as number | undefined) ?? 1
  return resultBody(scanId, seq, {
    status: 'failed',
    result: null,
    error: { type: 'taskError', message: 'boom', retryable: false, phase: 'run', attempt, at: 1761040990000 },
    ...overrides,
  })
}

function attemptBody(scanId: string, seq: number, attempt: number): Record<string, unknown> {
  const { status: _status, result: _result, files: _files, ...rest } = resultBody(scanId, seq, { attempt })
  return {
    ...rest,
    kind: 'attempt',
    error: { type: 'timeout', message: 'run exceeded 30000 ms', retryable: true, phase: 'run', attempt, at: 1761040890000 },
  }
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function settle(ms = 1000): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe.skipIf(!enabled)('ingestor against MongoDB and RabbitMQ', () => {
  let mongo: MongoClient
  let db: Db
  let analyses: Collection<Document>
  let scans: Collection<ScanDoc>
  let events: Collection<EventDoc>
  let management: RabbitmqManagement
  let admin: ChannelModel
  let adminUser: string
  const scanConnections = new Map<string, ChannelModel>()
  let ingestor: Ingestor
  const hookCalls = { paused: [] as { scanId: string; reason: string; details?: object }[], completion: [] as string[] }
  /** Fault injection: returns an error for a bulkWrite the test wants to fail. */
  let injectFault: ((operations: AnyBulkWriteOperation<Document>[]) => Error | null) | null = null

  /** The analyses collection as the ingestor sees it: bulkWrite passes through the fault injector. */
  function faultyCollection(target: Collection<Document>): Collection<Document> {
    return new Proxy(target, {
      get(collection, property) {
        if (property === 'bulkWrite') {
          return async (operations: AnyBulkWriteOperation<Document>[], options: object) => {
            const fault = injectFault?.(operations)
            if (fault) throw fault
            return collection.bulkWrite(operations, options)
          }
        }
        const value = Reflect.get(collection, property, collection) as unknown
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(collection) : value
      },
    })
  }

  const hooks: IngestorHooks = {
    async pauseScanBySystem(scanId, reason, details) {
      hookCalls.paused.push({ scanId, reason, details })
      await scans.updateOne({ _id: scanId, state: 'running' }, { $set: { state: 'paused', pausedAt: new Date() } })
    },
    async tryCompleteScan(scanId) {
      hookCalls.completion.push(scanId)
      return false
    },
  }

  function vhostUrl(user: { name: string; password: string }): string {
    const url = new URL(infra!.amqpInternalUrl)
    url.username = encodeURIComponent(user.name)
    url.password = encodeURIComponent(user.password)
    url.pathname = `/${encodeURIComponent(VHOST)}`
    return url.toString()
  }

  async function createScanUser(scanId: string): Promise<void> {
    const name = `scan-${scanId}`
    await management.putUser(name, `pw-${scanId}`)
    await management.putPermissions(VHOST, name, { configure: '^$', write: '^scantor\\.(analyses|results)$', read: `^scantor\\.scan\\.${scanId}$` })
    for (const exchange of [EXCHANGES.analyses, EXCHANGES.results]) {
      await management.putTopicPermissions(VHOST, name, { exchange, write: `^${scanId}$`, read: '^$' })
    }
    scanConnections.set(scanId, await connect(vhostUrl({ name, password: `pw-${scanId}` })))
  }

  /** Publishes as the scan's own RabbitMQ user, like a runtime (confirm channel, mandatory, user_id). */
  async function publishAsScan(scanId: string, body: unknown, options: { routingKey?: string; userId?: string; exchange?: string } = {}): Promise<void> {
    const connection = scanConnections.get(scanId)!
    const channel: ConfirmChannel = await connection.createConfirmChannel()
    // The broker closes the channel when it refuses a publish (403 routing key, 406 user_id).
    const closed = new Promise<never>((_, reject) => {
      channel.on('error', (error: Error) => reject(error))
      channel.on('close', () => reject(new Error('channel closed')))
    })
    closed.catch(() => undefined)
    try {
      channel.publish(options.exchange ?? EXCHANGES.results, options.routingKey ?? scanId, Buffer.from(JSON.stringify(body)), {
        contentType: 'application/json',
        deliveryMode: 2,
        messageId: randomUUID(),
        userId: options.userId ?? `scan-${scanId}`,
        mandatory: true,
        type: (body as { kind?: string }).kind ?? 'result',
      })
      await Promise.race([channel.waitForConfirms(), closed])
    } finally {
      await channel.close().catch(() => undefined)
    }
  }

  /** Publishes as the admin user without user_id (something a runtime cannot do). */
  async function publishAsAdmin(routingKey: string, body: unknown): Promise<void> {
    const channel = await admin.createConfirmChannel()
    channel.publish(EXCHANGES.results, routingKey, Buffer.from(JSON.stringify(body)), { contentType: 'application/json', mandatory: true })
    await channel.waitForConfirms()
    await channel.close()
  }

  async function analysis(scanId: string, seq: number): Promise<Document | null> {
    return analyses.findOne({ _id: `${scanId}-${seq}` })
  }

  beforeAll(async () => {
    mongo = testMongoClient()
    await mongo.connect()
    db = mongo.db(DATABASE)
    await ensureIndexes(db, { eventsTtlDays: 30 }, useLogger('test'))
    analyses = db.collection(COLLECTION_NAMES.analyses)
    scans = db.collection<ScanDoc>(COLLECTION_NAMES.scans)
    events = db.collection<EventDoc>(COLLECTION_NAMES.events)
    await scans.insertMany([
      scanDoc(SCAN_A, USER_A),
      scanDoc(SCAN_B, USER_B, { scheduling: { ...scanDoc(SCAN_B, USER_B).scheduling, state: 'done', confirmed: 1 } }),
      scanDoc(SCAN_BREAKER, USER_A),
      scanDoc(SCAN_DELETING, USER_A, { state: 'deleting' }),
    ])

    adminUser = infra!.rabbitmqUser
    ;(config as { rabbitmqUser: string }).rabbitmqUser = adminUser
    management = new RabbitmqManagement({ baseUrl: infra!.rabbitmqManagementUrl, username: adminUser, password: infra!.rabbitmqPassword })
    await management.putVhost(VHOST, { description: 'scantor integration test', default_queue_type: 'quorum' })
    await management.putPermissions(VHOST, adminUser, { configure: '.*', write: '.*', read: '.*' })
    admin = await connect(vhostUrl({ name: adminUser, password: infra!.rabbitmqPassword }))
    const channel = await admin.createChannel()
    for (const exchange of Object.values(EXCHANGES)) await channel.assertExchange(exchange, 'topic', { durable: true })
    await channel.assertQueue(GLOBAL_QUEUES.resultsIngest, { durable: true, arguments: GLOBAL_QUEUE_ARGUMENTS[GLOBAL_QUEUES.resultsIngest] })
    await channel.bindQueue(GLOBAL_QUEUES.resultsIngest, EXCHANGES.results, '#')
    await channel.assertQueue(GLOBAL_QUEUES.deadIngest, { durable: true, arguments: GLOBAL_QUEUE_ARGUMENTS[GLOBAL_QUEUES.deadIngest] })
    await channel.bindQueue(GLOBAL_QUEUES.deadIngest, EXCHANGES.dead, '#')
    // The scan queue of SCAN_A, declared as the reconciler does (with a tiny delivery limit for the crash case).
    await channel.assertQueue(`scantor.scan.${SCAN_A}`, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-delivery-limit': DELIVERY_LIMIT,
        'x-dead-letter-exchange': EXCHANGES.dead,
        'x-dead-letter-strategy': 'at-least-once',
        'x-overflow': 'reject-publish',
        'x-max-length': 1000,
      },
    })
    await channel.bindQueue(`scantor.scan.${SCAN_A}`, EXCHANGES.analyses, SCAN_A)
    await channel.close()
    for (const scanId of [SCAN_A, SCAN_B, SCAN_BREAKER, SCAN_DELETING, SCAN_UNKNOWN]) await createScanUser(scanId)

    ingestor = new Ingestor({
      config,
      log: useLogger('ingestor-it'),
      hooks,
      connection: admin,
      collections: { analyses: faultyCollection(analyses), scans, events },
      pingWritable: async () => true,
    })
    await ingestor.start()
  }, 60_000)

  afterAll(async () => {
    await ingestor?.stop()
    for (const connection of scanConnections.values()) await connection.close().catch(() => undefined)
    await admin?.close().catch(() => undefined)
    if (management) {
      for (const scanId of scanConnections.keys()) await management.deleteUser(`scan-${scanId}`).catch(() => undefined)
      await management.request('DELETE', `/vhosts/${encodeURIComponent(VHOST)}`, undefined, [404]).catch(() => undefined)
    }
    await db?.dropDatabase().catch(() => undefined)
    await mongo?.close()
  }, 60_000)

  it('upserts a succeeded result with the identity of the AMQP user and recomputed file keys', async () => {
    const fileId = randomUUID()
    const body = resultBody(SCAN_A, 0, {
      files: [{ id: fileId, name: '..escape me?.png', size: 3, sha256: 'a'.repeat(64), contentType: 'image/png' }],
    })
    await publishAsScan(SCAN_A, body)
    const doc = await waitFor('the analysis', () => analysis(SCAN_A, 0))
    expect(doc).toMatchObject({ scanId: SCAN_A, userId: USER_A, seq: 0, round: 1, status: 'succeeded', attempt: 1, result: { title: 'title 0' } })
    expect(doc.files).toEqual([
      expect.objectContaining({ id: fileId, key: `files/${SCAN_A}/0/${String(body.executionId)}/${fileId}/..escape_me_.png` }),
    ])
    expect(doc.attempts).toHaveLength(1)
    const scan = await waitFor('the hint counters', async () => {
      const current = await scans.findOne({ _id: SCAN_A })
      return current && current.stats.succeeded >= 1 ? current : null
    })
    expect(scan.stats.ratePerMin).toBeGreaterThan(0)
  })

  it('absorbs duplicates and keeps the first terminal result unless a success replaces a failure', async () => {
    await publishAsScan(SCAN_A, resultBody(SCAN_A, 0))
    await publishAsScan(SCAN_A, failedBody(SCAN_A, 0))
    await settle()
    const doc = await analysis(SCAN_A, 0)
    expect(doc).toMatchObject({ status: 'succeeded' })
    expect(doc!.attempts).toHaveLength(1)

    await publishAsScan(SCAN_A, attemptBody(SCAN_A, 1, 1))
    await waitFor('retrying', async () => (await analysis(SCAN_A, 1))?.status === 'retrying')
    // A stale attempt event of the same attempt number is ignored.
    await publishAsScan(SCAN_A, attemptBody(SCAN_A, 1, 1))
    await publishAsScan(SCAN_A, failedBody(SCAN_A, 1, { attempt: 2 }))
    await waitFor('failed', async () => (await analysis(SCAN_A, 1))?.status === 'failed')
    // A late success of the same round beats the failure.
    await publishAsScan(SCAN_A, resultBody(SCAN_A, 1, { attempt: 3 }))
    const recovered = await waitFor('succeeded', async () => {
      const current = await analysis(SCAN_A, 1)
      return current?.status === 'succeeded' ? current : null
    })
    expect(recovered.attempts.map((entry: { attempt: number }) => entry.attempt)).toEqual([1, 2, 3])
    expect(recovered.error).toBeUndefined()
  })

  it('never lets an older round overwrite a newer one and drops future rounds', async () => {
    await publishAsScan(SCAN_A, failedBody(SCAN_A, 2))
    await waitFor('failed', async () => (await analysis(SCAN_A, 2))?.status === 'failed')
    // retry-failed: round 2, the analysis reset to pending.
    await scans.updateOne({ _id: SCAN_A }, { $set: { round: 2 } })
    await analyses.updateOne({ _id: `${SCAN_A}-2` }, { $set: { status: 'pending', round: 2, attempt: 0 } })
    await publishAsScan(SCAN_A, resultBody(SCAN_A, 2, { round: 1 }))
    await settle()
    expect(await analysis(SCAN_A, 2)).toMatchObject({ status: 'pending', round: 2 })
    // Round 3 does not exist yet: dropped even after a fresh read of the scan.
    await publishAsScan(SCAN_A, resultBody(SCAN_A, 3, { round: 3 }))
    await settle()
    expect(await analysis(SCAN_A, 3)).toBeNull()
    await publishAsScan(SCAN_A, resultBody(SCAN_A, 2, { round: 2 }))
    await waitFor('round 2 success', async () => (await analysis(SCAN_A, 2))?.status === 'succeeded')
  })

  it('records authenticated but schema-invalid messages as minimal failed documents', async () => {
    await publishAsScan(SCAN_A, { ...resultBody(SCAN_A, 4), unexpected: true })
    const doc = await waitFor('the minimal document', () => analysis(SCAN_A, 4))
    expect(doc).toMatchObject({ status: 'failed', error: { type: 'platform', phase: 'ingest' } })
    expect(String(doc.error.message)).toMatch(/^invalid result message: /)
    expect(doc.config).toBeUndefined()
  })

  it('records results that BSON cannot store and results above the size limit as failed', async () => {
    await publishAsScan(SCAN_A, resultBody(SCAN_A, 5, { result: { 'bad\u0000key': 1 } }))
    const nul = await waitFor('the NUL key document', () => analysis(SCAN_A, 5))
    expect(nul).toMatchObject({ status: 'failed', error: { phase: 'ingest' } })
    expect(String(nul.error.message)).toMatch(/^result could not be stored: /)
    await publishAsScan(SCAN_A, resultBody(SCAN_A, 6, { result: { blob: 'x'.repeat(70 * 1024) } }))
    const large = await waitFor('the oversized document', () => analysis(SCAN_A, 6))
    expect(large).toMatchObject({ status: 'failed', error: { type: 'validation', phase: 'ingest' } })
  })

  it('rejects messages that claim another scan, and the broker refuses forged routing keys and user ids', async () => {
    await publishAsScan(SCAN_A, resultBody(SCAN_B, 7))
    await publishAsScan(SCAN_A, { ...resultBody(SCAN_A, 7), analysisId: `${SCAN_A}-8` })
    const rejected = await waitFor('security events', async () => {
      const found = await events.find({ type: 'security.ingestRejected', 'data.routingKey': SCAN_A }).toArray()
      return found.length >= 2 ? found : null
    })
    expect(rejected.map((event) => event.data?.reason).sort()).toEqual(['analysisIdMismatch', 'scanIdMismatch'])
    expect(rejected.every((event) => event.userId === null)).toBe(true)
    expect(await analysis(SCAN_B, 7)).toBeNull()
    expect(await analysis(SCAN_A, 7)).toBeNull()
    expect(await analysis(SCAN_A, 8)).toBeNull()

    await expect(publishAsScan(SCAN_A, resultBody(SCAN_B, 9), { routingKey: SCAN_B })).rejects.toThrow()
    await expect(publishAsScan(SCAN_A, resultBody(SCAN_B, 9), { routingKey: SCAN_B, userId: `scan-${SCAN_B}` })).rejects.toThrow()
    await settle()
    expect(await analysis(SCAN_B, 9)).toBeNull()
  })

  it('rejects messages without user_id and writes one rate-limited security event', async () => {
    const routingKey = randomUUID()
    await publishAsAdmin(routingKey, resultBody(routingKey, 0))
    await publishAsAdmin(routingKey, resultBody(routingKey, 1))
    await waitFor('the security event', async () => (await events.countDocuments({ 'data.routingKey': routingKey })) > 0)
    await settle()
    const found = await events.find({ 'data.routingKey': routingKey }).toArray()
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ type: 'security.ingestRejected', level: 'warning', userId: null, data: { reason: 'missingUserId', userIdProperty: null } })
  })

  it('drops results of unknown and deleting scans', async () => {
    await publishAsScan(SCAN_UNKNOWN, resultBody(SCAN_UNKNOWN, 0))
    await publishAsScan(SCAN_DELETING, resultBody(SCAN_DELETING, 0))
    await settle()
    expect(await analyses.countDocuments({ scanId: { $in: [SCAN_UNKNOWN, SCAN_DELETING] } })).toBe(0)
  })

  it('records an analysis that exceeded the delivery limit of its scan queue as a crash', async () => {
    const analysisMessage = { v: 1, analysisId: `${SCAN_A}-9`, scanId: SCAN_A, seq: 9, round: 2, attempt: 1, config: { origin: 'crash' }, scheduledAt: Date.now() }
    await publishAsScan(SCAN_A, analysisMessage, { exchange: EXCHANGES.analyses })
    // Simulate runners that die mid-analysis: requeueing rejections count toward the delivery limit.
    const channel = await admin.createChannel()
    await channel.prefetch(1)
    let deliveries = 0
    await channel.consume(`scantor.scan.${SCAN_A}`, (message) => {
      if (!message) return
      deliveries++
      channel.reject(message, true)
    })
    const doc = await waitFor('the crash record', () => analysis(SCAN_A, 9))
    await channel.close()
    expect(deliveries).toBe(DELIVERY_LIMIT + 1)
    expect(doc).toMatchObject({
      status: 'failed',
      round: 2,
      attempt: 1,
      config: { origin: 'crash' },
      error: { type: 'crash', phase: 'run', retryable: false, details: { deathReason: 'delivery_limit', deathQueue: `scantor.scan.${SCAN_A}` } },
    })
  })

  it('nacks a batch that fails as a whole and writes it once MongoDB answers again', async () => {
    let remaining = 2
    injectFault = () => (remaining-- > 0 ? new MongoNetworkError('injected outage') : null)
    const before = ingestWholeBatchFailures.get()
    await publishAsScan(SCAN_A, resultBody(SCAN_A, 10, { round: 2 }))
    await waitFor('the redelivered write', async () => (await analysis(SCAN_A, 10))?.status === 'succeeded', 30_000)
    injectFault = null
    expect(ingestWholeBatchFailures.get() - before).toBe(2)
  }, 40_000)

  it('isolates a poison message after three whole-batch failures and records it as failed', async () => {
    const poison = `${SCAN_A}-11`
    const isPoisonResult = (operation: AnyBulkWriteOperation<Document>) => {
      const update = (operation as { updateOne?: { filter: { _id?: string }; update: { $set?: { status?: string } } } }).updateOne
      return update?.filter._id === poison && update.update.$set?.status === 'succeeded'
    }
    // An unknown, non-transient failure of every batch that contains the poison result.
    injectFault = (operations) => (operations.some(isPoisonResult) ? new Error('injected poison') : null)
    const before = ingestMessages.get({ kind: 'result', outcome: 'failedRecorded' })
    const failuresBefore = ingestWholeBatchFailures.get()
    await publishAsScan(SCAN_A, resultBody(SCAN_A, 11, { round: 2 }))
    const doc = await waitFor('the isolated write', () => analysis(SCAN_A, 11), 30_000)
    injectFault = null
    expect(doc).toMatchObject({ status: 'failed', error: { type: 'platform', phase: 'ingest' } })
    expect(String(doc.error.message)).toContain('injected poison')
    expect(ingestMessages.get({ kind: 'result', outcome: 'failedRecorded' }) - before).toBe(1)
    expect(ingestWholeBatchFailures.get() - failuresBefore).toBe(3)
    expect(ingestWriteFailed.get()).toBe(0)
  }, 40_000)

  it('triggers completion once the hint count reaches the confirmed analyses', async () => {
    await publishAsScan(SCAN_B, resultBody(SCAN_B, 0))
    await waitFor('the completion trigger', async () => hookCalls.completion.includes(SCAN_B))
  })

  it('pauses a scan whose attempts mostly fail (circuit breaker)', async () => {
    for (let seq = 0; seq < 5; seq++) await publishAsScan(SCAN_BREAKER, failedBody(SCAN_BREAKER, seq))
    const call = await waitFor('the breaker', async () => hookCalls.paused.find((entry) => entry.scanId === SCAN_BREAKER))
    expect(call.reason).toBe('failureRate')
    expect(call.details).toMatchObject({ attempts: 5, ratio: 1, windowMs: 60_000 })
  })
})

describe.skipIf(!enabled)('user queries against MongoDB', () => {
  interface CorpusCase {
    id: string
    operation: 'queryAnalyses' | 'aggregateAnalyses' | 'exportScan'
    body?: Record<string, unknown>
    expect: { rejected: boolean; scoped?: boolean }
  }

  let mongo: MongoClient
  let db: Db
  let collection: Collection<Document>
  const own = { _id: randomUUID(), userId: randomUUID(), secretPaths: { taskConfig: [], scanConfig: [], analysisConfig: [], result: [] } }
  const foreign = { _id: randomUUID(), userId: randomUUID() }

  beforeAll(async () => {
    mongo = testMongoClient()
    await mongo.connect()
    db = mongo.db(`scantor_it_query_${RUN}`)
    collection = db.collection(COLLECTION_NAMES.analyses)
    const docs = [own, foreign].flatMap((scan) =>
      Array.from({ length: 20 }, (_, seq) => ({
        _id: `${scan._id}-${seq}`,
        scanId: scan._id,
        userId: scan.userId,
        seq,
        round: 1,
        status: seq % 3 === 0 ? 'failed' : 'succeeded',
        attempt: 1,
        config: { mode: '$lookup' },
        result: { title: '$where' },
        error: seq % 3 === 0 ? { type: 'timeout', message: 'x', retryable: true, phase: 'run', attempt: 1, at: new Date() } : undefined,
        attempts: [],
        files: [{ id: 'f', name: 'n', key: 'files/secret-key' }],
        timings: { durationMs: seq },
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    )
    await collection.insertMany(docs)
  })

  afterAll(async () => {
    await db?.dropDatabase().catch(() => undefined)
    await mongo?.close()
  })

  it('returns only the addressed scan for every accepted corpus case', async () => {
    const corpus = JSON.parse(readRepoFile('tests/corpora/query-injection/cases.json')) as { cases: CorpusCase[] }
    const limits = { queryMaxTimeMs: 10_000, queryMaxDocs: 1000 }
    for (const entry of corpus.cases.filter((candidate) => !candidate.expect.rejected && candidate.operation !== 'exportScan')) {
      const items =
        entry.operation === 'queryAnalyses'
          ? (await queryAnalyses(own, { limit: 1000, ...(entry.body as never) }, limits, collection)).items
          : (await aggregateAnalyses(own, entry.body as never, limits, collection)).items
      const text = JSON.stringify(items)
      expect(text, entry.id).not.toContain(foreign._id)
      expect(text, entry.id).not.toContain(foreign.userId)
      expect(text, entry.id).not.toContain('files/secret-key')
      if (entry.expect.scoped && entry.operation === 'queryAnalyses') {
        expect(items.length, entry.id).toBe(20)
        expect(items.every((item) => item.scanId === own._id), entry.id).toBe(true)
      }
    }
  })

  it('streams exports in seq order, scoped, masked and resumable', async () => {
    const limits = { queryMaxTimeMs: 10_000, queryMaxDocs: 1000 }
    const selection = { scan: own, filter: { scanId: { $ne: null } }, status: ['failed' as const], afterSeq: 3, fields: null }
    const counters = { rows: 0, bytes: 0 }
    const lines: string[] = []
    const ranges: number[] = []
    const documents = exportDocuments(selection, 'jsonl', collection, limits, ({ afterSeq }) => {
      ranges.push(afterSeq)
    })
    for await (const line of exportLines(documents, createRowFormatter('jsonl', null, own), counters)) lines.push(line)
    const rows = lines.map((line) => JSON.parse(line) as { seq: number; scanId: string; files: Record<string, unknown>[] })
    expect(rows.map((row) => row.seq)).toEqual([6, 9, 12, 15, 18])
    expect(rows.every((row) => row.scanId === own._id && row.files.every((file) => !('key' in file)))).toBe(true)
    expect(counters.rows).toBe(5)
    expect(ranges.at(-1)).toBe(19)

    const csv: string[] = []
    const csvDocuments = exportDocuments({ ...selection, status: undefined, afterSeq: null, fields: ['seq', 'result.title'] }, 'csv', collection, limits)
    for await (const line of exportLines(csvDocuments, createRowFormatter('csv', ['seq', 'result.title'], own), { rows: 0, bytes: 0 })) csv.push(line)
    expect(csv[0]).toBe('seq,result.title\r\n')
    expect(csv[1]).toBe('0,$where\r\n')
    expect(csv).toHaveLength(21)
  })

  it('cannot run server-side JavaScript even if the validator were bypassed (--noscripting)', async () => {
    await expect(collection.findOne({ $where: 'true' })).rejects.toThrow()
  })

  it('pages queries by seq and maps server-side rejections to queryRejected', async () => {
    const limits = { queryMaxTimeMs: 10_000, queryMaxDocs: 1000 }
    const first = await queryAnalyses(own, { filter: { status: 'succeeded' }, limit: 5 }, limits, collection)
    expect(first.items).toHaveLength(5)
    expect(first.nextCursor).toBe('7')
    const second = await queryAnalyses(own, { filter: { status: 'succeeded' }, limit: 5, afterSeq: Number(first.nextCursor) }, limits, collection)
    expect(second.items[0]?.seq).toBe(8)
    await expect(queryAnalyses(own, { filter: { seq: { $bogus: 1 } }, limit: 5 }, limits, collection)).rejects.toMatchObject({ code: 'queryRejected' })
  })
})
