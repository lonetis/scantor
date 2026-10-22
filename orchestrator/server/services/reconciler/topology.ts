import type { Channel } from 'amqplib'
import type { Collection } from 'mongodb'
import { ACTIVE_SCAN_STATES } from '#shared/utils/enums'
import type { ScanDoc } from '../../types/documents'
import { EXCHANGES, scanAmqpUser, scanQueueName } from '../../utils/amqp'
import type { Config } from '../../utils/config'
import type { Logger } from '../../utils/logger'
import { RABBITMQ_VHOST, type RabbitmqManagement, type RabbitmqQueue } from '../../utils/rabbitmq-management'
import { consumerTimeoutMs } from '../configs/settings'
import { reconcileCondition } from '../scans/conditions'
import { stateChangedEvent, writeEvent } from '../scans/events'

/*
 * Scan topology (docs/queue.md §3.3–§3.5, §4): for every scan in `creating`, `running` or `paused` the reconciler
 * ensures, in this order and only where something is missing or different: the exchanges, the quorum queue
 * `scantor.scan.<id>` with its exact arguments, its binding, the user `scan-<id>` with the HMAC password, its vhost
 * permissions, its topic permissions on both exchanges and its user limits. A `creating` scan whose topology is
 * complete becomes `running`. Every `scan-*` user and `scantor.scan.*` queue whose scan is not in that set (terminal,
 * deleting, deleted or unknown) is removed: the user first (kill switch), then the queue.
 *
 * The broker state is read with five list calls per tick (diffing), so the cost does not grow with the number of
 * scans. Queue arguments are immutable: a mismatch on an existing queue is logged once and the queue is kept.
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SCAN_USER = new RegExp(`^scan-(${UUID})$`)
const SCAN_QUEUE = new RegExp(`^scantor\\.scan\\.(${UUID})$`)
export const SCAN_QUEUE_NAME_REGEX = '^scantor\\.scan\\.'
const QUEUE_COLUMNS = ['name', 'arguments', 'messages_ready', 'messages_unacknowledged', 'messages_delayed', 'consumers']

export type TopologyConfig = Pick<Config, 'deliveryLimit' | 'scanQueueMaxReady' | 'uploadTimeoutMs'>

/** Queue arguments of a scan queue (docs/queue.md §3.3). */
export function scanQueueArguments(scan: Pick<ScanDoc, 'settings'>, config: TopologyConfig): Record<string, unknown> {
  return {
    'x-queue-type': 'quorum',
    'x-delivery-limit': config.deliveryLimit,
    'x-dead-letter-exchange': EXCHANGES.dead,
    'x-dead-letter-strategy': 'at-least-once',
    'x-overflow': 'reject-publish',
    'x-max-length': config.scanQueueMaxReady,
    'x-consumer-timeout': consumerTimeoutMs(scan.settings, config.uploadTimeoutMs),
  }
}

/** Vhost permissions of a scan user (docs/queue.md §4.2). The scan id is a lowercase uuid: `-` is literal. */
export function scanPermissions(scanId: string): { configure: string; write: string; read: string } {
  return { configure: '^$', write: '^scantor\\.(analyses|results)$', read: `^scantor\\.scan\\.${scanId}$` }
}

export function scanTopicPermissions(scanId: string): { exchange: string; write: string; read: string }[] {
  return [EXCHANGES.analyses, EXCHANGES.results].map((exchange) => ({ exchange, write: `^${scanId}$`, read: '^$' }))
}

/** User limits (docs/queue.md §4.3): C = 2 × (workers + 1), H = C × (processes + 2). */
export function scanUserLimits(settings: Pick<ScanDoc['settings'], 'workers' | 'processes'>): { 'max-connections': number; 'max-channels': number } {
  const connections = 2 * (settings.workers + 1)
  return { 'max-connections': connections, 'max-channels': connections * (settings.processes + 2) }
}

export interface QueueCounts {
  ready: number | null
  unacked: number | null
  delayed: number
  consumers: number | null
}

export interface BrokerState {
  queues: Map<string, RabbitmqQueue>
  users: Set<string>
  permissions: Map<string, { configure: string; write: string; read: string }>
  topicPermissions: Map<string, Map<string, { write: string; read: string }>>
  limits: Map<string, Record<string, number>>
}

/** The five list calls of one tick (docs/queue.md §3.5 step 1). */
export async function listBrokerState(management: RabbitmqManagement): Promise<BrokerState> {
  const [queues, users, permissions, topicPermissions, limits] = await Promise.all([
    management.listAllQueues(RABBITMQ_VHOST, { nameRegex: SCAN_QUEUE_NAME_REGEX, columns: QUEUE_COLUMNS }),
    management.listUsers(),
    management.listPermissions(),
    management.listTopicPermissions(),
    management.listUserLimits(),
  ])
  const state: BrokerState = {
    queues: new Map(),
    users: new Set(),
    permissions: new Map(),
    topicPermissions: new Map(),
    limits: new Map(),
  }
  for (const queue of queues) {
    const match = SCAN_QUEUE.exec(queue.name)
    if (match) state.queues.set(match[1]!, queue)
  }
  for (const user of users) if (SCAN_USER.test(user.name)) state.users.add(user.name)
  for (const permission of permissions) {
    if (permission.vhost === RABBITMQ_VHOST && SCAN_USER.test(permission.user)) state.permissions.set(permission.user, permission)
  }
  for (const permission of topicPermissions) {
    if (permission.vhost !== RABBITMQ_VHOST || !SCAN_USER.test(permission.user)) continue
    const byExchange = state.topicPermissions.get(permission.user) ?? new Map()
    byExchange.set(permission.exchange, { write: permission.write, read: permission.read })
    state.topicPermissions.set(permission.user, byExchange)
  }
  for (const limit of limits) if (SCAN_USER.test(limit.user)) state.limits.set(limit.user, limit.value ?? {})
  return state
}

export function queueCountsOf(queue: RabbitmqQueue | undefined): QueueCounts {
  if (!queue) return { ready: 0, unacked: 0, delayed: 0, consumers: 0 }
  return {
    ready: queue.messages_ready ?? null,
    unacked: queue.messages_unacknowledged ?? null,
    delayed: queue.messages_delayed ?? 0,
    consumers: queue.consumers ?? null,
  }
}

function sameArguments(actual: Record<string, unknown> | undefined, expected: Record<string, unknown>): boolean {
  if (!actual) return false
  return Object.entries(expected).every(([key, value]) => actual[key] === value)
}

function isPreconditionFailed(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 406
}

export interface TopologyDeps {
  management: RabbitmqManagement
  /** opens a channel of the admin connection */
  openChannel: () => Promise<Channel>
  amqpPassword: (scanId: string) => string
  config: TopologyConfig
  scans: Collection<ScanDoc>
  log: Logger
  now?: () => Date
}

export interface TopologyResult {
  /** queue counts of every scan that has (or should have) a queue, from this tick's listing */
  queueCounts: Map<string, QueueCounts>
  ensured: string[]
  failed: string[]
  removed: string[]
  /** scans whose RabbitMQ user or queue still exists after the pass (desired scans and failed removals) */
  present: Set<string>
}

/** Keeps the declaring channel usable: a 406 on redeclare closes it, so it is replaced. */
class ChannelHolder {
  private channel: Channel | null = null
  constructor(private readonly open: () => Promise<Channel>) {}

  async get(): Promise<Channel> {
    this.channel ??= await this.open()
    return this.channel
  }

  discard(): void {
    this.channel = null
  }

  async close(log: Logger): Promise<void> {
    const channel = this.channel
    this.channel = null
    await channel?.close().catch((error: unknown) => log.debug('closing the topology channel failed', { err: error }))
  }
}

export class TopologyReconciler {
  private readonly mismatchLogged = new Set<string>()
  /** scans whose queue binding was declared by this process */
  private readonly bound = new Set<string>()

  constructor(private readonly deps: TopologyDeps) {}

  /** One topology pass. `loadDesired` defaults to every scan in creating, running or paused. */
  async reconcile(loadDesired?: () => Promise<ScanDoc[]>): Promise<TopologyResult> {
    const { deps } = this
    const state = await listBrokerState(deps.management)
    // The desired set is read after the broker listing, so objects of a scan created meanwhile are never removed.
    const desired = loadDesired ? await loadDesired() : await deps.scans.find({ state: { $in: [...ACTIVE_SCAN_STATES] } }).toArray()
    const desiredIds = new Set(desired.map((scan) => scan._id))
    const result: TopologyResult = { queueCounts: new Map(), ensured: [], failed: [], removed: [], present: new Set(desiredIds) }
    const channels = new ChannelHolder(deps.openChannel)
    try {
      if (desired.length > 0) {
        const channel = await channels.get()
        for (const exchange of Object.values(EXCHANGES)) {
          await channel.assertExchange(exchange, 'topic', { durable: true, internal: false, autoDelete: false })
        }
      }
      for (const scan of desired) {
        try {
          await this.ensureScan(scan, state, channels)
          result.ensured.push(scan._id)
          await reconcileCondition(scan, 'topologyFailed', null, undefined, deps.scans)
          if (scan.state === 'creating') await this.markRunning(scan)
        } catch (error) {
          result.failed.push(scan._id)
          deps.log.warn('ensuring scan topology failed', { scanId: scan._id, err: error })
          await reconcileCondition(scan, 'topologyFailed', { reason: 'brokerError', message: (error as Error).message.slice(0, 500), details: { message: (error as Error).message.slice(0, 1000) } }, deps.now?.(), deps.scans)
        }
        result.queueCounts.set(scan._id, queueCountsOf(state.queues.get(scan._id)))
      }
    } finally {
      await channels.close(deps.log)
    }

    const orphanIds = new Set<string>()
    for (const user of state.users) {
      const scanId = SCAN_USER.exec(user)![1]!
      if (!desiredIds.has(scanId)) orphanIds.add(scanId)
    }
    for (const scanId of state.queues.keys()) if (!desiredIds.has(scanId)) orphanIds.add(scanId)
    for (const scanId of [...orphanIds].sort()) {
      try {
        if (state.users.has(scanAmqpUser(scanId))) await deps.management.deleteUser(scanAmqpUser(scanId))
        if (state.queues.has(scanId)) await deps.management.deleteQueue(RABBITMQ_VHOST, scanQueueName(scanId))
        this.bound.delete(scanId)
        this.mismatchLogged.delete(scanId)
        result.removed.push(scanId)
        deps.log.info('removed scan topology', { scanId })
      } catch (error) {
        result.present.add(scanId)
        deps.log.warn('removing scan topology failed', { scanId, err: error })
      }
    }
    return result
  }

  private async ensureScan(scan: ScanDoc, state: BrokerState, channels: ChannelHolder): Promise<void> {
    const { deps } = this
    const queueName = scanQueueName(scan._id)
    const user = scanAmqpUser(scan._id)
    const args = scanQueueArguments(scan, deps.config)
    const existing = state.queues.get(scan._id)
    if (!existing) {
      try {
        await (await channels.get()).assertQueue(queueName, { durable: true, arguments: args })
      } catch (error) {
        if (!isPreconditionFailed(error)) throw error
        channels.discard()
        this.logMismatch(scan._id, queueName)
      }
      this.bound.delete(scan._id)
    } else if (!sameArguments(existing.arguments, args)) {
      this.logMismatch(scan._id, queueName)
    }
    // Bindings are not part of the five list calls: a binding is (re)declared with every new queue and once per
    // process for existing queues (queue.bind is idempotent), so a lost binding heals after a restart.
    if (!this.bound.has(scan._id)) {
      await (await channels.get()).bindQueue(queueName, EXCHANGES.analyses, scan._id)
      this.bound.add(scan._id)
    }

    if (!state.users.has(user)) await deps.management.putUser(user, deps.amqpPassword(scan._id), [])

    const permissions = scanPermissions(scan._id)
    const currentPermissions = state.permissions.get(user)
    if (
      !currentPermissions ||
      currentPermissions.configure !== permissions.configure ||
      currentPermissions.write !== permissions.write ||
      currentPermissions.read !== permissions.read
    ) {
      await deps.management.putPermissions(RABBITMQ_VHOST, user, permissions)
    }

    const currentTopic = state.topicPermissions.get(user)
    for (const permission of scanTopicPermissions(scan._id)) {
      const current = currentTopic?.get(permission.exchange)
      if (!current || current.write !== permission.write || current.read !== permission.read) {
        await deps.management.putTopicPermissions(RABBITMQ_VHOST, user, permission)
      }
    }

    const limits = scanUserLimits(scan.settings)
    const currentLimits = state.limits.get(user) ?? {}
    for (const [name, value] of Object.entries(limits) as ['max-connections' | 'max-channels', number][]) {
      if (currentLimits[name] !== value) await deps.management.putUserLimit(user, name, value)
    }
  }

  private logMismatch(scanId: string, queue: string): void {
    if (this.mismatchLogged.has(scanId)) return
    this.mismatchLogged.add(scanId)
    this.deps.log.warn('queueArgumentsMismatch: keeping the existing scan queue', { scanId, queue })
  }

  private async markRunning(scan: ScanDoc): Promise<void> {
    const now = this.deps.now?.() ?? new Date()
    const updated = await this.deps.scans.findOneAndUpdate(
      { _id: scan._id, state: 'creating' },
      { $set: { state: 'running', startedAt: now, updatedAt: now } },
      { projection: { _id: 1 } },
    )
    if (!updated) return
    this.deps.log.info('scan running', { scanId: scan._id })
    await writeEvent(stateChangedEvent(scan, 'creating', 'running', 'topologyReady', 'queue, user and permissions are ready'))
  }
}
