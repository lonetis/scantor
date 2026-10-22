import type { ChangeStream, ChangeStreamDocument, Collection, Document } from 'mongodb'
import type { Config } from '../../utils/config'
import { useAmqp } from '../../utils/amqp'
import { useKeys } from '../../utils/keys'
import { LeaseLock } from '../../utils/locks'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { useRabbitmqManagement } from '../../utils/rabbitmq-management'
import { runPlacement } from '../placement'
import { rememberBrokerAlarms } from '../scans/broker'
import { reconcileHousekeepingConditions } from './conditions'
import { LifecycleConvergence } from './lifecycle'
import { SchedulerSupervisor } from './scheduler'
import { StallDetector } from './stall'
import { TopologyReconciler, type TopologyResult } from './topology'

/*
 * The scans reconciler (docs/architecture.md §4.1 "reconciler", §11.2, §11.3; docs/queue.md §3.5, §9; docs/nodes.md
 * §12): level-triggered every 10 s and on MongoDB change streams (scans: state, settings, scheduling state; workers:
 * state, processes; nodes: state, info, cordon), debounced by 500 ms, under the `reconciler` lease lock. One tick
 * runs the steps in a fixed order; a failing step is logged and the next steps still run:
 *
 *   1 broker alarms → brokerAlarm conditions (and the alarm cache of startScan)
 *   2 topology ensure/remove (+ creating → running, orphan sweeps)        user limits change before assignments
 *   3 scheduler supervision (crash counting, restart limit, schedulerRestarting)
 *   4 placement: desired workers, placement, live resize, workersPending
 *   5 lifecycle: cancel convergence, periodic and final recounts, completion, scanDelete recovery
 *   6 stall detection and lost gap fill
 *   7 condition housekeeping (clockSkew, crashLoop/workerErrors clearing)
 *
 * The first tick after start is the boot sweep: it removes orphan scan users and queues like every other tick.
 */

export const RECONCILE_INTERVAL_MS = 10_000
export const KICK_DEBOUNCE_MS = 500
const CHANGE_STREAM_RETRY_MS = 5000

const SCAN_FIELDS = ['state', 'settings', 'scheduling.state']
const WORKER_FIELDS = ['state', 'processes']
const NODE_FIELDS = ['state', 'info', 'cordoned', 'maxWorkers', 'pool', 'labels', 'tokenHash']

/** True when a change stream event touches fields placement or topology depend on. */
export function relevantChange(event: ChangeStreamDocument, fields: readonly string[]): boolean {
  if (event.operationType !== 'update') return event.operationType === 'insert' || event.operationType === 'delete' || event.operationType === 'replace'
  const updated = Object.keys(event.updateDescription.updatedFields ?? {})
  const removed = event.updateDescription.removedFields ?? []
  return [...updated, ...removed].some((path) => fields.some((field) => path === field || path.startsWith(`${field}.`) || field.startsWith(`${path}.`)))
}

export interface ScansReconcilerOptions {
  config: Config
  log: Logger
  signal: AbortSignal
}

type Step = { name: string; run: () => Promise<void> }

export class ScansReconciler {
  private readonly lock: LeaseLock
  private readonly topology: TopologyReconciler
  private readonly scheduler: SchedulerSupervisor
  private readonly lifecycle: LifecycleConvergence
  private readonly stall: StallDetector
  private timer: NodeJS.Timeout | null = null
  private debounce: NodeJS.Timeout | null = null
  private ticking: Promise<void> | null = null
  private again = false
  private stopped = true
  private readonly streams: ChangeStream[] = []

  constructor(private readonly options: ScansReconcilerOptions) {
    const { scans, workers, analyses, jobs, locks } = useCollections()
    const log = options.log
    this.lock = new LeaseLock(locks, 'reconciler', {
      logger: log,
      onAcquired: () => {
        log.info('reconciler lock acquired')
        this.kick()
      },
      onLost: () => log.warn('reconciler lock lost'),
    })
    this.topology = new TopologyReconciler({
      management: useRabbitmqManagement(),
      openChannel: async () => (await useAmqp('reconciler')).createChannel(),
      amqpPassword: (scanId) => useKeys().amqpPassword(scanId),
      config: options.config,
      scans,
      log: log.child({ step: 'topology' }),
    })
    this.scheduler = new SchedulerSupervisor({ scans, workers, config: options.config, log: log.child({ step: 'scheduler' }) })
    this.lifecycle = new LifecycleConvergence({ scans, analyses, jobs, log: log.child({ step: 'lifecycle' }) })
    this.stall = new StallDetector({ scans, analyses, stallAfterMs: options.config.scanStallAfterMs, log: log.child({ step: 'stall' }) })
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.lock.start()
    this.timer = setInterval(() => void this.tick(), RECONCILE_INTERVAL_MS)
    const { scans, workers, nodes } = useCollections()
    this.watch(scans as unknown as Collection<Document>, SCAN_FIELDS)
    this.watch(workers as unknown as Collection<Document>, WORKER_FIELDS)
    this.watch(nodes as unknown as Collection<Document>, NODE_FIELDS)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.debounce) clearTimeout(this.debounce)
    this.timer = null
    this.debounce = null
    await Promise.all(this.streams.splice(0).map((stream) => stream.close().catch(() => undefined)))
    await this.ticking?.catch(() => undefined)
    await this.lock.stop()
  }

  /** Schedules a tick soon (debounced). */
  kick(): void {
    if (this.stopped || this.debounce) return
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.tick()
    }, KICK_DEBOUNCE_MS)
  }

  private watch(collection: Collection<Document>, fields: readonly string[]): void {
    if (this.stopped) return
    let stream: ChangeStream
    try {
      stream = collection.watch([{ $match: { operationType: { $in: ['insert', 'update', 'replace', 'delete'] } } }])
    } catch (error) {
      this.options.log.warn('opening a change stream failed; retrying', { collection: collection.collectionName, err: error })
      setTimeout(() => this.watch(collection, fields), CHANGE_STREAM_RETRY_MS)
      return
    }
    this.streams.push(stream)
    stream.on('change', (event: ChangeStreamDocument) => {
      if (relevantChange(event, fields)) this.kick()
    })
    stream.on('error', (error: unknown) => {
      this.options.log.warn('change stream failed; reopening', { collection: collection.collectionName, err: error })
      const index = this.streams.indexOf(stream)
      if (index >= 0) this.streams.splice(index, 1)
      stream.close().catch(() => undefined)
      setTimeout(() => this.watch(collection, fields), CHANGE_STREAM_RETRY_MS)
    })
  }

  /** Runs one tick unless one is running; a request during a tick runs one more afterwards. */
  async tick(): Promise<void> {
    if (this.stopped || !this.lock.held) return
    if (this.ticking) {
      this.again = true
      return
    }
    this.ticking = (async () => {
      do {
        this.again = false
        await this.runSteps()
      } while (this.again && !this.stopped && this.lock.held)
    })().finally(() => {
      this.ticking = null
    })
    await this.ticking
  }

  private async runSteps(): Promise<void> {
    const { config, log } = this.options
    const collections = useCollections()
    let alarms: string[] | null = null
    let topology: TopologyResult | null = null
    const steps: Step[] = [
      {
        name: 'alarms',
        run: async () => {
          alarms = await useRabbitmqManagement().activeAlarms()
          rememberBrokerAlarms(alarms)
        },
      },
      {
        name: 'topology',
        run: async () => {
          topology = await this.topology.reconcile()
        },
      },
      { name: 'scheduler', run: () => this.scheduler.run() },
      { name: 'placement', run: async () => void (await runPlacement({ config, log: log.child({ step: 'placement' }) })) },
      { name: 'lifecycle', run: () => this.lifecycle.run(topology?.present ?? null) },
      { name: 'stall', run: async () => (topology ? this.stall.run(topology.queueCounts) : undefined) },
      { name: 'conditions', run: () => reconcileHousekeepingConditions(collections, alarms) },
    ]
    for (const step of steps) {
      if (this.stopped || this.options.signal.aborted || !this.lock.held) return
      try {
        await step.run()
      } catch (error) {
        log.warn('reconciler step failed', { step: step.name, err: error })
      }
    }
  }
}
