import { beforeEach, describe, expect, it, vi } from 'vitest'
import { updateNodeDaemonOverridesBody } from '../../../shared/schemas/nodes'
import type { EventDoc, NodeDoc, WorkerDoc } from '../../../server/types/documents'
import { FakeCollection } from '../../helpers/fake-collection'
import { routeOpenApiDocument, routeOperation } from '../../helpers/route-openapi'
import { daemonConfigDoc, NODE_ID, nodeDoc, recordingLogger, T0, USER_ID } from './helpers'

// The daemon overrides routes (docs/api.md §4.17, docs/nodes.md §6.12) against an in-memory node store: a JSON merge
// patch on the overrides of the running daemon instance, written conditionally on the revision that was read (a lost
// race merges again), delivered through the assignments revision, recorded as node.daemonOverridesChanged; 409
// daemonOverridesUnavailable with a reason; the reset is idempotent. The Node representation carries daemonConfig.

class WorkerStore extends FakeCollection<WorkerDoc> {
  aggregate() {
    return { toArray: async () => [] }
  }
}

const nodes = new FakeCollection<NodeDoc>('nodes')
const events = new FakeCollection<EventDoc>('events')
const workers = new WorkerStore('workers')
vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => ({ nodes: nodes.asCollection(), events: events.asCollection(), workers: workers.asCollection() }),
}))

const { deleteNodeDaemonOverrides, getNode, listNodes, revokeNodeToken, updateNode, updateNodeDaemonOverrides } =
  await import('../../../server/services/nodes/admin')
const { buildNodeAssignments } = await import('../../../server/services/nodes/assignments')

const INSTANCE = 'engine-a:7d1e'
const ADMIN = USER_ID
const log = recordingLogger()
const patch = (body: unknown) => updateNodeDaemonOverridesBody.parse(body)

function stored(): NodeDoc {
  return nodes.docs[0] as unknown as NodeDoc
}

async function unavailableError(promise: Promise<unknown>): Promise<{ code?: string; message?: string; details?: Record<string, unknown> }> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught as { code?: string; message?: string; details?: Record<string, unknown> },
  )
  expect(error?.code).toBe('daemonOverridesUnavailable')
  return error!
}

async function expectUnavailable(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  return (await unavailableError(promise)).details!
}

/** Lets `writes` overrides writes of the node store run `interfere` on the stored document first. */
function interfereWithOverrideWrites(writes: number, interfere: (doc: NodeDoc) => void): void {
  const original = nodes.updateOne.bind(nodes)
  let remaining = writes
  vi.spyOn(nodes, 'updateOne').mockImplementation(async (filter, update, options) => {
    const set = (update as { $set?: Record<string, unknown> }).$set
    if (remaining > 0 && set?.daemonOverrides !== undefined) {
      remaining--
      interfere(stored())
    }
    return original(filter, update, options)
  })
}

beforeEach(async () => {
  nodes.docs.length = 0
  events.docs.length = 0
  await nodes.insertOne(nodeDoc({ daemonConfig: daemonConfigDoc(INSTANCE), daemonOverrides: null }))
})

describe('updateNodeDaemonOverrides', () => {
  it('applies a merge patch to the overrides of the running instance and wakes the daemon', async () => {
    const node = await updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: 4, dns: { mode: 'iterative' } }), ADMIN, log)
    expect(stored().daemonOverrides).toMatchObject({ instanceId: INSTANCE, values: { maxWorkers: 4, dns: { mode: 'iterative' } }, rev: 1, updatedBy: ADMIN })
    expect(stored().assignmentsRev).toBe(43)
    expect(events.docs).toEqual([
      expect.objectContaining({
        type: 'node.daemonOverridesChanged',
        level: 'info',
        nodeId: NODE_ID,
        userId: null,
        data: { by: ADMIN, keys: ['maxWorkers', 'dns.mode'], cleared: false },
      }),
    ])
    expect(node.assignmentsRev).toBe(43)
    expect(node.daemonConfig).toMatchObject({
      overrides: { maxWorkers: 4, dns: { mode: 'iterative' } },
      overridesRev: 1,
      appliedOverridesRev: 0,
      pending: true,
      overriddenBy: ADMIN,
    })
    expect(node.daemonConfig?.overriddenAt).toEqual(expect.any(String))
  })

  it('merges later patches into the stored overrides and bumps the revision every time', async () => {
    await updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: 4, dns: { mode: 'iterative' } }), ADMIN, log)
    const node = await updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: null, dns: { upstreams: ['host'] } }), ADMIN, log)
    expect(stored().daemonOverrides).toMatchObject({ values: { dns: { mode: 'iterative', upstreams: ['host'] } }, rev: 2 })
    expect(events.docs.at(-1)?.data).toEqual({ by: ADMIN, keys: ['maxWorkers', 'dns.upstreams'], cleared: false })
    expect(node.daemonConfig).toMatchObject({ overridesRev: 2, overrides: { dns: { mode: 'iterative', upstreams: ['host'] } } })
  })

  it('writes nothing for a patch that changes nothing', async () => {
    await updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: 4 }), ADMIN, log)
    const node = await updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: 4, logLevel: null }), ADMIN, log)
    expect(stored()).toMatchObject({ assignmentsRev: 43, daemonOverrides: { rev: 1 } })
    expect(events.docs).toHaveLength(1)
    expect(node.daemonConfig?.overridesRev).toBe(1)
  })

  it('shows the overrides as applied once the daemon reports their revision', async () => {
    await updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: 4 }), ADMIN, log)
    await nodes.updateOne({ _id: NODE_ID }, { $set: { 'daemonConfig.appliedOverridesRev': 1 } })
    expect((await getNode(NODE_ID)).daemonConfig).toMatchObject({ overridesRev: 1, appliedOverridesRev: 1, pending: false })
  })

  it('refuses a node without a running daemon instance', async () => {
    await nodes.updateOne({ _id: NODE_ID }, { $set: { instance: null, state: 'offline' } })
    expect(await expectUnavailable(updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: 4 }), ADMIN, log))).toEqual({
      reason: 'noInstance',
      state: 'offline',
    })
    await nodes.updateOne({ _id: NODE_ID }, { $set: { instance: { id: INSTANCE, version: '1.4.0', startedAt: T0, lastSeenAt: T0 }, state: 'revoked' } })
    expect(await expectUnavailable(updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: 4 }), ADMIN, log))).toEqual({
      reason: 'noInstance',
      state: 'revoked',
    })
    expect(events.docs).toEqual([])
  })

  it('refuses a daemon that has not reported its configuration', async () => {
    await nodes.updateOne({ _id: NODE_ID }, { $set: { daemonConfig: null } })
    const error = await unavailableError(updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: 4 }), ADMIN, log))
    expect(error.details).toEqual({ reason: 'notReported', state: 'online' })
    // The report may also have been invalid or oversized (stored as null): the message blames no daemon version.
    expect(error.message).toBe('node scan-eu-1 has not reported a valid daemon configuration (an old daemon or an invalid report; see the orchestrator log)')
    // A report of a previous instance does not count.
    await nodes.updateOne({ _id: NODE_ID }, { $set: { daemonConfig: daemonConfigDoc('engine-a:old') } })
    expect((await expectUnavailable(updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: 4 }), ADMIN, log))).reason).toBe('notReported')
  })

  it('refuses keys the node operator did not allow, but always allows removing overrides', async () => {
    await nodes.updateOne({ _id: NODE_ID }, { $set: { 'daemonConfig.values.overrides': ['maxWorkers', 'dns.mode'] } })
    const details = await expectUnavailable(
      updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: 2, dns: { mode: 'disabled', upstreams: ['host'] }, logLevel: 'debug' }), ADMIN, log),
    )
    // In the order of schemas/daemon-overrides.json.
    expect(details).toEqual({ reason: 'notAllowed', state: 'online', keys: ['logLevel', 'dns.upstreams'] })
    await updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: 2, dns: { mode: 'disabled' } }), ADMIN, log)

    await nodes.updateOne({ _id: NODE_ID }, { $set: { 'daemonConfig.values.overrides': 'none' } })
    expect((await expectUnavailable(updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: 3 }), ADMIN, log))).keys).toEqual(['maxWorkers'])
    await updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: null, dns: null }), ADMIN, log)
    expect(stored().daemonOverrides).toMatchObject({ values: {}, rev: 2 })
  })

  it('treats an allow-list the daemon did not report as allowing nothing', async () => {
    await nodes.updateOne({ _id: NODE_ID }, { $unset: { 'daemonConfig.values.overrides': '' } })
    expect((await expectUnavailable(updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: 3 }), ADMIN, log))).reason).toBe('notAllowed')
  })

  it('merges again into the fresh overrides after losing a race against another admin', async () => {
    interfereWithOverrideWrites(1, (doc) => {
      doc.daemonOverrides = { instanceId: INSTANCE, values: { logLevel: 'debug' }, rev: 1, updatedAt: T0, updatedBy: 'other-admin' }
    })
    await updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: 4 }), ADMIN, log)
    expect(stored().daemonOverrides).toMatchObject({ values: { maxWorkers: 4, logLevel: 'debug' }, rev: 2, updatedBy: ADMIN })
    expect(events.docs.map((event) => event.data)).toEqual([{ by: ADMIN, keys: ['maxWorkers'], cleared: false }])
  })

  it('gives up after three lost races', async () => {
    let rev = 0
    interfereWithOverrideWrites(3, (doc) => {
      rev++
      doc.daemonOverrides = { instanceId: INSTANCE, values: { pidsLimit: 100 + rev }, rev, updatedAt: T0, updatedBy: 'other-admin' }
    })
    const error = await updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: 4 }), ADMIN, log).then(
      () => null,
      (caught: unknown) => caught as { code?: string },
    )
    expect(error?.code).toBe('invalidState')
    expect(stored().daemonOverrides).toMatchObject({ values: { pidsLimit: 103 }, rev: 3 })
    expect(events.docs).toEqual([])
  })

  it('does not hand overrides to a daemon instance that said hello meanwhile', async () => {
    interfereWithOverrideWrites(1, (doc) => {
      doc.instance = { id: 'engine-a:new', version: '1.4.0', startedAt: T0, lastSeenAt: T0 }
      doc.daemonConfig = null
    })
    expect((await expectUnavailable(updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: 4 }), ADMIN, log))).reason).toBe('notReported')
    expect(stored().daemonOverrides).toBeNull()
  })

  it('answers 404 for an unknown node', async () => {
    const error = await updateNodeDaemonOverrides('3e4f5a6b-7c8d-4e9f-9a0b-1c2d3e4f5a6b', patch({ maxWorkers: 4 }), ADMIN, log).then(
      () => null,
      (caught: unknown) => caught as { code?: string },
    )
    expect(error?.code).toBe('notFound')
  })
})

describe('deleteNodeDaemonOverrides', () => {
  it('removes every override of the running instance and wakes the daemon', async () => {
    await updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: 4, dns: { mode: 'disabled' } }), ADMIN, log)
    const node = await deleteNodeDaemonOverrides(NODE_ID, ADMIN, log)
    expect(stored().daemonOverrides).toMatchObject({ instanceId: INSTANCE, values: {}, rev: 2, updatedBy: ADMIN })
    expect(stored().assignmentsRev).toBe(44)
    expect(events.docs.at(-1)).toMatchObject({ type: 'node.daemonOverridesChanged', data: { by: ADMIN, keys: ['maxWorkers', 'dns.mode'], cleared: true } })
    expect(node.daemonConfig).toMatchObject({ overrides: {}, overridesRev: 2, pending: true })
  })

  it('is idempotent', async () => {
    await deleteNodeDaemonOverrides(NODE_ID, ADMIN, log)
    await updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: 4 }), ADMIN, log)
    await deleteNodeDaemonOverrides(NODE_ID, ADMIN, log)
    const node = await deleteNodeDaemonOverrides(NODE_ID, ADMIN, log)
    expect(stored()).toMatchObject({ assignmentsRev: 44, daemonOverrides: { values: {}, rev: 2 } })
    expect(events.docs).toHaveLength(2)
    expect(node.daemonConfig?.overridesRev).toBe(2)
  })

  it('removes the overrides of a running instance whose configuration report is missing', async () => {
    await updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: 4 }), ADMIN, log)
    await nodes.updateOne({ _id: NODE_ID }, { $set: { daemonConfig: null } })
    const node = await deleteNodeDaemonOverrides(NODE_ID, ADMIN, log)
    expect(stored().daemonOverrides).toMatchObject({ instanceId: INSTANCE, values: {}, rev: 2 })
    expect(node.daemonConfig).toBeNull()
  })

  it('gives up after three lost races with 409 invalidState', async () => {
    await updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: 4 }), ADMIN, log)
    let rev = 1
    interfereWithOverrideWrites(3, (doc) => {
      rev++
      doc.daemonOverrides = { instanceId: INSTANCE, values: { pidsLimit: 100 + rev }, rev, updatedAt: T0, updatedBy: 'other-admin' }
    })
    const error = await deleteNodeDaemonOverrides(NODE_ID, ADMIN, log).then(
      () => null,
      (caught: unknown) => caught as { code?: string; details?: Record<string, unknown> },
    )
    expect(error).toMatchObject({ code: 'invalidState', details: { state: 'online' } })
  })

  it('leaves the overrides of another instance alone', async () => {
    const old = { instanceId: 'engine-a:old', values: { maxWorkers: 4 }, rev: 5, updatedAt: T0, updatedBy: ADMIN }
    await nodes.updateOne({ _id: NODE_ID }, { $set: { daemonOverrides: old } })
    await deleteNodeDaemonOverrides(NODE_ID, ADMIN, log)
    expect(stored()).toMatchObject({ assignmentsRev: 42, daemonOverrides: old })
    expect(events.docs).toEqual([])
  })
})

describe('Node.daemonConfig', () => {
  it('is part of getNode and of listNodes only with include=daemonConfig', async () => {
    expect((await getNode(NODE_ID)).daemonConfig).toMatchObject({ values: { maxWorkers: 16 }, overrides: {}, overridesRev: 0, pending: false })
    expect((await listNodes({})).items[0]).not.toHaveProperty('daemonConfig')
    expect((await listNodes({ include: 'daemonConfig' })).items[0]?.daemonConfig).toMatchObject({ values: { maxWorkers: 16 } })
  })

  it('is not part of updateNode and revokeNodeToken, like listNodes without include', async () => {
    const updated = await updateNode(NODE_ID, { cordoned: true })
    expect(updated.cordoned).toBe(true)
    expect(updated).not.toHaveProperty('daemonConfig')
    const revoked = await revokeNodeToken(NODE_ID, log)
    expect(revoked.state).toBe('revoked')
    expect(revoked).not.toHaveProperty('daemonConfig')
    // A second revocation answers the node as it is, also without the daemon configuration.
    expect(await revokeNodeToken(NODE_ID, log)).not.toHaveProperty('daemonConfig')
    expect(await getNode(NODE_ID)).toHaveProperty('daemonConfig')
  })

  it('is null while the running instance has not reported one', async () => {
    await nodes.updateOne({ _id: NODE_ID }, { $set: { daemonConfig: daemonConfigDoc('engine-a:old') } })
    expect((await getNode(NODE_ID)).daemonConfig).toBeNull()
    await nodes.updateOne({ _id: NODE_ID }, { $unset: { daemonConfig: '' } })
    expect((await getNode(NODE_ID)).daemonConfig).toBeNull()
  })
})

describe('OpenAPI', () => {
  it('declares 409 invalidState for both daemon overrides routes, which answer it after three lost races', () => {
    const document = routeOpenApiDocument()
    for (const operationId of ['updateNodeDaemonOverrides', 'deleteNodeDaemonOverrides']) {
      const operation = routeOperation(document, operationId) as { description: string; responses: Record<string, { description: string }> }
      expect(operation.responses['409']?.description, operationId).toMatch(/invalidState/)
      expect(operation.description, operationId).toMatch(/409 invalidState when other writes changed the overrides concurrently three times/)
    }
    const update = routeOperation(document, 'updateNodeDaemonOverrides') as { description: string }
    expect(update.description).toContain('notReported (the node has not reported a valid daemon configuration: an old daemon or an invalid report)')
    expect(update.description).not.toMatch(/predates/)
  })
})

describe('assignments', () => {
  const config = {
    internalUrl: 'http://orchestrator:3000',
    publicUrl: 'https://scantor.example.com',
    amqpInternalUrl: 'amqp://rabbitmq:5672',
    amqpPublicUrl: 'amqps://amqp.scantor.example.com:443',
    registryPort: 5000,
    registryPublicHost: 'registry.example.com',
    workerCapAdd: [],
  }

  it('carry the complete overrides of the polling instance', async () => {
    expect((await buildNodeAssignments(stored(), config, T0)).daemonOverrides).toEqual({ rev: 0, values: {} })
    await updateNodeDaemonOverrides(NODE_ID, patch({ maxWorkers: 4, dns: { upstreams: ['host'] } }), ADMIN, log)
    expect((await buildNodeAssignments(stored(), config, T0)).daemonOverrides).toEqual({ rev: 1, values: { maxWorkers: 4, dns: { upstreams: ['host'] } } })
    // Overrides of another instance are never handed out.
    await nodes.updateOne({ _id: NODE_ID }, { $set: { 'instance.id': 'engine-a:new' } })
    expect((await buildNodeAssignments(stored(), config, T0)).daemonOverrides).toEqual({ rev: 0, values: {} })
  })
})
