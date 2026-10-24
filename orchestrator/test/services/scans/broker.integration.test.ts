import { randomBytes, randomUUID } from 'node:crypto'
import { DeleteBucketCommand } from '@aws-sdk/client-s3'
import { type Channel, type ChannelModel, connect, type ConsumeMessage } from 'amqplib'
import type { H3Event } from 'h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runPlacement } from '../../../server/services/placement'
import { ScansReconciler } from '../../../server/services/reconciler'
import { reconcileHousekeepingConditions } from '../../../server/services/reconciler/conditions'
import { LifecycleConvergence } from '../../../server/services/reconciler/lifecycle'
import { SchedulerSupervisor } from '../../../server/services/reconciler/scheduler'
import { StallDetector } from '../../../server/services/reconciler/stall'
import { scanQueueArguments, TopologyReconciler } from '../../../server/services/reconciler/topology'
import { tryCompleteScan } from '../../../server/services/scans/completion'
import { scanDeleteJobKind } from '../../../server/services/scans/delete'
import { cancelScan, deleteScan, pauseScan, resumeScan, retryFailedAnalyses, scaleScan } from '../../../server/services/scans/lifecycle'
import { purgeUserScans } from '../../../server/services/scans/purge'
import { scanRetryFailedJobKind } from '../../../server/services/scans/retry-failed'
import { restartScan } from '../../../server/services/scans/start'
import { getWorkerLogs } from '../../../server/services/scans/worker-logs'
import { restoreConfigSecrets, validateConfigs } from '../../../server/services/configs/validate'
import { analysesCompleted } from '../../../server/services/metrics/catalogue'
import type { JobDoc, ScanDoc } from '../../../server/types/documents'
import { closeAmqp, ensureGlobalTopology, scanAmqpUser, scanQueueName, useAmqp } from '../../../server/utils/amqp'
import { type Config, parseConfig, setConfigForTesting } from '../../../server/utils/config'
import type { JobContext } from '../../../server/utils/jobs'
import { useKeys } from '../../../server/utils/keys'
import { useLogger } from '../../../server/utils/logger'
import { closeMongo, connectMongo, ensureIndexes, useCollections, useMongo } from '../../../server/utils/mongo'
import { RABBITMQ_VHOST, useRabbitmqManagement } from '../../../server/utils/rabbitmq-management'
import { deletePrefix, ensureBucket, objectExists, putObject, useS3 } from '../../../server/utils/s3'
import { analysisDoc, nodeDoc, revisionDoc, scanDoc, workerDoc } from './fixtures'

/*
 * The scans area against real infrastructure (docs/queue.md §3–§4, §8, §9; docs/data-model.md §6): topology ensure
 * and removal with the exact queue arguments, per-scan user permissions as the broker enforces them, lifecycle
 * convergence, retry-failed publishing with backpressure, stall detection, the delete job and the user purge step.
 *
 * Opt-in: SCANTOR_TEST_INTEGRATION=true plus the usual connection variables of .env.example pointing at a throwaway
 * MongoDB replica set, RabbitMQ 4.4 (management) and RustFS, for example
 *
 *   SCANTOR_TEST_INTEGRATION=true SCANTOR_MONGO_URL='mongodb://127.0.0.1:27117/?replicaSet=rs0&authSource=admin' \
 *   SCANTOR_MONGO_PASSWORD=… SCANTOR_AMQP_INTERNAL_URL=amqp://127.0.0.1:5772 \
 *   SCANTOR_RABBITMQ_MANAGEMENT_URL=http://127.0.0.1:15772 SCANTOR_RABBITMQ_PASSWORD=… \
 *   SCANTOR_S3_INTERNAL_URL=http://127.0.0.1:9100 SCANTOR_S3_SECRET_KEY=… npx vitest run test/services/scans
 *
 * Every run uses its own database and bucket and removes them, and the scan users and queues it created.
 */

const enabled = process.env.SCANTOR_TEST_INTEGRATION === 'true'
const suffix = randomBytes(4).toString('hex')
const log = useLogger('it')

let config: Config

function topology(): TopologyReconciler {
  return new TopologyReconciler({
    management: useRabbitmqManagement(),
    openChannel: async () => (await useAmqp('reconciler')).createChannel(),
    amqpPassword: (scanId) => useKeys().amqpPassword(scanId),
    config,
    scans: useCollections().scans,
    log,
  })
}

async function insertScan(overrides: Parameters<typeof scanDoc>[0] = {}): Promise<ScanDoc> {
  const scan = scanDoc(overrides)
  await useCollections().scans.insertOne(scan)
  return scan
}

async function reload(scanId: string): Promise<ScanDoc> {
  const scan = await useCollections().scans.findOne({ _id: scanId })
  if (!scan) throw new Error(`scan ${scanId} is gone`)
  return scan
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

function amqpUrl(): URL {
  return new URL(config.amqpInternalUrl)
}

/** An AMQP connection as the scan's own RabbitMQ user (what a worker gets from bootstrap). */
async function connectAsScan(scanId: string): Promise<ChannelModel> {
  const url = amqpUrl()
  return connect({
    protocol: 'amqp',
    hostname: url.hostname,
    port: Number(url.port),
    vhost: RABBITMQ_VHOST,
    username: scanAmqpUser(scanId),
    password: useKeys().amqpPassword(scanId),
  })
}

/**
 * Runs an operation on a fresh channel of `connection` and resolves with the broker's refusal (the channel close
 * error), or with "allowed" when the operation succeeded and the channel stayed open.
 */
async function attempt(connection: ChannelModel, operation: (channel: Channel) => unknown): Promise<string> {
  const channel = await connection.createChannel()
  return new Promise((resolve) => {
    channel.once('error', (error: Error) => resolve(error.message))
    channel.once('close', () => resolve('closed'))
    Promise.resolve()
      .then(() => operation(channel))
      .then(
        () => setTimeout(() => resolve('allowed'), 300),
        (error: Error) => resolve(error.message),
      )
  })
}

interface SavedJobState {
  cursor: Record<string, unknown>
  progress: { done: number; total: number | null }
}

/** A JobContext like the runner's: `job` is the claimed snapshot; saved cursors and progress go to `saved`. */
function jobContext(job: JobDoc, saved: SavedJobState = { cursor: job.cursor, progress: job.progress }, signal = new AbortController().signal): JobContext {
  return {
    job,
    log,
    config,
    signal,
    async saveCursor(cursor, progress) {
      saved.cursor = cursor
      if (progress) saved.progress = { done: progress.done, total: progress.total === undefined ? saved.progress.total : progress.total }
    },
    async setProgress(done, total) {
      saved.progress = { done, total: total === undefined ? saved.progress.total : total }
    },
  }
}

describe.skipIf(!enabled)('scans against MongoDB, RabbitMQ and RustFS', () => {
  const createdScans: string[] = []

  beforeAll(async () => {
    config = parseConfig({
      ...process.env,
      SCANTOR_SECRET: `integration-secret-${suffix}`,
      SCANTOR_MONGO_DB: `scantor_it_${suffix}`,
      SCANTOR_S3_BUCKET: `scantor-it-${suffix}`,
      SCANTOR_SCAN_QUEUE_MAX_READY: '3',
      SCANTOR_DELIVERY_LIMIT: '4',
      SCANTOR_INGEST_FLUSH_INTERVAL: '100ms',
    }).config
    setConfigForTesting(config)
    await connectMongo({ timeoutMs: 20_000, log })
    await ensureIndexes(useMongo().db, config, log)
    await ensureGlobalTopology(log)
    await ensureBucket(log)
  }, 60_000)

  afterAll(async () => {
    if (!enabled) return
    const management = useRabbitmqManagement()
    const scanIds = new Set([...createdScans, ...(await useCollections().scans.distinct('_id'))])
    for (const scanId of scanIds) {
      await management.deleteUser(scanAmqpUser(scanId))
      await management.deleteQueue(RABBITMQ_VHOST, scanQueueName(scanId))
    }
    for (const prefix of ['files/', 'exports/']) await deletePrefix(prefix)
    await useS3().send(new DeleteBucketCommand({ Bucket: config.s3Bucket }))
    await useMongo().db.dropDatabase()
    await closeAmqp()
    await closeMongo()
    setConfigForTesting(null)
  }, 60_000)

  // ── topology ──────────────────────────────────────────────────────────────

  describe('topology', () => {
    let scan: ScanDoc
    let other: ScanDoc

    beforeAll(async () => {
      scan = await insertScan({ state: 'creating', startedAt: null, settings: { workers: 2, processes: 3 } })
      other = await insertScan({ state: 'running' })
      createdScans.push(scan._id, other._id)
    })

    it('ensures queue, binding, user, permissions and limits, then moves creating → running', async () => {
      await topology().reconcile()
      const management = useRabbitmqManagement()

      const queue = await management.getQueue(RABBITMQ_VHOST, scanQueueName(scan._id))
      expect(queue?.arguments).toEqual({
        'x-queue-type': 'quorum',
        'x-delivery-limit': 4,
        'x-dead-letter-exchange': 'scantor.dead',
        'x-dead-letter-strategy': 'at-least-once',
        'x-overflow': 'reject-publish',
        'x-max-length': 3,
        'x-consumer-timeout': 300_000 + config.uploadTimeoutMs + 300_000,
      })
      expect(scanQueueArguments(scan, config)).toEqual(queue?.arguments)

      const bindings = (await management.request<{ source: string; routing_key: string }[]>('GET', `/queues/scantor/${encodeURIComponent(scanQueueName(scan._id))}/bindings`)) ?? []
      expect(bindings.filter((binding) => binding.source === 'scantor.analyses').map((binding) => binding.routing_key)).toEqual([scan._id])

      const user = await management.request<{ name: string; tags: string[] | string }>('GET', `/users/${scanAmqpUser(scan._id)}`)
      expect(user?.tags === '' || (Array.isArray(user?.tags) && user.tags.length === 0)).toBe(true)
      const permissions = await management.request<{ configure: string; write: string; read: string }>('GET', `/permissions/scantor/${scanAmqpUser(scan._id)}`)
      expect(permissions).toMatchObject({ configure: '^$', write: '^scantor\\.(analyses|results)$', read: `^scantor\\.scan\\.${scan._id}$` })
      const topic = (await management.request<{ exchange: string; write: string; read: string }[]>('GET', `/topic-permissions/scantor/${scanAmqpUser(scan._id)}`)) ?? []
      expect(topic.map(({ exchange, write, read }) => ({ exchange, write, read })).sort((a, b) => a.exchange.localeCompare(b.exchange))).toEqual([
        { exchange: 'scantor.analyses', write: `^${scan._id}$`, read: '^$' },
        { exchange: 'scantor.results', write: `^${scan._id}$`, read: '^$' },
      ])
      const limits = (await management.request<{ value: Record<string, number> }[]>('GET', `/user-limits/${scanAmqpUser(scan._id)}`)) ?? []
      expect(limits[0]?.value).toEqual({ 'max-connections': 6, 'max-channels': 30 })

      const running = await reload(scan._id)
      expect(running.state).toBe('running')
      expect(running.startedAt).toBeInstanceOf(Date)
      const events = await useCollections().events.find({ scanId: scan._id, type: 'scan.stateChanged' }).toArray()
      expect(events.map((event) => event.data)).toEqual([{ from: 'creating', to: 'running', reason: 'topologyReady' }])
    })

    it('issues no management writes when nothing changed', async () => {
      const management = useRabbitmqManagement()
      const writes = [
        vi.spyOn(management, 'putUser'),
        vi.spyOn(management, 'putPermissions'),
        vi.spyOn(management, 'putTopicPermissions'),
        vi.spyOn(management, 'putUserLimit'),
        vi.spyOn(management, 'deleteUser'),
        vi.spyOn(management, 'deleteQueue'),
      ]
      await topology().reconcile()
      for (const spy of writes) expect(spy).not.toHaveBeenCalled()
    })

    it('lets a scan user consume only its own queue and publish only its own routing key', async () => {
      const connection = await connectAsScan(scan._id)
      try {
        const own = await connection.createConfirmChannel()
        await own.checkQueue(scanQueueName(scan._id))
        await own.consume(scanQueueName(scan._id), () => {}, { noAck: false })
        own.publish('scantor.results', scan._id, Buffer.from('{}'), { userId: scanAmqpUser(scan._id), mandatory: true })
        await own.waitForConfirms()
        own.publish('scantor.analyses', scan._id, Buffer.from('{}'), { userId: scanAmqpUser(scan._id), mandatory: true })
        await own.waitForConfirms()

        const otherQueue = scanQueueName(other._id)
        const ownQueue = scanQueueName(scan._id)
        const body = Buffer.from('{}')
        expect(await attempt(connection, (channel) => channel.consume(otherQueue, () => {}))).toMatch(/ACCESS_REFUSED/)
        expect(await attempt(connection, (channel) => channel.checkQueue(otherQueue))).toMatch(/ACCESS_REFUSED/)
        expect(await attempt(connection, (channel) => channel.publish('scantor.analyses', other._id, body, { userId: scanAmqpUser(scan._id) }))).toMatch(/ACCESS_REFUSED/)
        expect(await attempt(connection, (channel) => channel.publish('scantor.results', other._id, body, { userId: scanAmqpUser(scan._id) }))).toMatch(/ACCESS_REFUSED/)
        expect(await attempt(connection, (channel) => channel.publish('scantor.results', scan._id, body, { userId: scanAmqpUser(other._id) }))).toMatch(/PRECONDITION_FAILED/)
        expect(await attempt(connection, (channel) => channel.publish('scantor.dead', scan._id, body, { userId: scanAmqpUser(scan._id) }))).toMatch(/ACCESS_REFUSED/)
        expect(await attempt(connection, (channel) => channel.publish('', ownQueue, body))).toMatch(/ACCESS_REFUSED/)
        expect(await attempt(connection, (channel) => channel.assertQueue(`${ownQueue}.x`))).toMatch(/ACCESS_REFUSED/)
        expect(await attempt(connection, (channel) => channel.deleteQueue(ownQueue))).toMatch(/ACCESS_REFUSED/)
        expect(await attempt(connection, (channel) => channel.bindQueue(ownQueue, 'scantor.results', scan._id))).toMatch(/ACCESS_REFUSED/)
        expect(await attempt(connection, (channel) => channel.purgeQueue(otherQueue))).toMatch(/ACCESS_REFUSED/)
        // RabbitMQ authorises queue.purge with the read permission, so a worker can purge its own queue (it can only
        // lose its own scan's messages; stall detection records them as lost).
        expect(await attempt(connection, (channel) => channel.purgeQueue(ownQueue))).toBe('allowed')
      } finally {
        await connection.close().catch(() => undefined)
      }

      const login = await fetch(`${config.rabbitmqManagementUrl}/api/whoami`, {
        headers: { authorization: `Basic ${Buffer.from(`${scanAmqpUser(scan._id)}:${useKeys().amqpPassword(scan._id)}`).toString('base64')}` },
      })
      expect(login.status).toBe(401)
    })

    it('raises the user limits in the tick after a scale', async () => {
      await scaleScan(await reload(scan._id), { workers: 4, processes: 1 }, config)
      await topology().reconcile()
      const limits = (await useRabbitmqManagement().request<{ value: Record<string, number> }[]>('GET', `/user-limits/${scanAmqpUser(scan._id)}`)) ?? []
      expect(limits[0]?.value).toEqual({ 'max-connections': 10, 'max-channels': 30 })
    })

    it('keeps an existing queue declared with other arguments', async () => {
      const mismatched = await insertScan({ state: 'creating', startedAt: null })
      createdScans.push(mismatched._id)
      const channel = await (await useAmqp('reconciler')).createChannel()
      await channel.assertQueue(scanQueueName(mismatched._id), { durable: true, arguments: { 'x-queue-type': 'quorum', 'x-max-length': 7 } })
      await channel.close()
      const result = await topology().reconcile()
      expect(result.failed).not.toContain(mismatched._id)
      expect((await reload(mismatched._id)).state).toBe('running')
      expect((await useRabbitmqManagement().getQueue(RABBITMQ_VHOST, scanQueueName(mismatched._id)))?.arguments?.['x-max-length']).toBe(7)
    })

    it('cancel removes the user first (closing worker connections), then the queue, and converges analyses', async () => {
      const connection = await connectAsScan(scan._id)
      const closed = new Promise<string>((resolve) => connection.on('close', (error?: Error) => resolve(error?.message ?? 'closed')))
      connection.on('error', () => {})
      const management = useRabbitmqManagement()
      const order: string[] = []
      vi.spyOn(management, 'deleteUser').mockImplementation(async function (this: typeof management, user: string) {
        order.push(`user:${user}`)
        await management.request('DELETE', `/users/${encodeURIComponent(user)}`, undefined, [404])
      })
      vi.spyOn(management, 'deleteQueue').mockImplementation(async function (vhost: string, queue: string) {
        order.push(`queue:${queue}`)
        await management.request('DELETE', `/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(queue)}`, undefined, [404])
      })
      const { analyses } = useCollections()
      await analyses.insertMany([
        analysisDoc(scan._id, 0, 'succeeded'),
        analysisDoc(scan._id, 1, 'pending'),
        analysisDoc(scan._id, 2, 'retrying'),
      ])
      await useCollections().scans.updateOne({ _id: scan._id }, { $set: { 'scheduling.state': 'running', 'scheduling.confirmed': 5 } })

      const cancelled = await cancelScan(await reload(scan._id))
      expect(cancelled.state).toBe('cancelled')
      const result = await topology().reconcile()
      expect(order).toEqual([`user:${scanAmqpUser(scan._id)}`, `queue:${scanQueueName(scan._id)}`])
      expect(await closed).toMatch(/CONNECTION_FORCED|closed/)
      expect(await management.getQueue(RABBITMQ_VHOST, scanQueueName(scan._id))).toBeNull()
      expect(result.present.has(scan._id)).toBe(false)

      const cancelledBefore = analysesCompleted.get({ status: 'cancelled' })
      await new LifecycleConvergence({ ...useCollections(), log }).run(result.present)
      const statuses = (await analyses.find({ scanId: scan._id }).sort({ seq: 1 }).toArray()).map((doc) => doc.status)
      expect(statuses).toEqual(['succeeded', 'cancelled', 'cancelled'])
      expect(analysesCompleted.get({ status: 'cancelled' })).toBe(cancelledBefore + 2)
      expect((await reload(scan._id)).stats).toMatchObject({ succeeded: 1, cancelled: 4, pending: 0, retrying: 0 })
    })

    it('sweeps orphan scan users and queues', async () => {
      const orphan = randomUUID()
      const management = useRabbitmqManagement()
      await management.putUser(scanAmqpUser(orphan), 'x', [])
      const channel = await (await useAmqp('reconciler')).createChannel()
      await channel.assertQueue(scanQueueName(orphan), { durable: true, arguments: { 'x-queue-type': 'quorum' } })
      await channel.close()
      const result = await topology().reconcile()
      expect(result.removed).toContain(orphan)
      expect(await management.getQueue(RABBITMQ_VHOST, scanQueueName(orphan))).toBeNull()
      expect((await management.listUsers()).some((user) => user.name === scanAmqpUser(orphan))).toBe(false)
    })
  })

  // ── lifecycle API ───────────────────────────────────────────────────────────

  describe('lifecycle operations', () => {
    it('pause, resume and scale record intent and events; repeated requests are idempotent', async () => {
      await useCollections().revisions.insertOne(revisionDoc({ _id: `r-${suffix}`, taskId: `t-r-${suffix}` }))
      const scan = await insertScan({ revision: { ...scanDoc().revision, id: `r-${suffix}` } })
      const paused = await pauseScan(scan)
      expect(paused).toMatchObject({ state: 'paused', stateReason: { code: 'user' } })
      expect(paused.pausedAt).toBeInstanceOf(Date)
      expect((await pauseScan(paused)).state).toBe('paused')
      await expect(scaleScan(paused, { workers: 1000 }, config)).rejects.toMatchObject({ data: { code: 'validationFailed' } })
      expect((await scaleScan(paused, { processes: 2 }, config)).settings.processes).toBe(2)
      const resumed = await resumeScan(await reload(scan._id))
      expect(resumed.state).toBe('running')
      await expect(deleteScan(resumed)).rejects.toMatchObject({ data: { code: 'invalidState', details: { state: 'running', allowed: ['completed', 'failed', 'cancelled'] } } })
      const types = (await useCollections().events.find({ scanId: scan._id }).sort({ at: 1 }).toArray()).map((event) => event.type)
      expect(types).toEqual(['scan.stateChanged', 'scan.scaled', 'scan.stateChanged'])
    })

    it('resume is 409 revisionUnavailable when the revision was deleted', async () => {
      const scan = await insertScan({ state: 'paused', revision: { ...scanDoc().revision, id: randomUUID() } })
      await expect(resumeScan(scan)).rejects.toMatchObject({ data: { code: 'revisionUnavailable' } })
    })
  })

  // ── restart, supervision, conditions ───────────────────────────────────────

  it('restart clones revision, configs and re-encrypted secrets into a new scan', async () => {
    await useCollections().revisions.insertOne(revisionDoc({ _id: `rs-${suffix}`, taskId: `t-rs-${suffix}` }))
    const originalId = randomUUID()
    const description = {
      protocolVersion: 1,
      connector: { language: 'python', version: '1.4.0' },
      schemas: {
        taskConfig: { type: 'object', properties: { apiKey: { type: 'string', writeOnly: true }, greeting: { type: 'string', default: 'Hi' } }, additionalProperties: false },
        scanConfig: { type: 'object', properties: {}, additionalProperties: false },
        analysisConfig: { type: 'object' },
        result: { type: 'object' },
      },
      schedule: { kind: 'custom' as const },
      secretPaths: { taskConfig: ['/apiKey'], scanConfig: [], analysisConfig: [], result: [] },
      uploadPaths: { taskConfig: [], scanConfig: [] },
      fileRefPaths: [],
      warnings: [],
    }
    const configs = await validateConfigs(description, { taskConfig: { apiKey: 'k-1' } }, { collection: 'scans', id: originalId })
    const original = await insertScan({
      _id: originalId,
      name: 'nightly',
      state: 'completed',
      revision: { ...scanDoc().revision, id: `rs-${suffix}` },
      taskConfig: configs.masked.taskConfig,
      secrets: { taskConfig: configs.secrets.taskConfig, scanConfig: {} },
      secretPaths: description.secretPaths,
      settings: { workers: 2, processes: 3 },
    })
    const clone = await restartScan(original, { settings: { workers: 5 } }, config)
    expect(clone).toMatchObject({
      state: 'creating',
      clonedFrom: original._id,
      name: 'nightly',
      round: 1,
      taskConfig: { apiKey: '***', greeting: 'Hi' },
      settings: { workers: 5, processes: 3 },
      scheduling: { state: 'pending', epoch: 0, confirmed: 0 },
    })
    expect(clone.secrets.taskConfig['/apiKey']).not.toBe(original.secrets.taskConfig['/apiKey'])
    const plaintext = restoreConfigSecrets({ taskConfig: clone.taskConfig, scanConfig: clone.scanConfig }, clone.secrets, { collection: 'scans', id: clone._id })
    expect(plaintext.taskConfig).toEqual({ apiKey: 'k-1', greeting: 'Hi' })
    expect(await useCollections().events.countDocuments({ scanId: original._id, type: 'scan.restarted', 'data.newScanId': clone._id })).toBe(1)
    await expect(restartScan({ ...original, state: 'deleting' }, {}, config)).rejects.toMatchObject({ data: { code: 'invalidState' } })
    await expect(restartScan({ ...original, revision: { ...original.revision, id: randomUUID() } }, {}, config)).rejects.toMatchObject({ data: { code: 'revisionUnavailable' } })
  })

  it('scheduler supervision raises schedulerRestarting and fails scheduling above the restart limit', async () => {
    const supervisor = new SchedulerSupervisor({ ...useCollections(), config, log })
    const scan = await insertScan({ scheduling: { state: 'running', epoch: 2, restarts: 1, confirmed: 0 } })
    await useCollections().workers.insertOne(workerDoc(scan._id, { role: 'scheduler', epoch: 2, state: 'backoff', nodeId: 'n1' }))
    await supervisor.run()
    expect((await reload(scan._id)).conditions).toMatchObject([{ type: 'schedulerRestarting', details: { restarts: 1 } }])

    // A running scheduler may be restarting in process: its state poll clears the condition, never supervision.
    await useCollections().workers.updateOne({ scanId: scan._id }, { $set: { state: 'running' } })
    await supervisor.run()
    expect((await reload(scan._id)).conditions).toMatchObject([{ type: 'schedulerRestarting', details: { restarts: 1 } }])

    // a crash of the current scheduler is counted once, however often the supervisor looks at it
    const crashAt = new Date(Date.now() + 1000)
    await useCollections().workers.updateOne(
      { scanId: scan._id },
      { $set: { state: 'backoff', container: { id: 'c', name: 'scantor-w-c', startedAt: null, restarts: 1, lastExit: { exitCode: 137, oomKilled: true, at: crashAt, logTail: '' }, nextRestartAt: null } } },
    )
    await supervisor.run()
    await supervisor.run()
    expect((await reload(scan._id)).scheduling.restarts).toBe(2)
    expect((await reload(scan._id)).conditions).toMatchObject([{ type: 'schedulerRestarting', details: { restarts: 2 } }])
    // an exit with code 0 (drain, stop) is never a crash
    await useCollections().workers.updateOne({ scanId: scan._id }, { $set: { 'container.lastExit': { exitCode: 0, oomKilled: false, at: new Date(Date.now() + 2000), logTail: '' } } })
    await supervisor.run()
    expect((await reload(scan._id)).scheduling.restarts).toBe(2)

    await useCollections().scans.updateOne({ _id: scan._id }, { $set: { 'scheduling.restarts': config.schedulerMaxRestarts + 1 } })
    await supervisor.run()
    const failed = await reload(scan._id)
    expect(failed).toMatchObject({ state: 'failed', stateReason: { code: 'schedulingFailed' }, scheduling: { state: 'failed', error: { phase: 'schedule', retryable: false } } })
    expect(failed.conditions.map((condition) => condition.type)).toEqual(['schedulingFailed'])
  })

  it('housekeeping raises brokerAlarm and clockSkew on running scans and clears them', async () => {
    const node = nodeDoc({ name: `skew-${suffix}`, builtIn: false, cordoned: true, tokenHash: randomBytes(32).toString('hex') })
    node.info!.clockOffsetMs = 3500
    await useCollections().nodes.insertOne(node)
    const scan = await insertScan()
    await useCollections().workers.insertOne(workerDoc(scan._id, { state: 'running', nodeId: node._id }))
    await reconcileHousekeepingConditions(useCollections(), ['memory'])
    expect((await reload(scan._id)).conditions.map((condition) => [condition.type, condition.details])).toEqual([
      ['brokerAlarm', { alarms: ['memory'] }],
      ['clockSkew', { nodeId: node._id, offsetMs: 3500 }],
    ])
    await useCollections().nodes.updateOne({ _id: node._id }, { $set: { 'info.clockOffsetMs': 10 } })
    await reconcileHousekeepingConditions(useCollections(), [])
    expect((await reload(scan._id)).conditions).toEqual([])
    const types = (await useCollections().events.find({ scanId: scan._id }).sort({ at: 1 }).toArray()).map((event) => event.type)
    expect(types).toEqual(['scan.conditionRaised', 'scan.conditionRaised', 'scan.conditionCleared', 'scan.conditionCleared'])
  })

  it('worker logs request a fresh tail from the node and return it once collected', async () => {
    const node = nodeDoc({ name: `logs-${suffix}`, builtIn: false, cordoned: true, tokenHash: randomBytes(32).toString('hex') })
    await useCollections().nodes.insertOne(node)
    const scan = await insertScan()
    const worker = workerDoc(scan._id, { state: 'running', nodeId: node._id })
    await useCollections().workers.insertOne(worker)
    const event = {} as H3Event
    const options = { tailBytes: 65_536, waitSeconds: 0, userId: 'user-a' }

    const first = await getWorkerLogs(event, scan, worker._id, options)
    expect(first).toMatchObject({ text: '', pending: true, collectedAt: null })
    const requested = await useCollections().workers.findOne({ _id: worker._id })
    expect(requested?.logs).toMatchObject({ tailBytes: 65_536, text: null, truncated: false })
    expect((await useCollections().nodes.findOne({ _id: node._id }))?.assignmentsRev).toBe(1)

    await getWorkerLogs(event, scan, worker._id, options)
    expect((await useCollections().workers.findOne({ _id: worker._id }))?.logs?.requestId).toBe(requested?.logs?.requestId)
    expect((await useCollections().nodes.findOne({ _id: node._id }))?.assignmentsRev).toBe(1)

    // the node answers the request (POST /api/node/workers/{workerId}/logs)
    await useCollections().workers.updateOne({ _id: worker._id }, { $set: { 'logs.text': 'consuming\n', 'logs.collectedAt': new Date(), 'logs.truncated': true } })
    // the next call asks again and shows the previous tail until the node answered
    const collected = await getWorkerLogs(event, scan, worker._id, { ...options, tailBytes: 1024 })
    expect(collected).toMatchObject({ text: 'consuming\n', pending: true, truncated: true })
    expect(collected.collectedAt).not.toBeNull()
    expect((await useCollections().workers.findOne({ _id: worker._id }))?.logs).toMatchObject({ tailBytes: 1024, text: null })

    await expect(getWorkerLogs(event, scan, randomUUID(), options)).rejects.toMatchObject({ data: { code: 'notFound' } })
  })

  // ── placement ───────────────────────────────────────────────────────────────

  describe('placement', () => {
    it('creates, fences and assigns workers, wakes the node, then drains them on pause', async () => {
      const node = nodeDoc({ name: `builtin-${suffix}` })
      await useCollections().nodes.insertOne(node)
      const scan = await insertScan({ scheduling: { state: 'pending', epoch: 0, confirmed: 0 }, settings: { workers: 2, processes: 2 } })
      await runPlacement({ config, log })

      const workers = await useCollections().workers.find({ scanId: scan._id }).toArray()
      expect(workers.map((worker) => [worker.role, worker.state, worker.nodeId, worker.epoch, worker.processes.assigned]).sort()).toEqual([
        ['runner', 'assigned', node._id, 0, 2],
        ['runner', 'assigned', node._id, 0, 2],
        ['scheduler', 'assigned', node._id, 1, 1],
      ])
      for (const worker of workers) expect(worker.spec.specHash).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect((await reload(scan._id)).scheduling.epoch).toBe(1)
      expect((await useCollections().nodes.findOne({ _id: node._id }))?.assignmentsRev).toBeGreaterThan(0)
      expect(await useCollections().events.countDocuments({ scanId: scan._id, type: 'worker.placed' })).toBe(3)

      await runPlacement({ config, log })
      expect(await useCollections().workers.countDocuments({ scanId: scan._id })).toBe(3)

      await pauseScan(await reload(scan._id))
      await runPlacement({ config, log })
      const drained = await useCollections().workers.find({ scanId: scan._id }).toArray()
      expect(drained.every((worker) => worker.state === 'draining')).toBe(true)
      await useCollections().nodes.updateOne({ _id: node._id }, { $set: { state: 'offline' } })
    })

    it('keeps unplaceable workers pending with a workersPending condition', async () => {
      const scan = await insertScan({ settings: { nodeSelector: { pool: 'nowhere', labels: {} } } })
      await runPlacement({ config, log })
      const [worker] = await useCollections().workers.find({ scanId: scan._id }).toArray()
      expect(worker).toMatchObject({ state: 'pending', stateReason: { code: 'noNodes' } })
      expect((await reload(scan._id)).conditions).toMatchObject([{ type: 'workersPending', severity: 'warning', details: { count: 1, reasons: { noNodes: 1 } } }])
      await cancelScan(await reload(scan._id))
      await runPlacement({ config, log })
      expect((await useCollections().workers.findOne({ _id: worker!._id }))?.state).toBe('stopped')
      expect((await reload(scan._id)).conditions).toEqual([])
    })
  })

  // ── retry-failed ────────────────────────────────────────────────────────────

  it('retry-failed resets failed and lost analyses with a config and publishes them with backpressure', async () => {
    await useCollections().revisions.insertOne(revisionDoc({ _id: `rr-${suffix}`, taskId: `t-rr-${suffix}` }))
    const failedSeqs = Array.from({ length: 25 }, (_, index) => index + 10)
    // Cancelled a minute ago and no runner in flight: the cancelled round has settled (settleEarlierRounds).
    const cancelledAt = new Date(Date.now() - 60_000)
    const scan = await insertScan({
      state: 'cancelled',
      completedAt: cancelledAt,
      revision: { ...scanDoc().revision, id: `rr-${suffix}` },
      scheduling: { state: 'done', confirmed: 40 },
    })
    createdScans.push(scan._id)
    const { analyses } = useCollections()
    await analyses.insertMany([
      analysisDoc(scan._id, 0, 'succeeded'),
      analysisDoc(scan._id, 1, 'failed'),
      analysisDoc(scan._id, 2, 'lost'),
      analysisDoc(scan._id, 3, 'lost'),
      analysisDoc(scan._id, 4, 'cancelled'),
      ...failedSeqs.map((seq) => analysisDoc(scan._id, seq, 'failed')),
    ])
    await analyses.updateOne({ _id: `${scan._id}-3` }, { $unset: { config: '' } })

    const { scan: retrying, job } = await retryFailedAnalyses(scan)
    expect(retrying).toMatchObject({ state: 'running', round: 2, scheduling: { state: 'retrying' }, completedAt: null })
    expect(job).toMatchObject({ kind: 'scanRetryFailed', params: { round: 2, materialize: true, cancelledAt } })
    await expect(retryFailedAnalyses(retrying)).rejects.toMatchObject({ data: { code: 'invalidState' } })
    await topology().reconcile()

    // Fill the queue beyond x-max-length 3 first (quorum queues accept a burst and nack only once they are over the
    // limit): every publish of the job is nacked until the consumer below drains the queue, then republished.
    const filler = await (await useAmqp('reconciler')).createConfirmChannel()
    for (let index = 0; index < 5; index++) filler.publish('scantor.analyses', scan._id, Buffer.from('{"filler":true}'), { userId: config.rabbitmqUser })
    await filler.waitForConfirms()
    await filler.close()

    const saved: SavedJobState = { cursor: {}, progress: { done: 0, total: null } }
    const started = Date.now()
    const handler = scanRetryFailedJobKind.handler(job, jobContext(job, saved))
    await new Promise((resolve) => setTimeout(resolve, 800))
    const received = new Map<number, Record<string, unknown>>()
    const consumer = await (await useAmqp('reconciler')).createChannel()
    await consumer.consume(scanQueueName(scan._id), (message: ConsumeMessage | null) => {
      if (!message) return
      const body = JSON.parse(message.content.toString('utf8')) as Record<string, unknown>
      if (body.filler !== true) received.set(body.seq as number, body)
      consumer.ack(message)
    })
    await handler
    expect(Date.now() - started).toBeGreaterThan(1500)
    for (let waited = 0; received.size < 27 && waited < 5000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100))
    await consumer.close()

    expect([...received.keys()].sort((a, b) => a - b)).toEqual([1, 2, ...failedSeqs])
    for (const body of received.values()) expect(body).toMatchObject({ v: 1, round: 2, attempt: 1, scanId: scan._id, config: { seq: body.seq } })
    expect(saved).toEqual({ cursor: { phase: 'finish', afterSeq: -1 }, progress: { done: 27, total: 27 } })

    const docs = await analyses.find({ scanId: scan._id }).sort({ seq: 1 }).toArray()
    const bySeq = new Map(docs.map((doc) => [doc.seq, [doc.status, doc.round]]))
    expect(bySeq.get(0)).toEqual(['succeeded', 1])
    expect(bySeq.get(1)).toEqual(['pending', 2])
    expect(bySeq.get(2)).toEqual(['pending', 2])
    expect(bySeq.get(3)).toEqual(['lost', 1])
    expect(bySeq.get(4)).toEqual(['cancelled', 1])
    expect(bySeq.get(5)).toEqual(['cancelled', 1])
    expect(bySeq.get(39)).toEqual(['cancelled', 1])
    expect(docs).toHaveLength(40)
    const after = await reload(scan._id)
    expect(after).toMatchObject({ state: 'running', round: 2, scheduling: { state: 'done' } })
    expect(await useCollections().events.countDocuments({ scanId: scan._id, type: 'scan.retryFailed', 'data.count': 27 })).toBe(1)

    // the retried analyses finish: the scan completes in round 2
    await analyses.updateMany({ scanId: scan._id, status: 'pending' }, { $set: { status: 'succeeded' } })
    expect(await tryCompleteScan(scan._id, 'ingestor')).toBe(true)
    expect(await reload(scan._id)).toMatchObject({ state: 'completed', stats: { succeeded: 28, lost: 1, cancelled: 11 } })
  }, 30_000)

  it('retry-failed answers nothingToRetry when no failed or lost analysis has a config', async () => {
    await useCollections().revisions.insertOne(revisionDoc({ _id: `rn-${suffix}`, taskId: `t-rn-${suffix}` }))
    const scan = await insertScan({ state: 'completed', revision: { ...scanDoc().revision, id: `rn-${suffix}` }, scheduling: { confirmed: 1 } })
    await useCollections().analyses.insertOne(analysisDoc(scan._id, 0, 'cancelled'))
    await expect(retryFailedAnalyses(scan)).rejects.toMatchObject({ data: { code: 'nothingToRetry' } })
  })

  // ── stall detection ─────────────────────────────────────────────────────────

  it('stall detection gap-fills lost analyses and completes the scan', async () => {
    const scan = await insertScan({ scheduling: { state: 'done', confirmed: 5 } })
    const { analyses } = useCollections()
    await analyses.insertMany([analysisDoc(scan._id, 0, 'succeeded'), analysisDoc(scan._id, 1, 'succeeded'), analysisDoc(scan._id, 2, 'pending')])
    const detector = new StallDetector({ ...useCollections(), stallAfterMs: 0, log })
    const lostBefore = analysesCompleted.get({ status: 'lost' })
    await detector.run(new Map([[scan._id, { ready: 0, unacked: 0, delayed: 0, consumers: 0 }]]))
    expect(analysesCompleted.get({ status: 'lost' })).toBe(lostBefore + 3)

    const docs = await analyses.find({ scanId: scan._id }).sort({ seq: 1 }).toArray()
    expect(docs.map((doc) => [doc.seq, doc.status, doc.config !== undefined])).toEqual([
      [0, 'succeeded', true],
      [1, 'succeeded', true],
      [2, 'lost', true],
      [3, 'lost', false],
      [4, 'lost', false],
    ])
    expect(docs[3]?.error).toMatchObject({ type: 'platform', phase: 'platform', retryable: false })
    const after = await reload(scan._id)
    expect(after).toMatchObject({ state: 'completed', stateReason: { code: 'stalled' }, stats: { succeeded: 2, lost: 3 } })
    expect(after.conditions).toMatchObject([{ type: 'stalled', details: { lost: 3 } }])
    expect(await useCollections().events.countDocuments({ scanId: scan._id, type: 'scan.lostAnalyses', 'data.count': 3 })).toBe(1)
  })

  it('stall detection waits while messages remain in the queue', async () => {
    const scan = await insertScan({ scheduling: { state: 'done', confirmed: 2 } })
    const detector = new StallDetector({ ...useCollections(), stallAfterMs: 0, log })
    await detector.run(new Map([[scan._id, { ready: 0, unacked: 0, delayed: 1, consumers: 0 }]]))
    expect((await reload(scan._id)).state).toBe('running')
    expect(await useCollections().analyses.countDocuments({ scanId: scan._id })).toBe(0)
  })

  // ── delete ──────────────────────────────────────────────────────────────────

  it('the scanDelete job removes everything of the scan and leaves a tombstone', async () => {
    const scan = await insertScan({ state: 'completed', scheduling: { confirmed: 3 }, secrets: { taskConfig: { '/k': 'enc:v1:a:b' }, scanConfig: {} } })
    createdScans.push(scan._id)
    const { analyses, workers, events, exports, jobs } = useCollections()
    await analyses.insertMany([0, 1, 2].map((seq) => analysisDoc(scan._id, seq, 'succeeded')))
    await workers.insertOne(workerDoc(scan._id, { state: 'stopped' }))
    await events.insertOne({ _id: randomUUID(), at: new Date(), type: 'scan.created', level: 'info', userId: 'user-a', scanId: scan._id, message: 'x' })
    const exportKey = `exports/user-a/${randomUUID()}.jsonl`
    await putObject(exportKey, 'x', 'application/x-ndjson')
    await exports.insertOne({
      _id: randomUUID(), userId: 'user-a', scanId: scan._id, format: 'jsonl', filter: {}, fields: null, afterSeq: null, state: 'ready', key: exportKey,
      bytes: 1, rows: 1, error: null, jobId: randomUUID(), createdAt: new Date(), finishedAt: new Date(), updatedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000),
    })
    const fileKey = `files/${scan._id}/0/${randomUUID()}/${randomUUID()}/a.txt`
    await putObject(fileKey, 'file', 'text/plain')

    const { scan: deleting, job } = await deleteScan(scan)
    expect(deleting.state).toBe('deleting')
    expect((await deleteScan(deleting)).job._id).toBe(job._id)
    const stored = await jobs.findOne({ _id: job._id })
    const run = scanDeleteJobKind.handler(stored!, jobContext(stored!))
    // a result ingested before the ingestor's cache saw `deleting`; the final sweep removes it
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await analyses.insertOne(analysisDoc(scan._id, 9, 'succeeded'))
    await run

    expect(await analyses.countDocuments({ scanId: scan._id })).toBe(0)
    expect(await workers.countDocuments({ scanId: scan._id })).toBe(0)
    expect(await events.countDocuments({ scanId: scan._id })).toBe(0)
    expect(await exports.countDocuments({ scanId: scan._id })).toBe(0)
    expect(await objectExists(exportKey)).toBe(false)
    expect(await objectExists(fileKey)).toBe(false)
    const tombstone = await reload(scan._id)
    expect(tombstone).toMatchObject({ state: 'deleted', secrets: { taskConfig: {}, scanConfig: {} }, taskConfig: {}, scanConfig: {} })
    expect(tombstone.purgeAfter!.getTime()).toBeGreaterThan(Date.now() + (config.tombstoneDays - 1) * 86_400_000)
  }, 40_000)

  it('the reconciler loop converges a new scan to running, places its workers and removes its topology on cancel', async () => {
    // its own pool, so the scans of earlier tests (pool `shared`) never take its capacity
    const pool = `loop-${suffix}`
    await useCollections().nodes.insertOne(nodeDoc({ name: pool, pool, builtIn: false, endpointProfile: 'public', tokenHash: randomBytes(32).toString('hex') }))
    const reconciler = new ScansReconciler({ config, log, signal: new AbortController().signal })
    reconciler.start()
    try {
      const scan = await insertScan({ state: 'creating', startedAt: null, scheduling: { state: 'pending', confirmed: 0, epoch: 0 }, settings: { workers: 1, nodeSelector: { pool, labels: {} } } })
      createdScans.push(scan._id)
      await waitFor(async () => (await reload(scan._id)).state === 'running', 20_000, 'the scan to run')
      await waitFor(async () => (await useCollections().workers.countDocuments({ scanId: scan._id, state: 'assigned' })) === 2, 20_000, 'two assigned workers')
      expect((await reload(scan._id)).scheduling.epoch).toBe(1)

      await cancelScan(await reload(scan._id))
      await waitFor(async () => (await useRabbitmqManagement().getQueue(RABBITMQ_VHOST, scanQueueName(scan._id))) === null, 20_000, 'the queue removal')
      await waitFor(async () => (await useCollections().workers.countDocuments({ scanId: scan._id, state: 'draining' })) === 2, 20_000, 'draining workers')
      expect((await useRabbitmqManagement().listUsers()).some((user) => user.name === scanAmqpUser(scan._id))).toBe(false)
    } finally {
      await reconciler.stop()
    }
    expect(await useCollections().locks.countDocuments({ _id: 'reconciler' })).toBe(0)
  }, 60_000)

  it('user purge cancels and deletes every scan of the user without tombstones', async () => {
    const userId = `purged-${suffix}`
    const running = await insertScan({ userId })
    const completed = await insertScan({ userId, state: 'completed' })
    createdScans.push(running._id, completed._id)
    await topology().reconcile()
    await useCollections().analyses.insertMany([analysisDoc(running._id, 0, 'succeeded', { userId }), analysisDoc(completed._id, 0, 'failed', { userId })])
    const controller = new AbortController()
    await purgeUserScans({ userId, config, log, signal: controller.signal, job: {} as JobDoc })
    expect(await useCollections().scans.countDocuments({ userId })).toBe(0)
    expect(await useCollections().analyses.countDocuments({ scanId: { $in: [running._id, completed._id] } })).toBe(0)
    expect(await useRabbitmqManagement().getQueue(RABBITMQ_VHOST, scanQueueName(running._id))).toBeNull()
  }, 40_000)
})
