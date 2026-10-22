import { EDITOR_STATES, NODE_STATES, SCAN_STATES } from '#shared/utils/enums'
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
      .find({}, { projection: { name: 1, state: 1, lastSeenAt: 1, maxWorkers: 1, 'info.diskFreeBytes': 1, 'info.maxWorkers': 1 } })
      .toArray(),
  ])
  scansByState.replace(zeroFilled(SCAN_STATES, scans, 'state'))
  editorsByState.replace(zeroFilled(EDITOR_STATES, editors, 'state'))
  workersByState.replace(workerRows.map((row) => [{ state: String(row._id.state), role: String(row._id.role) }, row.n]))
  jobsByKindAndState.replace(jobRows.map((row) => [{ kind: String(row._id.kind), state: String(row._id.state) }, row.n]))

  const nodeStates = new Map<string, number>()
  const heartbeat: [Labels, number][] = []
  const disk: [Labels, number][] = []
  const capacity: [Labels, number][] = []
  for (const node of nodeDocs) {
    nodeStates.set(node.state, (nodeStates.get(node.state) ?? 0) + 1)
    const labels = { node: node.name }
    if (node.lastSeenAt) heartbeat.push([labels, Math.max(0, (now - node.lastSeenAt.getTime()) / 1000)])
    if (node.info) {
      disk.push([labels, node.info.diskFreeBytes])
      const reported = node.info.maxWorkers
      capacity.push([labels, node.maxWorkers === null || node.maxWorkers === undefined ? reported : Math.min(reported, node.maxWorkers)])
    }
  }
  nodesByState.replace(zeroFilled(NODE_STATES, nodeStates, 'state'))
  nodeHeartbeatAge.replace(heartbeat)
  nodeDiskFree.replace(disk)
  nodeWorkersCapacity.replace(capacity)
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
