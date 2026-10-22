import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NodeHelloBody, NodeStatusBody } from '../../../shared/schemas/nodes'
import { createNode, deleteNode, listNodeEvents, listNodes, listNodeWorkers, revokeNodeToken, rotateNodeToken, updateNode } from '../../../server/services/nodes/admin'
import { buildNodeAssignments, closeAssignmentWaiters, notifyAssignmentsChanged, waitForAssignments } from '../../../server/services/nodes/assignments'
import { upsertBuiltinNode } from '../../../server/services/nodes/builtin'
import { handleHello, requireLeaseHolder } from '../../../server/services/nodes/hello'
import { storeWorkerLogs } from '../../../server/services/nodes/logs'
import { detectOfflineNodes } from '../../../server/services/nodes/offline'
import { handleStatus } from '../../../server/services/nodes/status'
import { nodeRepositories } from '../../../server/services/registry/token'
import type { Config } from '../../../server/utils/config'
import { useKeys } from '../../../server/utils/keys'
import { useCollections } from '../../../server/utils/mongo'
import { invalidateNodeTokenCache, resolveNodeToken } from '../../../server/utils/node-tokens'
import { resolveWorkerToken } from '../../../server/utils/worker-tokens'
import { DIGEST, recordingLogger, scanDoc, workerDoc } from './helpers'
import {
  connectIntegrationDatabase,
  disconnectIntegrationDatabase,
  discoverEnvironment,
  integrationEnabled,
  MONGO_IMAGE,
  requireImages,
  startMongo,
  TestContainers,
} from './integration'

/*
 * The node API and node administration against a real MongoDB replica set (docs/api.md §4.17, §7, docs/nodes.md
 * §5, §7, docs/auth.md §10.1, §10.2, docs/data-model.md §6.6, §6.7): the built-in node upsert, token lifecycle,
 * the instance lease, assignments with their long-poll and wake-ups (in process and through the change stream),
 * status snapshots, offline detection, log answers and the registry grants derived from assignments.
 */

const log = recordingLogger()
const ADMIN = randomUUID()

function hello(instanceId: string, overrides: Partial<NodeHelloBody['info']> = {}): NodeHelloBody {
  return {
    instanceId,
    version: '1.4.0',
    info: {
      hostname: 'it-node',
      os: 'linux',
      arch: 'arm64',
      kernel: '6.8.0',
      dockerVersion: '29.9.1',
      cpus: 8,
      memoryBytes: 16 * 1024 ** 3,
      diskFreeBytes: 100 * 1024 ** 3,
      dindMode: 'disabled',
      maxWorkers: 8,
      egressDenyApplied: true,
      ...overrides,
    },
    containers: [],
  }
}

function status(instanceId: string, workers: NodeStatusBody['workers'], clockOffsetMs = 0): NodeStatusBody {
  return {
    instanceId,
    appliedRev: 0,
    clockOffsetMs,
    info: { version: '1.4.0', cpus: 8, memoryBytes: 16 * 1024 ** 3, diskFreeBytes: 90 * 1024 ** 3, dindMode: 'disabled', maxWorkers: 8, egressDenyApplied: false },
    workers,
  }
}

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

describe.skipIf(!integrationEnabled)('node API against MongoDB', () => {
  let containers: TestContainers
  let config: Config

  beforeAll(async () => {
    const env = await discoverEnvironment()
    await requireImages(env.docker, [MONGO_IMAGE])
    containers = new TestContainers(env)
    const mongo = await startMongo(containers, 'node-api-mongo')
    config = await connectIntegrationDatabase(mongo, { SCANTOR_NODE_OFFLINE_AFTER: '60s', SCANTOR_PUBLIC_URL: 'https://scantor.example.com', SCANTOR_REGISTRY_PUBLIC_HOST: 'registry.example.com' })
  }, 180_000)

  afterAll(async () => {
    await closeAssignmentWaiters()
    await disconnectIntegrationDatabase()
    await containers?.removeAll()
  })

  describe('built-in node', () => {
    it('is upserted at every boot with the hash of the derived token', async () => {
      const first = await upsertBuiltinNode(useKeys(), log)
      const second = await upsertBuiltinNode(useKeys(), log)
      expect(second).toBe(first)
      const node = await useCollections().nodes.findOne({ _id: first })
      expect(node).toMatchObject({ name: 'builtin', builtIn: true, endpointProfile: 'internal', pool: 'shared', state: 'pending' })
      const principal = await resolveNodeToken(useKeys().builtinNodeToken())
      expect(principal?.node).toMatchObject({ id: first, builtIn: true, endpointProfile: 'internal' })
    })

    it('cannot be renamed, rotated, revoked or deleted', async () => {
      const node = (await useCollections().nodes.findOne({ builtIn: true }))!
      await expectApiError(updateNode(node._id, { name: 'renamed' }), 'builtInNode')
      await expectApiError(rotateNodeToken(node._id, log), 'builtInNode')
      await expectApiError(revokeNodeToken(node._id, log), 'builtInNode')
      await expectApiError(deleteNode(node._id, ADMIN, log), 'builtInNode')
      // Admin-owned attributes stay editable.
      expect((await updateNode(node._id, { cordoned: true, labels: { zone: 'master' } })).cordoned).toBe(true)
      await updateNode(node._id, { cordoned: false })
    })
  })

  describe('remote node lifecycle', () => {
    let nodeId: string
    let token: string

    it('creates a pending node and shows its token once with join instructions', async () => {
      const created = await createNode({ name: 'it-remote', pool: 'remote', labels: { zone: 'b' }, maxWorkers: 4 }, ADMIN, log)
      nodeId = created.node.id
      token = created.token
      expect(token).toMatch(/^snt_[A-Za-z0-9_-]{43}$/)
      expect(created.node).toMatchObject({ name: 'it-remote', state: 'pending', endpointProfile: 'public', pool: 'remote', maxWorkers: 4, activeWorkers: 0, tokenPrefix: token.slice(0, 8) })
      expect(created.node).not.toHaveProperty('tokenHash')
      expect(created.join.env).toEqual({ SCANTOR_URL: 'https://scantor.example.com', SCANTOR_NODE_TOKEN: token })
      await expectApiError(createNode({ name: 'it-remote', pool: 'shared', labels: {} }, ADMIN, log), 'alreadyExists')
      const stored = await useCollections().nodes.findOne({ _id: nodeId })
      expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify(stored)).not.toContain(token)
      expect((await listNodes({})).items.map((node) => node.name)[0]).toBe('builtin')
    })

    it('says hello: online, lease, info and the public profile configuration', async () => {
      const principal = (await resolveNodeToken(token))!
      expect(principal).not.toBeNull()
      const response = await handleHello(principal, hello('engine-a:1'), config, log)
      expect(response.node).toEqual({ id: nodeId, name: 'it-remote', builtIn: false, endpointProfile: 'public', pool: 'remote', labels: { zone: 'b' } })
      expect(response.config).toEqual({
        statusIntervalMs: 10_000,
        assignmentsWaitSeconds: 25,
        offlineAfterMs: 60_000,
        drainGraceMs: 30_000,
        registry: { host: 'registry.example.com', username: 'node' },
        minFreeDiskBytes: 5 * 1024 ** 3,
      })
      const node = (await useCollections().nodes.findOne({ _id: nodeId }))!
      expect(node).toMatchObject({ state: 'online', instance: { id: 'engine-a:1', version: '1.4.0' }, info: { arch: 'arm64', cpus: 8 } })
      expect((await listNodeEvents(nodeId, { type: 'node.' })).items.map((event) => event.type)).toContain('node.online')
    })

    it('lets a restarted daemon on the same engine take the lease over and refuses another engine', async () => {
      const principal = (await resolveNodeToken(token))!
      await handleHello(principal, hello('engine-a:2'), config, log)
      // The previous instance is no longer the lease holder.
      const details = await expectApiError(requireLeaseHolder(principal, 'engine-a:1', config.nodeOfflineAfterMs), 'nodeInstanceConflict')
      expect(details?.retryAfterMs).toBeGreaterThan(0)
      // A different engine while the lease lives.
      const conflict = await expectApiError(handleHello(principal, hello('engine-b:1'), config, log), 'nodeInstanceConflict')
      expect(conflict?.retryAfterMs).toBeGreaterThan(50_000)
      expect((await listNodeEvents(nodeId, { type: 'node.instanceConflict' })).items).toHaveLength(1)
      // An expired lease is granted to anyone.
      await useCollections().nodes.updateOne({ _id: nodeId }, { $set: { 'instance.lastSeenAt': new Date(Date.now() - 120_000) } })
      await handleHello(principal, hello('engine-b:1'), config, log)
      expect((await requireLeaseHolder(principal, 'engine-b:1', config.nodeOfflineAfterMs))._id).toBe(nodeId)
    })

    describe('with workers', () => {
      const scanId = randomUUID()
      const runner = randomUUID()
      const scheduler = randomUUID()
      const draining = randomUUID()

      beforeAll(async () => {
        const { scans, workers, revisions } = useCollections()
        const scan = scanDoc({ _id: scanId, conditions: [] })
        scan.revision.digest = DIGEST
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
          baseImage: { ref: 'ghcr.io/lonetis/scantor-base-js:1.4.0', digest: `sha256:${'0d1e2f3a'.repeat(8)}` },
          privileged: false,
          buildLogKey: 'b',
          errors: [],
          jobId: randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        await workers.insertMany([
          workerDoc(runner, { scanId, nodeId, state: 'assigned', processes: { desired: 2, assigned: 2, applied: null, running: null }, assignedAt: new Date(Date.now() - 2000) }),
          workerDoc(scheduler, { scanId, nodeId, role: 'scheduler', epoch: 1, state: 'running', processes: { desired: 1, assigned: 1, applied: 1, running: 1 }, assignedAt: new Date(Date.now() - 1000) }),
          workerDoc(draining, { scanId, nodeId, state: 'draining' }),
        ])
      })

      it('serves the complete desired set with valid worker tokens', async () => {
        const node = (await useCollections().nodes.findOne({ _id: nodeId }))!
        const response = await buildNodeAssignments(node, config)
        expect(response.rev).toBe(node.assignmentsRev)
        expect(response.workers.map((worker) => worker.workerId)).toEqual([runner, scheduler])
        const [first] = response.workers
        expect(first).toMatchObject({
          scanId,
          role: 'runner',
          image: `registry.example.com/${workerDoc(runner).spec.repository}@${DIGEST}`,
          baseImage: `ghcr.io/lonetis/scantor-base-js@sha256:${'0d1e2f3a'.repeat(8)}`,
          processes: 2,
          resources: { nanoCpus: 2_000_000_000, memoryBytes: 1_342_177_280 },
          env: { SCANTOR_URL: 'https://scantor.example.com' },
        })
        const principal = await resolveWorkerToken(first!.env.SCANTOR_WORKER_TOKEN)
        expect(principal?.worker).toEqual({ id: runner, scanId, userId: workerDoc(runner).userId, role: 'runner', nodeId, epoch: 0 })
        // A token of another node's worker identity does not validate.
        expect(await resolveWorkerToken(useKeys().workerToken(runner, scanId, 'runner', randomUUID()))).toBeNull()
      })

      it('grants registry pulls on the repositories of active assignments only', async () => {
        expect([...(await nodeRepositories(nodeId))]).toEqual([workerDoc(runner).spec.repository])
        expect([...(await nodeRepositories(randomUUID()))]).toEqual([])
      })

      it('holds a long-poll until the revision changes in this process', async () => {
        const node = (await useCollections().nodes.findOne({ _id: nodeId }))!
        const started = Date.now()
        const waiting = waitForAssignments(nodeId, { rev: node.assignmentsRev, waitMs: 20_000, signal: new AbortController().signal })
        setTimeout(() => void notifyAssignmentsChanged(nodeId), 200)
        const woken = await waiting
        expect(woken!.assignmentsRev).toBe(node.assignmentsRev + 1)
        expect(Date.now() - started).toBeLessThan(3000)
      })

      it('wakes a long-poll when another process bumps the revision (change stream)', async () => {
        const node = (await useCollections().nodes.findOne({ _id: nodeId }))!
        const started = Date.now()
        const waiting = waitForAssignments(nodeId, { rev: node.assignmentsRev, waitMs: 20_000, signal: new AbortController().signal })
        setTimeout(() => void useCollections().nodes.updateOne({ _id: nodeId }, { $inc: { assignmentsRev: 1 } }), 500)
        expect((await waiting)!.assignmentsRev).toBe(node.assignmentsRev + 1)
        expect(Date.now() - started).toBeLessThan(3000)
      })

      it('returns at the deadline without a change, and at once when the revision is already newer', async () => {
        const node = (await useCollections().nodes.findOne({ _id: nodeId }))!
        const started = Date.now()
        await waitForAssignments(nodeId, { rev: node.assignmentsRev, waitMs: 1500, signal: new AbortController().signal })
        expect(Date.now() - started).toBeGreaterThanOrEqual(1400)
        const quick = Date.now()
        await waitForAssignments(nodeId, { rev: node.assignmentsRev - 1, waitMs: 20_000, signal: new AbortController().signal })
        expect(Date.now() - quick).toBeLessThan(500)
      })

      it('applies a status snapshot: transitions, crash loop, drains and node info', async () => {
        const node = (await useCollections().nodes.findOne({ _id: nodeId }))!
        const exitAt = new Date(Date.now() - 1000).toISOString()
        const response = await handleStatus(
          node,
          status(
            'engine-b:1',
            [
              { workerId: runner, state: 'pulling', pull: { image: 'x', startedAt: new Date().toISOString() } },
              { workerId: scheduler, state: 'backoff', containerId: 'c-s', restarts: 1, lastExit: { exitCode: 2, oomKilled: false, at: exitAt, logTail: 'panic' }, nextRestartAt: new Date().toISOString() },
              { workerId: draining, state: 'removed' },
              { workerId: randomUUID(), state: 'running' },
            ],
            -3500,
          ),
          { nodeStatusIntervalMs: 10_000, nodeOfflineAfterMs: 60_000 },
          log,
        )
        expect(response).toMatchObject({ rev: node.assignmentsRev, nextStatusMs: 10_000 })
        const { workers, scans, nodes, events } = useCollections()
        expect((await workers.findOne({ _id: runner }))?.state).toBe('pulling')
        const crashed = (await workers.findOne({ _id: scheduler }))!
        expect(crashed.state).toBe('backoff')
        expect(crashed.container).toMatchObject({ id: 'c-s', restarts: 1, lastExit: { exitCode: 2, oomKilled: false, logTail: 'panic' } })
        const stopped = (await workers.findOne({ _id: draining }))!
        expect(stopped.state).toBe('stopped')
        expect(stopped.expiresAt!.getTime() - stopped.stoppedAt!.getTime()).toBe(7 * 86_400_000)
        const scan = (await scans.findOne({ _id: scanId }))!
        expect(scan.conditions.map((condition) => condition.type)).toEqual(['crashLoop'])
        expect(scan.conditions[0]!.details).toMatchObject({ workerId: scheduler, exitCode: 2, restarts: 1, logTail: 'panic' })
        expect(await events.countDocuments({ type: 'worker.crashed', workerId: scheduler })).toBe(1)
        expect(await events.countDocuments({ type: 'worker.stopped', workerId: draining })).toBe(1)
        // The clock offset is stored for the reconciler, which raises clockSkew.
        expect((await nodes.findOne({ _id: nodeId }))?.info).toMatchObject({ clockOffsetMs: -3500, egressDenyApplied: false, diskFreeBytes: 90 * 1024 ** 3, hostname: 'it-node' })

        // The same exit reported again raises nothing new; the restart moves the worker on.
        await handleStatus(
          node,
          status('engine-b:1', [
            { workerId: runner, state: 'running', containerId: 'c-r', startedAt: new Date().toISOString(), restarts: 0, applied: { processes: 2, nanoCpus: 2e9, memoryBytes: 1342177280 } },
            { workerId: scheduler, state: 'starting', containerId: 'c-s', restarts: 1, lastExit: { exitCode: 2, oomKilled: false, at: exitAt, logTail: 'panic' } },
          ]),
          { nodeStatusIntervalMs: 10_000, nodeOfflineAfterMs: 60_000 },
          log,
        )
        expect(await events.countDocuments({ type: 'worker.crashed', workerId: scheduler })).toBe(1)
        expect(await workers.findOne({ _id: runner })).toMatchObject({ state: 'starting', processes: { applied: 2 }, container: { id: 'c-r' } })
        expect((await workers.findOne({ _id: scheduler }))?.state).toBe('starting')
      })

      it('refuses a status of an instance that lost the lease', async () => {
        const node = (await useCollections().nodes.findOne({ _id: nodeId }))!
        await expectApiError(handleStatus(node, status('engine-x:9', []), { nodeStatusIntervalMs: 10_000, nodeOfflineAfterMs: 60_000 }, log), 'nodeInstanceConflict')
      })

      it('records answers to open log requests of its own workers only', async () => {
        const { workers, nodes } = useCollections()
        const requestId = randomUUID()
        await workers.updateOne({ _id: runner }, { $set: { logs: { requestId, requestedAt: new Date(), tailBytes: 8, text: null, collectedAt: null, truncated: false } } })
        const node = (await nodes.findOne({ _id: nodeId }))!
        expect((await buildNodeAssignments(node, config)).logRequests).toEqual([{ requestId, workerId: runner, tailBytes: 8 }])
        const otherNode = { _id: randomUUID() }
        await expectApiError(storeWorkerLogs(otherNode, runner, { requestId, text: 'x', bytes: 1, truncated: false, collectedAt: new Date().toISOString() }, log), 'notFound')
        await expectApiError(storeWorkerLogs(node, runner, { requestId: randomUUID(), text: 'x', bytes: 1, truncated: false, collectedAt: new Date().toISOString() }, log), 'notFound')
        await storeWorkerLogs(node, runner, { requestId, text: '0123456789abcdef', bytes: 16, truncated: false, collectedAt: new Date().toISOString() }, log)
        expect((await workers.findOne({ _id: runner }))?.logs).toMatchObject({ requestId, text: '89abcdef', truncated: true })
        const after = (await nodes.findOne({ _id: nodeId }))!
        expect(after.assignmentsRev).toBeGreaterThan(node.assignmentsRev)
        expect((await buildNodeAssignments(after, config)).logRequests).toEqual([])
        await expectApiError(storeWorkerLogs(node, runner, { requestId, text: 'again', bytes: 5, truncated: false, collectedAt: new Date().toISOString() }, log), 'notFound')
      })

      it('lists the workers of the node with their scan', async () => {
        const page = await listNodeWorkers(nodeId, { limit: 2 })
        expect(page.items).toHaveLength(2)
        expect(page.nextCursor).not.toBeNull()
        expect(page.items[0]).toMatchObject({ node: { id: nodeId, name: 'it-remote' }, scan: { id: scanId, name: 'tranco top 100k' } })
        expect(page.items[0]!.spec).not.toHaveProperty('specHash')
        const rest = await listNodeWorkers(nodeId, { limit: 2, cursor: page.nextCursor! })
        expect(rest.items).toHaveLength(1)
        expect((await listNodeWorkers(nodeId, { state: ['stopped'] })).items.map((worker) => worker.id)).toEqual([draining])
      })

      it('takes a silent node offline and loses its workers', async () => {
        const { nodes, workers } = useCollections()
        const before = (await nodes.findOne({ _id: nodeId }))!
        await nodes.updateOne({ _id: nodeId }, { $set: { lastSeenAt: new Date(Date.now() - 120_000) } })
        const token = (await buildNodeAssignments(before, config)).workers[0]!.env.SCANTOR_WORKER_TOKEN
        expect(await detectOfflineNodes(60_000, log)).toEqual([nodeId])
        const after = (await nodes.findOne({ _id: nodeId }))!
        expect(after.state).toBe('offline')
        expect(after.assignmentsRev).toBeGreaterThan(before.assignmentsRev)
        expect(await workers.countDocuments({ nodeId, state: 'lost', 'stateReason.code': 'nodeOffline' })).toBe(2)
        expect(await resolveWorkerToken(token)).toBeNull()
        expect([...(await nodeRepositories(nodeId))]).toEqual([])
        // Detection is idempotent.
        expect(await detectOfflineNodes(60_000, log)).toEqual([])
        // The next status of the lease holder brings the node back online.
        await handleStatus(after, status('engine-b:1', []), { nodeStatusIntervalMs: 10_000, nodeOfflineAfterMs: 60_000 }, log)
        expect((await nodes.findOne({ _id: nodeId }))?.state).toBe('online')
        expect((await buildNodeAssignments((await nodes.findOne({ _id: nodeId }))!, config)).workers).toEqual([])
      })
    })

    it('revokes the token: refused at once, lease cleared, workers lost', async () => {
      const { workers, nodes } = useCollections()
      const worker = randomUUID()
      await workers.insertOne(workerDoc(worker, { scanId: randomUUID(), nodeId, state: 'running' }))
      expect(await resolveNodeToken(token)).not.toBeNull()
      const revoked = await revokeNodeToken(nodeId, log)
      expect(revoked).toMatchObject({ state: 'revoked', instance: null })
      expect(await resolveNodeToken(token)).toBeNull()
      expect((await workers.findOne({ _id: worker }))?.stateReason?.code).toBe('nodeRevoked')
      expect((await nodes.findOne({ _id: nodeId }))?.tokenHash).toBeNull()
      // Idempotent.
      expect((await revokeNodeToken(nodeId, log)).state).toBe('revoked')
    })

    it('rotates the token: a revoked node returns to pending with a new token', async () => {
      const rotated = await rotateNodeToken(nodeId, log)
      expect(rotated.node.state).toBe('pending')
      expect(rotated.token).not.toBe(token)
      expect(rotated.join.env.SCANTOR_NODE_TOKEN).toBe(rotated.token)
      expect(await resolveNodeToken(token)).toBeNull()
      expect((await resolveNodeToken(rotated.token))?.node.id).toBe(nodeId)
      const again = await rotateNodeToken(nodeId, log)
      invalidateNodeTokenCache()
      expect(await resolveNodeToken(rotated.token)).toBeNull()
      expect((await resolveNodeToken(again.token))?.node.id).toBe(nodeId)
      token = again.token
    })

    it('deletes the node: workers lost, record removed', async () => {
      const { workers, nodes } = useCollections()
      const worker = randomUUID()
      await workers.insertOne(workerDoc(worker, { scanId: randomUUID(), nodeId, state: 'starting' }))
      await deleteNode(nodeId, ADMIN, log)
      expect(await nodes.findOne({ _id: nodeId })).toBeNull()
      expect((await workers.findOne({ _id: worker }))?.stateReason?.code).toBe('nodeDeleted')
      expect(await resolveNodeToken(token)).toBeNull()
      await expectApiError(deleteNode(nodeId, ADMIN, log), 'notFound')
    })
  })
})
