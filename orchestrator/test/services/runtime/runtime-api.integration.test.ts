import { randomUUID } from 'node:crypto'
import { HeadObjectCommand } from '@aws-sdk/client-s3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getScanInflight } from '../../../server/services/inflight'
import { closeAssignmentWaiters } from '../../../server/services/nodes/assignments'
import { analysesStatus } from '../../../server/services/runtime/analyses'
import { handleBootstrap } from '../../../server/services/runtime/bootstrap'
import { recordRuntimeError } from '../../../server/services/runtime/errors'
import { recordCheckpoint, recordResolution, recordSchedulingDone } from '../../../server/services/runtime/scheduler'
import { handleRuntimeState } from '../../../server/services/runtime/state'
import { analysisFileKey, handlePresign, resetStorageUsageCache } from '../../../server/services/runtime/uploads'
import type { NodeDoc, ScanDoc } from '../../../server/types/documents'
import type { Config } from '../../../server/utils/config'
import { useKeys } from '../../../server/utils/keys'
import { useCollections } from '../../../server/utils/mongo'
import type { WorkerPrincipal } from '../../../server/utils/principal'
import { ensureBucket, s3Bucket, useS3 } from '../../../server/utils/s3'
import { configSecretAad, encryptSecret } from '../../../server/utils/secrets'
import { resolveWorkerToken } from '../../../server/utils/worker-tokens'
import { nodeDoc, recordingLogger, scanDoc, workerDoc } from '../nodes/helpers'
import {
  connectIntegrationDatabase,
  disconnectIntegrationDatabase,
  discoverEnvironment,
  integrationEnabled,
  MONGO_IMAGE,
  requireImages,
  RUSTFS_IMAGE,
  startMongo,
  startRustfs,
  TestContainers,
} from '../nodes/integration'

/*
 * The runtime API against a real MongoDB replica set and RustFS (docs/api.md §8, docs/runtime.md §4, §5, §8.8, §11,
 * docs/architecture.md §8, §11.5, security.md ING-5, MC-3, SEC-1): bootstrap per role and endpoint profile with
 * decrypted writeOnly secrets, state polls feeding the in-flight store, presigned uploads accepted by RustFS with
 * exactly the signed headers, redelivery status, the epoch-fenced scheduler routes and error reports.
 */

const log = recordingLogger()
const PUBLIC_S3 = 'http://s3.scantor.example.com:9000'

async function expectApiError(promise: Promise<unknown>, code: string): Promise<Record<string, unknown> | undefined> {
  try {
    await promise
  } catch (error) {
    const data = (error as { data?: { code?: string; details?: Record<string, unknown> } }).data
    expect(data?.code).toBe(code)
    return data?.details
  }
  throw new Error(`expected ${code}`)
}

describe.skipIf(!integrationEnabled)('runtime API against MongoDB and RustFS', () => {
  let containers: TestContainers
  let config: Config
  const internalNode = nodeDoc({ _id: randomUUID(), name: 'it-builtin', builtIn: true, endpointProfile: 'internal', tokenHash: 'a'.repeat(64) })
  const publicNode = nodeDoc({ _id: randomUUID(), name: 'it-remote', tokenHash: 'b'.repeat(64) })
  const scanId = randomUUID()
  const schedulerId = randomUUID()
  const runnerId = randomUUID()
  const internalRunnerId = randomUUID()

  async function principal(workerId: string): Promise<WorkerPrincipal> {
    const worker = (await useCollections().workers.findOne({ _id: workerId }))!
    const resolved = await resolveWorkerToken(useKeys().workerToken(worker._id, worker.scanId, worker.role, worker.nodeId!))
    if (!resolved) throw new Error(`worker ${workerId} has no valid token`)
    return resolved
  }

  beforeAll(async () => {
    const env = await discoverEnvironment()
    await requireImages(env.docker, [MONGO_IMAGE, RUSTFS_IMAGE])
    containers = new TestContainers(env)
    const [mongo, rustfs] = await Promise.all([startMongo(containers, 'runtime-api-mongo'), startRustfs(containers, 'runtime-api-rustfs')])
    config = await connectIntegrationDatabase(mongo, {
      SCANTOR_S3_INTERNAL_URL: rustfs.url,
      SCANTOR_S3_PUBLIC_URL: PUBLIC_S3,
      SCANTOR_S3_ACCESS_KEY: rustfs.accessKey,
      SCANTOR_S3_SECRET_KEY: rustfs.secretKey,
      SCANTOR_AMQP_PUBLIC_URL: 'amqps://amqp.scantor.example.com:443',
      SCANTOR_SCHEDULER_MAX_RESTARTS: '2',
    })
    await ensureBucket(log)

    const { nodes, scans, revisions, workers } = useCollections()
    await nodes.insertMany([internalNode, publicNode] as NodeDoc[])
    const scan: ScanDoc = scanDoc({ _id: scanId })
    scan.scheduling = { ...scan.scheduling, state: 'pending', epoch: 1, confirmed: 0, tailHash: null }
    scan.secrets = {
      taskConfig: { '/apiKey': encryptSecret(JSON.stringify('real-secret-value'), 'config-secrets', configSecretAad('scans', scanId, 'taskConfig', '/apiKey')) },
      scanConfig: {},
    }
    await scans.insertOne(scan)
    await revisions.insertOne({
      _id: scan.revision.id,
      userId: scan.userId,
      taskId: scan.task.id,
      taskName: scan.task.name,
      number: 3,
      state: 'ready',
      source: { kind: 'workspace', packSha256: 'x', packBytes: 1, fileCount: 1 },
      snapshotKey: 'k',
      manifest: { scantor: 1, name: 'origins', language: 'typescript', entry: 'src/main.ts' },
      privileged: false,
      buildLogKey: 'b',
      errors: [],
      jobId: randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await workers.insertMany([
      workerDoc(schedulerId, { scanId, nodeId: internalNode._id, role: 'scheduler', epoch: 1, state: 'starting', processes: { desired: 1, assigned: 1, applied: 1, running: null } }),
      workerDoc(runnerId, { scanId, nodeId: publicNode._id, role: 'runner', state: 'starting', processes: { desired: 4, assigned: 4, applied: 2, running: null } }),
      workerDoc(internalRunnerId, { scanId, nodeId: internalNode._id, role: 'runner', state: 'running', processes: { desired: 1, assigned: 1, applied: 1, running: 1 } }),
    ])
  }, 180_000)

  afterAll(async () => {
    await closeAssignmentWaiters()
    await disconnectIntegrationDatabase()
    await containers?.removeAll()
  })

  describe('bootstrap', () => {
    it('gives the scheduler its configs with secrets, the internal AMQP URL and the scheduler part', async () => {
      const bootstrap = await handleBootstrap(await principal(schedulerId), '1.4.0', config, log)
      expect(bootstrap).toMatchObject({
        action: 'run',
        worker: { id: schedulerId, role: 'scheduler', scanId, nodeId: internalNode._id, epoch: 1 },
        scan: { taskConfig: { expectedStatus: 200, apiKey: 'real-secret-value' }, scanConfig: { list: 'latest' }, settings: { processes: 1 } },
        revision: { entry: 'src/main.ts', protocolVersion: 1 },
        amqp: { url: 'amqp://rabbitmq:5672', username: `scan-${scanId}`, password: useKeys().amqpPassword(scanId), queue: `scantor.scan.${scanId}` },
        scheduler: { restarts: 0, checkpoint: { confirmed: 0, tailHash: null }, resolved: {}, uploads: {} },
      })
      const { workers, scans, events } = useCollections()
      expect(await workers.findOne({ _id: schedulerId })).toMatchObject({ state: 'running', runtime: { version: '1.4.0', protocolVersion: null } })
      expect((await scans.findOne({ _id: scanId }))?.scheduling.state).toBe('running')
      expect(await events.countDocuments({ type: 'worker.started', workerId: schedulerId })).toBe(1)
    })

    it('gives a remote runner the public profile, only the task config and its allowed processes', async () => {
      const bootstrap = await handleBootstrap(await principal(runnerId), '1.3.9', config, log)
      expect(bootstrap.amqp).toMatchObject({ url: 'amqps://amqp.scantor.example.com:443' })
      expect(bootstrap.scan).not.toHaveProperty('scanConfig')
      expect(bootstrap).toMatchObject({ worker: { role: 'runner', epoch: 0 }, scan: { settings: { processes: 2 } }, scheduler: null })
    })

    it('stores a version header literally', async () => {
      await handleBootstrap(await principal(internalRunnerId), '$where', config, log)
      expect((await useCollections().workers.findOne({ _id: internalRunnerId }))?.runtime?.version).toBe('$where')
    })

    it('stops workers of a scan that is not running', async () => {
      const { scans } = useCollections()
      await scans.updateOne({ _id: scanId }, { $set: { state: 'paused' } })
      try {
        expect(await handleBootstrap(await principal(runnerId), '1.4.0', config, log)).toMatchObject({ action: 'stop', worker: { id: runnerId } })
      } finally {
        await scans.updateOne({ _id: scanId }, { $set: { state: 'running' } })
      }
    })
  })

  describe('state polls', () => {
    it('records busy slots in memory and answers with the action and processes', async () => {
      const response = await handleRuntimeState(
        await principal(runnerId),
        {
          processes: { running: 2, busy: 1 },
          busy: [{ seq: 1234, round: 1, attempt: 2, executionId: randomUUID(), startedAt: new Date().toISOString(), progress: { fraction: 0.25 } }],
          consuming: true,
          clockOffsetMs: -12,
          tmpFreeBytes: 9_663_676_416,
        },
        config,
        log,
      )
      expect(response).toMatchObject({ action: 'run', processes: 2, scanState: 'running', nextPollMs: 5000 })
      expect(getScanInflight(scanId).items).toEqual([expect.objectContaining({ analysisId: `${scanId}-1234`, seq: 1234, workerId: runnerId, nodeId: publicNode._id, progress: { fraction: 0.25 } })])
      expect(await useCollections().workers.findOne({ _id: runnerId })).toMatchObject({ processes: { running: 2 }, runtime: { version: '1.3.9' } })
    })

    it('stores the publish counters of a scheduler on its worker, and none for a runner', async () => {
      const counters = { published: 42_100, confirmed: 42_000, nacked: 3, backpressure: true }
      const report = { processes: { running: 1, busy: 1 }, busy: [], consuming: false, clockOffsetMs: 0, tmpFreeBytes: 1, scheduler: counters }
      await handleRuntimeState(await principal(schedulerId), report, config, log)
      expect((await useCollections().workers.findOne({ _id: schedulerId }))?.runtime?.scheduler).toEqual(counters)
      // A poll without counters keeps the last ones.
      await handleRuntimeState(await principal(schedulerId), { ...report, scheduler: null }, config, log)
      expect((await useCollections().workers.findOne({ _id: schedulerId }))?.runtime?.scheduler).toEqual(counters)
      await handleRuntimeState(await principal(runnerId), { ...report, processes: { running: 2, busy: 0 } }, config, log)
      expect((await useCollections().workers.findOne({ _id: runnerId }))?.runtime?.scheduler ?? null).toBeNull()
    })

    it('drains on pause', async () => {
      const { scans } = useCollections()
      await scans.updateOne({ _id: scanId }, { $set: { state: 'paused' } })
      try {
        const response = await handleRuntimeState(await principal(runnerId), { processes: { running: 2, busy: 0 }, busy: [], consuming: false, clockOffsetMs: 0, tmpFreeBytes: 1 }, config, log)
        expect(response.action).toBe('drain')
      } finally {
        await scans.updateOne({ _id: scanId }, { $set: { state: 'running' } })
      }
    })
  })

  describe('uploads', () => {
    const executionId = randomUUID()
    const fileId = randomUUID()

    it('presigns PUTs that RustFS accepts with exactly the signed headers, inside the scan prefix', async () => {
      const content = Buffer.from('<html>not inline</html>')
      const response = await handlePresign(
        await principal(internalRunnerId),
        { seq: 7, round: 1, attempt: 1, executionId, files: [{ fileId, name: '../../index.html', size: content.length, sha256: 'a'.repeat(64), contentType: 'text/html' }] },
        config,
      )
      const [file] = response.files
      expect(file).toMatchObject({ fileId, name: '../../index.html', method: 'PUT' })
      expect(file!.headers).toEqual({
        'Content-Type': 'text/html',
        'Content-Length': String(content.length),
        'x-amz-meta-file-id': fileId,
        'x-amz-meta-name': '..%2F..%2Findex.html',
      })
      const key = analysisFileKey(scanId, 7, executionId, fileId, '../../index.html')
      expect(key).toBe(`files/${scanId}/7/${executionId}/${fileId}/.._.._index.html`)
      expect(file!.url.startsWith(`${config.s3InternalUrl}/${s3Bucket()}/${key}?`)).toBe(true)

      const { 'Content-Length': _length, ...withoutLength } = file!.headers
      const tooLong = await fetch(file!.url, { method: 'PUT', headers: withoutLength, body: Buffer.concat([content, Buffer.from('extra')]) })
      expect(tooLong.status).toBe(403)
      const { 'x-amz-meta-name': _name, ...withoutName } = file!.headers
      expect((await fetch(file!.url, { method: 'PUT', headers: withoutName, body: content })).status).toBe(403)
      const put = await fetch(file!.url, { method: 'PUT', headers: file!.headers, body: content })
      expect(put.status).toBe(200)
      const head = await useS3().send(new HeadObjectCommand({ Bucket: s3Bucket(), Key: key }))
      expect(head.ContentLength).toBe(content.length)
      expect(head.ContentType).toBe('text/html')
      expect(head.Metadata).toEqual({ 'file-id': fileId, name: '..%2F..%2Findex.html' })
    })

    it('signs for the public S3 endpoint on remote nodes', async () => {
      const response = await handlePresign(
        await principal(runnerId),
        { seq: 8, round: 1, attempt: 1, executionId, files: [{ fileId: randomUUID(), name: 'a.png', size: 10, sha256: 'b'.repeat(64), contentType: 'image/png' }] },
        config,
      )
      expect(response.files[0]!.url.startsWith(`${PUBLIC_S3}/`)).toBe(true)
    })

    it('enforces the owner\'s storage quota', async () => {
      resetStorageUsageCache()
      const quota = { ...config, userStorageQuotaBytes: 100 }
      const details = await expectApiError(
        handlePresign(await principal(runnerId), { seq: 9, round: 1, attempt: 1, executionId, files: [{ fileId: randomUUID(), name: 'big.bin', size: 101, sha256: 'c'.repeat(64), contentType: 'application/octet-stream' }] }, quota),
        'quotaExceeded',
      )
      expect(details).toMatchObject({ limit: 100 })
      resetStorageUsageCache()
    })

    it('rejects invalid file ids and rounds newer than the scan', async () => {
      await expectApiError(
        handlePresign(await principal(runnerId), { seq: 1, round: 1, attempt: 1, executionId, files: [{ fileId: 'nope', name: 'a', size: 1, sha256: 'd'.repeat(64), contentType: 'text/plain' }] }, config),
        'validationFailed',
      )
      await expectApiError(handlePresign(await principal(runnerId), { seq: 1, round: 5, attempt: 1, executionId, files: [] }, config), 'validationFailed')
    })
  })

  it('answers the status of redelivered analyses of its own scan only', async () => {
    const { analyses } = useCollections()
    const base = { scanId, userId: scanDoc().userId, attempts: [], files: [], createdAt: new Date(), updatedAt: new Date() }
    await analyses.insertMany([
      { ...base, _id: `${scanId}-1`, seq: 1, round: 1, status: 'succeeded', attempt: 2 },
      { ...base, _id: `${scanId}-2`, seq: 2, round: 1, status: 'retrying', attempt: 1 },
      { ...base, _id: `${randomUUID()}-3`, scanId: randomUUID(), seq: 3, round: 1, status: 'failed', attempt: 1 },
    ])
    expect(await analysesStatus(await principal(runnerId), [1, 2, 3])).toEqual({
      items: [
        { seq: 1, status: 'succeeded', round: 1, attempt: 2 },
        { seq: 2, status: 'retrying', round: 1, attempt: 1 },
        { seq: 3, status: null, round: null, attempt: null },
      ],
    })
  })

  describe('scheduler routes', () => {
    const hash = (n: number) => `sha256:${String(n).padStart(64, '0')}`

    it('stores a resolution once and returns the stored one afterwards', async () => {
      const scheduler = await principal(schedulerId)
      const input = { epoch: 1, key: 'schedule', template: 'tranco', scanConfig: { list: '262W9' }, provenance: { listId: '262W9', $note: 'kept' }, expectedTotal: 100_000 }
      expect(await recordResolution(scheduler, input, log)).toMatchObject({ stored: true, resolution: { template: 'tranco', scanConfig: { list: '262W9' }, expectedTotal: 100_000 } })
      const second = await recordResolution(scheduler, { ...input, scanConfig: { list: 'OTHER' } }, log)
      expect(second).toMatchObject({ stored: false, resolution: { scanConfig: { list: '262W9' } } })
      expect((await useCollections().scans.findOne({ _id: scanId }))?.stats.expectedTotal).toBe(100_000)
    })

    it('keeps the largest checkpoint and fences stale epochs', async () => {
      const scheduler = await principal(schedulerId)
      expect(await recordCheckpoint(scheduler, { epoch: 1, confirmed: 1000, tailHash: hash(1000) })).toMatchObject({ confirmed: 1000, tailHash: hash(1000) })
      expect(await recordCheckpoint(scheduler, { epoch: 1, confirmed: 500, tailHash: hash(500) })).toMatchObject({ confirmed: 1000, tailHash: hash(1000) })
      const details = await expectApiError(recordCheckpoint(scheduler, { epoch: 0, confirmed: 2000, tailHash: hash(2000) }), 'staleEpoch')
      expect(details).toEqual({ currentEpoch: 1 })
      // A newer scheduler epoch fences the old worker even with a matching body epoch.
      await useCollections().scans.updateOne({ _id: scanId }, { $set: { 'scheduling.epoch': 2 } })
      await expectApiError(recordCheckpoint(scheduler, { epoch: 1, confirmed: 2000, tailHash: hash(2000) }), 'staleEpoch')
      await useCollections().scans.updateOne({ _id: scanId }, { $set: { 'scheduling.epoch': 1 } })
    })

    it('counts retryable scheduler errors and fails scheduling above the limit', async () => {
      const scheduler = await principal(schedulerId)
      const error = { type: 'platform' as const, phase: 'schedule' as const, message: '$fetch failed', retryable: true, attempt: 1, at: new Date() }
      for (let restarts = 1; restarts <= 2; restarts++) {
        await recordRuntimeError(scheduler, { fatal: false, error }, config.schedulerMaxRestarts, log)
        expect((await useCollections().scans.findOne({ _id: scanId }))?.scheduling).toMatchObject({ restarts, state: 'running' })
      }
      const worker = await useCollections().workers.findOne({ _id: schedulerId })
      expect(worker?.runtime?.lastError).toMatchObject({ type: 'platform', message: '$fetch failed' })
      const scan = (await useCollections().scans.findOne({ _id: scanId }))!
      expect(scan.conditions.map((condition) => condition.type)).toContain('workerErrors')
      expect(await useCollections().events.countDocuments({ type: 'worker.error', workerId: schedulerId })).toBe(2)
      // The schedule restarts in process, so the worker stays running: the report raised schedulerRestarting.
      expect(scan.conditions.find((condition) => condition.type === 'schedulerRestarting')).toMatchObject({
        severity: 'warning',
        reason: 'restarting',
        details: { restarts: 2, error: { type: 'platform', phase: 'schedule', message: '$fetch failed' } },
      })
    })

    it('clears schedulerRestarting once a state poll shows the restarted schedule running', async () => {
      const { scans } = useCollections()
      const restarting = async () => (await scans.findOne({ _id: scanId }))!.conditions.find((condition) => condition.type === 'schedulerRestarting')
      const raisedAt = (at: Date) => scans.updateOne({ _id: scanId, 'conditions.type': 'schedulerRestarting' }, { $set: { 'conditions.$.updatedAt': at } })
      const poll = async (busy: number) =>
        handleRuntimeState(await principal(schedulerId), { processes: { running: 1, busy }, busy: [], consuming: false, clockOffsetMs: 0, tmpFreeBytes: 1 }, config, log)
      expect(await restarting()).toBeDefined()
      // Waiting out the restart backoff (no schedule run), or a poll built before the restart (less than 1 s after the report).
      await raisedAt(new Date())
      expect((await poll(0)).action).toBe('run')
      await poll(1)
      expect(await restarting()).toBeDefined()
      await raisedAt(new Date(Date.now() - 2000))
      await poll(0)
      expect(await restarting()).toBeDefined()
      await poll(1)
      expect(await restarting()).toBeUndefined()
      expect(await useCollections().events.countDocuments({ scanId, type: 'scan.conditionCleared', 'data.type': 'schedulerRestarting' })).toBe(1)
    })

    it('ends scheduling, drains the scheduler and is idempotent for its epoch', async () => {
      const scheduler = await principal(schedulerId)
      const { nodes, workers, scans } = useCollections()
      const revBefore = (await nodes.findOne({ _id: internalNode._id }))!.assignmentsRev
      const done = await recordSchedulingDone(scheduler, { epoch: 1, outcome: 'done', confirmed: 1200, tailHash: hash(1200), error: null }, log)
      expect(done.scheduling).toEqual({ state: 'done', confirmed: 1200 })
      expect((await workers.findOne({ _id: schedulerId }))?.state).toBe('draining')
      expect((await nodes.findOne({ _id: internalNode._id }))!.assignmentsRev).toBe(revBefore + 1)
      // The draining scheduler still holds a valid token; a repeated done answers the same.
      expect((await recordSchedulingDone(await principal(schedulerId), { epoch: 1, outcome: 'done', confirmed: 1200, tailHash: hash(1200), error: null }, log)).scheduling).toEqual({ state: 'done', confirmed: 1200 })
      expect((await scans.findOne({ _id: scanId }))?.scheduling).toMatchObject({ state: 'done', confirmed: 1200, tailHash: hash(1200) })
    })

    it('fails scheduling above SCANTOR_SCHEDULER_MAX_RESTARTS', async () => {
      const { scans, workers } = useCollections()
      const otherScan = randomUUID()
      const otherScheduler = randomUUID()
      const scan = scanDoc({ _id: otherScan })
      scan.scheduling = { ...scan.scheduling, state: 'running', epoch: 1, restarts: 2, confirmed: 0, tailHash: null }
      await scans.insertOne(scan)
      await workers.insertOne(workerDoc(otherScheduler, { scanId: otherScan, nodeId: internalNode._id, role: 'scheduler', epoch: 1, state: 'running' }))
      await recordRuntimeError(
        await principal(otherScheduler),
        { fatal: false, error: { type: 'taskError', phase: 'schedule', message: 'boom', retryable: true, attempt: 3, at: new Date() } },
        config.schedulerMaxRestarts,
        log,
      )
      const failed = (await scans.findOne({ _id: otherScan }))!
      expect(failed.scheduling).toMatchObject({ state: 'failed', restarts: 3, error: { retryable: false, phase: 'schedule' } })
      expect(failed.conditions.map((condition) => condition.type)).toContain('schedulingFailed')
      const response = await handleRuntimeState(await principal(otherScheduler), { processes: { running: 1, busy: 1 }, busy: [], consuming: false, clockOffsetMs: 0, tmpFreeBytes: 1 }, config, log)
      expect(response.action).toBe('stop')
    })
  })
})
