import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeHelloBody, NodeStatusBody } from '../../../shared/schemas/nodes'
import type { NodeConfigSettings } from '../../../server/services/nodes/hello'
import type { EventDoc, NodeDoc, WorkerDoc } from '../../../server/types/documents'
import type { NodePrincipal } from '../../../server/utils/principal'
import { FakeCollection } from '../../helpers/fake-collection'
import { DAEMON_CONFIG_REPORT, daemonConfigDoc, NODE_ID, nodeDoc, RESOLVER_REPORT, recordingLogger, T0, USER_ID } from './helpers'

// Hello and status with the daemon-reported sub-reports (docs/api.md §7.1, §7.3, docs/nodes.md §6.11, §6.12) against an
// in-memory node store: hello stores the instance's daemon configuration and resolver state and ends the overrides
// of a previous instance (node.daemonOverridesCleared); status stores them for the lease holder only and keeps them
// when a report carries none; an invalid sub-report is stored as null and never fails the heartbeat; resolver state
// changes are recorded as node.resolverFailed and node.resolverReady, also when the resolver recovers through
// `starting` or a daemon restart, and once when two reports overlap.

const nodes = new FakeCollection<NodeDoc>('nodes')
const events = new FakeCollection<EventDoc>('events')
const workers = new FakeCollection<WorkerDoc>('workers')
vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => ({ nodes: nodes.asCollection(), events: events.asCollection(), workers: workers.asCollection() }),
}))

const { handleHello } = await import('../../../server/services/nodes/hello')
const { handleStatus } = await import('../../../server/services/nodes/status')

const OLD = 'engine-a:7d1e'
const NEW = 'engine-a:8f2a'

const config: NodeConfigSettings = {
  nodeStatusIntervalMs: 10_000,
  nodeAssignmentsWaitMs: 25_000,
  nodeOfflineAfterMs: 60_000,
  workerDrainGraceMs: 30_000,
  nodeMinFreeDiskBytes: 5 * 1024 ** 3,
  internalUrl: 'http://orchestrator:3000',
  publicUrl: 'https://scantor.example.com',
  amqpInternalUrl: 'amqp://rabbitmq:5672',
  amqpPublicUrl: 'amqps://amqp.scantor.example.com:443',
  registryPort: 5000,
  registryPublicHost: 'registry.example.com',
  s3InternalUrl: 'http://rustfs:9000',
  s3PublicUrl: 'https://s3.scantor.example.com',
  trancoUrl: 'https://tranco-list.eu',
  cruxUrl: 'https://raw.githubusercontent.com/zakird/crux-top-lists/main',
  cruxCacheUrl: 'https://raw.githubusercontent.com/lonetis/crux-cache/main',
}
const settings = { nodeStatusIntervalMs: config.nodeStatusIntervalMs, nodeOfflineAfterMs: config.nodeOfflineAfterMs }
const principal: NodePrincipal = { kind: 'node', node: { id: NODE_ID, name: 'scan-eu-1', builtIn: false, endpointProfile: 'public', pool: 'shared' } }

function stored(): NodeDoc {
  return structuredClone(nodes.docs[0]) as unknown as NodeDoc
}

function hello(instanceId: string, extra: { daemonConfig?: unknown; resolver?: unknown } = {}): NodeHelloBody {
  return {
    instanceId,
    version: '1.4.0',
    info: {
      hostname: 'scan-eu-1',
      os: 'linux',
      arch: 'amd64',
      kernel: '6.8.0',
      dockerVersion: '29.9.2',
      cpus: 16,
      memoryBytes: 64 * 1024 ** 3,
      diskFreeBytes: 400 * 1024 ** 3,
      dindMode: 'disabled',
      maxWorkers: 16,
      egressDenyApplied: true,
      ...('resolver' in extra ? { resolver: extra.resolver } : {}),
    },
    containers: [],
    ...('daemonConfig' in extra ? { daemonConfig: extra.daemonConfig } : {}),
  }
}

function status(instanceId: string, extra: { daemonConfig?: unknown; resolver?: unknown } = {}): NodeStatusBody {
  return {
    instanceId,
    appliedRev: 42,
    clockOffsetMs: 3,
    info: {
      version: '1.4.0',
      cpus: 16,
      memoryBytes: 64 * 1024 ** 3,
      diskFreeBytes: 390 * 1024 ** 3,
      dindMode: 'disabled',
      maxWorkers: 16,
      egressDenyApplied: true,
      ...('resolver' in extra ? { resolver: extra.resolver } : {}),
    },
    workers: [],
    ...('daemonConfig' in extra ? { daemonConfig: extra.daemonConfig } : {}),
  }
}

const resolverIn = (state: string, extra: Record<string, unknown> = {}) => ({ ...RESOLVER_REPORT, state, ...extra })

beforeEach(async () => {
  nodes.docs.length = 0
  events.docs.length = 0
  await nodes.insertOne(
    nodeDoc({
      instance: { id: OLD, version: '1.4.0', startedAt: T0, lastSeenAt: new Date() },
      daemonConfig: daemonConfigDoc(OLD, { appliedOverridesRev: 2 }),
      daemonOverrides: { instanceId: OLD, values: { maxWorkers: 4, dns: { mode: 'disabled' } }, rev: 2, updatedAt: T0, updatedBy: USER_ID },
    }),
  )
})

describe('hello', () => {
  it('stores the configuration and resolver state of a new instance and ends the overrides of the previous one', async () => {
    const log = recordingLogger()
    await handleHello(principal, hello(NEW, { daemonConfig: DAEMON_CONFIG_REPORT, resolver: RESOLVER_REPORT }), config, log)
    const node = stored()
    expect(node.instance?.id).toBe(NEW)
    expect(node.daemonOverrides).toBeNull()
    expect(node.daemonConfig).toMatchObject({
      instanceId: NEW,
      appliedOverridesRev: 3,
      values: { maxWorkers: 16, dns: { mode: 'iterative' } },
      warnings: DAEMON_CONFIG_REPORT.warnings,
    })
    expect(node.daemonConfig?.reportedAt).toBeInstanceOf(Date)
    expect(node.info?.resolver).toMatchObject({ state: 'ready', address: '10.10.0.1', since: new Date(RESOLVER_REPORT.since) })
    expect(events.docs.map((event) => event.type)).toEqual(['node.online', 'node.daemonOverridesCleared'])
    expect(events.docs[1]).toMatchObject({ level: 'info', nodeId: NODE_ID, userId: null, data: { instanceId: NEW, keys: ['maxWorkers', 'dns.mode'] } })
    expect(events.docs[0]?.message).toContain('took over its lease')
    expect(log.records.find((record) => record.msg === 'node hello')?.fields.clearedOverrides).toEqual(['maxWorkers', 'dns.mode'])
  })

  it('keeps the overrides of the same instance', async () => {
    await handleHello(principal, hello(OLD, { daemonConfig: { ...DAEMON_CONFIG_REPORT, appliedOverridesRev: 2 } }), config, recordingLogger())
    const node = stored()
    expect(node.daemonOverrides).toMatchObject({ instanceId: OLD, rev: 2, values: { maxWorkers: 4, dns: { mode: 'disabled' } } })
    expect(node.daemonConfig).toMatchObject({ instanceId: OLD, appliedOverridesRev: 2 })
    expect(events.docs.map((event) => event.type)).toEqual([])
  })

  it('records no cleared event for overrides that were reset', async () => {
    await nodes.updateOne({ _id: NODE_ID }, { $set: { 'daemonOverrides.values': {} } })
    await handleHello(principal, hello(NEW), config, recordingLogger())
    expect(stored().daemonOverrides).toBeNull()
    expect(events.docs.map((event) => event.type)).toEqual(['node.online'])
  })

  it('stores invalid sub-reports as null instead of refusing the hello', async () => {
    const log = recordingLogger()
    const response = await handleHello(principal, hello(NEW, { daemonConfig: { values: 'x' }, resolver: { mode: 'nope' } }), config, log)
    expect(response.node.id).toBe(NODE_ID)
    const node = stored()
    expect(node.state).toBe('online')
    expect(node.daemonConfig).toBeNull()
    expect(node.info?.resolver).toBeNull()
    expect(log.records.filter((record) => record.msg === 'node sent an invalid sub-report; stored as null').map((record) => record.fields.kind)).toEqual([
      'daemonConfig',
      'resolver',
    ])
  })

  it('leaves no report behind for a daemon that predates them', async () => {
    await nodes.updateOne({ _id: NODE_ID }, { $set: { 'info.resolver': { ...RESOLVER_REPORT, since: T0 } } })
    await handleHello(principal, hello(OLD), config, recordingLogger())
    const node = stored()
    expect(node.info).not.toHaveProperty('resolver')
    expect(node.daemonConfig).toBeNull()
  })

  it('records a resolver that fails after the restart', async () => {
    await nodes.updateOne({ _id: NODE_ID }, { $set: { 'info.resolver': { ...RESOLVER_REPORT, since: T0 } } })
    await handleHello(principal, hello(OLD, { resolver: resolverIn('failed', { error: 'bindInUse' }) }), config, recordingLogger())
    expect(events.docs).toEqual([
      expect.objectContaining({ type: 'node.resolverFailed', level: 'warning', data: expect.objectContaining({ previousState: 'ready', error: 'bindInUse' }) }),
    ])
  })

  it('returns the endpoint hosts of the node profile', async () => {
    const response = await handleHello(principal, hello(OLD), config, recordingLogger())
    expect(response.config.endpointHosts).toEqual([
      'amqp.scantor.example.com',
      'raw.githubusercontent.com',
      's3.scantor.example.com',
      'scantor.example.com',
      'tranco-list.eu',
    ])
  })
})

describe('status', () => {
  it('stores the configuration and resolver state of the instance holding the lease', async () => {
    await handleStatus(
      stored(),
      status(OLD, { daemonConfig: { ...DAEMON_CONFIG_REPORT, appliedOverridesRev: 2 }, resolver: RESOLVER_REPORT }),
      settings,
      recordingLogger(),
    )
    const node = stored()
    expect(node.daemonConfig).toMatchObject({ instanceId: OLD, appliedOverridesRev: 2, values: { dns: { mode: 'iterative' } } })
    expect(node.info).toMatchObject({ diskFreeBytes: 390 * 1024 ** 3, clockOffsetMs: 3, hostname: 'scan-eu-1', resolver: { state: 'ready' } })
    expect(node.daemonOverrides?.rev).toBe(2)
  })

  it('keeps the stored reports when a status carries none', async () => {
    await handleStatus(stored(), status(OLD, { daemonConfig: DAEMON_CONFIG_REPORT, resolver: RESOLVER_REPORT }), settings, recordingLogger())
    const before = stored()
    await handleStatus(stored(), status(OLD), settings, recordingLogger())
    const node = stored()
    expect(node.daemonConfig).toEqual(before.daemonConfig)
    expect(node.info?.resolver).toEqual(before.info?.resolver)
  })

  it('stores an invalid report as null and still takes the heartbeat', async () => {
    const response = await handleStatus(
      stored(),
      status(OLD, { daemonConfig: { warnings: 'x' }, resolver: { ...RESOLVER_REPORT, error: 'free text: no' } }),
      settings,
      recordingLogger(),
    )
    expect(response.rev).toBe(42)
    const node = stored()
    expect(node.daemonConfig).toBeNull()
    expect(node.info?.resolver).toBeNull()
    expect(node.lastSeenAt?.getTime()).toBeGreaterThan(T0.getTime())
  })

  it('stores nothing for an instance that lost the lease', async () => {
    const before = stored()
    const error = await handleStatus(before, status(NEW, { daemonConfig: DAEMON_CONFIG_REPORT, resolver: RESOLVER_REPORT }), settings, recordingLogger()).then(
      () => null,
      (caught: unknown) => caught as { code?: string },
    )
    expect(error?.code).toBe('nodeInstanceConflict')
    expect(stored().daemonConfig).toEqual(before.daemonConfig)
    expect(stored().info).toEqual(before.info)
  })

  it('records resolver state changes, not repeated states', async () => {
    const report = (state: string, extra: Record<string, unknown> = {}) =>
      handleStatus(stored(), status(OLD, { resolver: resolverIn(state, extra) }), settings, recordingLogger())
    await report('starting')
    await report('ready')
    await report('unreachable', { detail: 'gateway 10.10.0.1' })
    await report('unreachable', { detail: 'gateway 10.10.0.1' })
    await report('ready')
    await report('ready')
    expect(events.docs.map((event) => [event.type, event.data?.previousState])).toEqual([
      ['node.resolverFailed', 'ready'],
      ['node.resolverReady', 'unreachable'],
    ])
    expect(events.docs[0]?.data).toMatchObject({ state: 'unreachable', detail: 'gateway 10.10.0.1' })
  })

  const resolverEvents = () => events.docs.filter((event) => event.type.startsWith('node.resolver')).map((event) => [event.type, event.data?.previousState])

  it('records the recovery of a resolver that is restarted or replaced through starting', async () => {
    const report = (state: string) => handleStatus(stored(), status(OLD, { resolver: resolverIn(state) }), settings, recordingLogger())
    await report('starting')
    await report('ready')
    await report('failed')
    expect(stored().resolverFailedState).toBe('failed')
    await report('starting')
    await report('degraded')
    await report('starting')
    await report('ready')
    expect(stored().resolverFailedState).toBeNull()
    await report('starting')
    await report('ready')
    expect(resolverEvents()).toEqual([
      ['node.resolverFailed', 'ready'],
      ['node.resolverFailed', 'starting'],
      ['node.resolverReady', 'degraded'],
    ])
  })

  it('records the recovery after a daemon restart whose hello carries no resolver report', async () => {
    await handleStatus(stored(), status(OLD, { resolver: resolverIn('failed', { error: 'crashLoop' }) }), settings, recordingLogger())
    await handleHello(principal, hello(NEW), config, recordingLogger())
    expect(stored().info).not.toHaveProperty('resolver')
    expect(stored().resolverFailedState).toBe('failed')
    await handleStatus(stored(), status(NEW, { resolver: resolverIn('starting') }), settings, recordingLogger())
    await handleStatus(stored(), status(NEW, { resolver: resolverIn('ready') }), settings, recordingLogger())
    expect(resolverEvents()).toEqual([
      ['node.resolverFailed', null],
      ['node.resolverReady', 'failed'],
    ])
  })

  it('records the recovery reported by a hello, and nothing for a daemon that starts normally', async () => {
    await handleHello(principal, hello(NEW, { resolver: resolverIn('starting') }), config, recordingLogger())
    await handleStatus(stored(), status(NEW, { resolver: resolverIn('ready') }), settings, recordingLogger())
    expect(resolverEvents()).toEqual([])

    await handleStatus(stored(), status(NEW, { resolver: resolverIn('unreachable') }), settings, recordingLogger())
    await handleHello(principal, hello(NEW, { resolver: resolverIn('starting') }), config, recordingLogger())
    await handleHello(principal, hello(NEW, { resolver: resolverIn('ready') }), config, recordingLogger())
    expect(resolverEvents()).toEqual([
      ['node.resolverFailed', 'ready'],
      ['node.resolverReady', 'unreachable'],
    ])
  })

  it('records a change once when two reports read the node before either was stored', async () => {
    await nodes.updateOne({ _id: NODE_ID }, { $set: { state: 'offline', 'info.resolver': { ...RESOLVER_REPORT, since: T0 } } })
    const before = stored()
    await handleStatus(before, status(OLD, { resolver: resolverIn('failed') }), settings, recordingLogger())
    await handleStatus(before, status(OLD, { resolver: resolverIn('failed') }), settings, recordingLogger())
    expect(events.docs.map((event) => event.type)).toEqual(['node.online', 'node.resolverFailed'])
  })
})
