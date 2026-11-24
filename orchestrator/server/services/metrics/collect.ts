import { EDITOR_STATES, NODE_STATES, SCAN_STATES } from '#shared/utils/enums'
import type { NodeDoc } from '../../types/documents'
import { GLOBAL_QUEUES } from '../../utils/amqp'
import { useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { RABBITMQ_VHOST, useRabbitmqManagement } from '../../utils/rabbitmq-management'
import { scantorVersion } from '../../utils/version'
import { registryGcLastSuccess } from '../registry/gc'
import {
  buildInfo,
  editorsByState,
  ingestLag,
  jobsByKindAndState,
  metricsRegistry,
  nodeDiskFree,
  nodeHeartbeatAge,
  nodeResolverCacheHitRatio,
  nodeResolverQps,
  nodeResolverReady,
  nodesByState,
  nodeWorkersCapacity,
  rabbitmqAlarm,
  registryGcLastSuccessTimestamp,
  scanQueueMessages,
  scansByState,
  workersByState,
} from './catalogue'
import type { Labels } from './registry'

// Scrape-time gauges of /api/metrics (docs/deployment.md §13.1): counts from MongoDB on every scrape, and the
// broker view (scan queue depths, ingest lag, alarms) from the RabbitMQ management API at most every 15 s. A
// source that fails keeps its previous values and is logged; the scrape itself never fails because of it.

export const BROKER_REFRESH_MS = 15_000
const log = useLogger('metrics')

let brokerRefreshedAt = 0
let brokerRefresh: Promise<void> | null = null

function zeroFilled(states: readonly string[], counts: Map<string, number>, label: string): [Labels, number][] {
  const keys = new Set([...states, ...counts.keys()])
  return [...keys].map((state) => [{ [label]: state }, counts.get(state) ?? 0])
}

async function countBy(collection: 'scans' | 'editors', field: string): Promise<Map<string, number>> {
  const source = useCollections()[collection]
  const rows = await source.aggregate<{ _id: string; n: number }>([{ $group: { _id: `$${field}`, n: { $sum: 1 } } }]).toArray()
  return new Map(rows.filter((row) => typeof row._id === 'string').map((row) => [row._id, row.n]))
}

/** The fields of a node document the node gauges read. */
export type NodeMetricsDoc = Pick<NodeDoc, 'name' | 'state' | 'lastSeenAt' | 'maxWorkers'> & {
  info?: {
    diskFreeBytes: number
    maxWorkers: number
    resolver?: { state: string; stats: { queries: number; cacheHits: number; qps: number } | null } | null
  } | null
}

export interface NodeGaugeSamples {
  states: Map<string, number>
  heartbeat: [Labels, number][]
  disk: [Labels, number][]
  capacity: [Labels, number][]
  resolverReady: [Labels, number][]
  resolverQps: [Labels, number][]
  resolverCacheHitRatio: [Labels, number][]
}

/**
 * The samples of the per-node gauges. Capacity is min(reported, admin worker limit), as in placement. The resolver
 * gauges cover online nodes whose daemon reported a node resolver (a stale report of an offline node is left out);
 * the cache hit ratio needs at least one query.
 */
export function nodeGaugeSamples(nodeDocs: NodeMetricsDoc[], now: number): NodeGaugeSamples {
  const samples: NodeGaugeSamples = { states: new Map(), heartbeat: [], disk: [], capacity: [], resolverReady: [], resolverQps: [], resolverCacheHitRatio: [] }
  for (const node of nodeDocs) {
    samples.states.set(node.state, (samples.states.get(node.state) ?? 0) + 1)
    const labels = { node: node.name }
    if (node.lastSeenAt) samples.heartbeat.push([labels, Math.max(0, (now - node.lastSeenAt.getTime()) / 1000)])
    if (!node.info) continue
    samples.disk.push([labels, node.info.diskFreeBytes])
    const reported = node.info.maxWorkers
    samples.capacity.push([labels, node.maxWorkers === null || node.maxWorkers === undefined ? reported : Math.min(reported, node.maxWorkers)])
    const resolver = node.info.resolver
    if (node.state !== 'online' || !resolver) continue
    samples.resolverReady.push([labels, resolver.state === 'ready' ? 1 : 0])
    if (!resolver.stats) continue
    samples.resolverQps.push([labels, resolver.stats.qps])
    if (resolver.stats.queries > 0) samples.resolverCacheHitRatio.push([labels, resolver.stats.cacheHits / resolver.stats.queries])
  }
  return samples
}

async function collectDatabaseGauges(now: number): Promise<void> {
  const { workers, nodes, jobs } = useCollections()
  const [scans, editors, workerRows, jobRows, nodeDocs] = await Promise.all([
    countBy('scans', 'state'),
    countBy('editors', 'state'),
    workers
      .aggregate<{ _id: { state: string; role: string }; n: number }>([
        { $group: { _id: { state: '$state', role: '$role' }, n: { $sum: 1 } } },
      ])
      .toArray(),
    jobs
      .aggregate<{ _id: { kind: string; state: string }; n: number }>([
        { $group: { _id: { kind: '$kind', state: '$state' }, n: { $sum: 1 } } },
      ])
      .toArray(),
    nodes
      .find<NodeMetricsDoc>(
        {},
        {
          projection: {
            name: 1,
            state: 1,
            lastSeenAt: 1,
            maxWorkers: 1,
            'info.diskFreeBytes': 1,
            'info.maxWorkers': 1,
            'info.resolver.state': 1,
            'info.resolver.stats.queries': 1,
            'info.resolver.stats.cacheHits': 1,
            'info.resolver.stats.qps': 1,
          },
        },
      )
      .toArray(),
  ])
  scansByState.replace(zeroFilled(SCAN_STATES, scans, 'state'))
  editorsByState.replace(zeroFilled(EDITOR_STATES, editors, 'state'))
  workersByState.replace(workerRows.map((row) => [{ state: String(row._id.state), role: String(row._id.role) }, row.n]))
  jobsByKindAndState.replace(jobRows.map((row) => [{ kind: String(row._id.kind), state: String(row._id.state) }, row.n]))

  const samples = nodeGaugeSamples(nodeDocs, now)
  nodesByState.replace(zeroFilled(NODE_STATES, samples.states, 'state'))
  nodeHeartbeatAge.replace(samples.heartbeat)
  nodeDiskFree.replace(samples.disk)
  nodeWorkersCapacity.replace(samples.capacity)
  nodeResolverReady.replace(samples.resolverReady)
  nodeResolverQps.replace(samples.resolverQps)
  nodeResolverCacheHitRatio.replace(samples.resolverCacheHitRatio)
}

async function refreshBrokerGauges(): Promise<void> {
  const management = useRabbitmqManagement()
  const [queues, ingest, alarms] = await Promise.all([
    management.listAllQueues(RABBITMQ_VHOST, {
      nameRegex: '^scantor\\.scan\\.',
      columns: ['name', 'messages_ready', 'messages_unacknowledged', 'messages_delayed'],
    }),
    management.getQueue(RABBITMQ_VHOST, GLOBAL_QUEUES.resultsIngest),
    management.activeAlarms(),
  ])
  const samples: [Labels, number][] = []
  for (const queue of queues) {
    const scanId = queue.name.slice('scantor.scan.'.length)
    samples.push([{ scanId, state: 'ready' }, queue.messages_ready ?? 0])
    samples.push([{ scanId, state: 'unacked' }, queue.messages_unacknowledged ?? 0])
    samples.push([{ scanId, state: 'delayed' }, queue.messages_delayed ?? 0])
  }
  scanQueueMessages.replace(samples)
  ingestLag.set(undefined, ingest?.messages_ready ?? 0)
  rabbitmqAlarm.replace([
    [{ type: 'memory' }, alarms.includes('memory') ? 1 : 0],
    [{ type: 'disk' }, alarms.includes('disk') ? 1 : 0],
  ])
}

/** Refreshes the broker gauges when they are older than BROKER_REFRESH_MS (one refresh at a time). */
async function collectBrokerGauges(now: number): Promise<void> {
  if (now - brokerRefreshedAt < BROKER_REFRESH_MS) return
  brokerRefresh ??= refreshBrokerGauges()
    .then(() => {
      brokerRefreshedAt = Date.now()
    })
    .finally(() => {
      brokerRefresh = null
    })
  await brokerRefresh
}

/** Refreshes the scrape-time gauges and renders every metric (GET /api/metrics). */
export async function renderMetrics(now = Date.now()): Promise<string> {
  buildInfo.replace([[{ version: scantorVersion }, 1]])
  const gcAt = registryGcLastSuccess()
  if (gcAt) registryGcLastSuccessTimestamp.set(undefined, gcAt.getTime() / 1000)
  const results = await Promise.allSettled([collectDatabaseGauges(now), collectBrokerGauges(now)])
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      log.warn('metrics source unavailable; serving its previous values', { source: index === 0 ? 'mongodb' : 'rabbitmq', err: result.reason })
    }
  }
  return metricsRegistry.render()
}
