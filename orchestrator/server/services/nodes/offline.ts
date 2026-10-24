import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { notifyAssignmentsChanged } from './assignments'
import { recordEvent } from './events'
import { markNodeWorkersLost } from './workers'

// Node offline detection (reconciler, docs/nodes.md §7.4, docs/architecture.md §11.4 step 5): a node without a status
// for SCANTOR_NODE_OFFLINE_AFTER becomes `offline`, its active workers `lost` (their tokens stop validating at once;
// placement places replacements, a new scheduler gets epoch + 1). The next hello or status of the node sets it
// `online` again, and the shrunken desired set makes the daemon remove the stale containers.
//
// Silence counts only while this orchestrator watches, that is while it could receive the statuses (OfflineDetector):
// after a restart, a failover of the reconciler lock, a MongoDB outage or a paused process, every node gets one full
// window, and at least the time a live node needs to reach the orchestrator again, before it can go offline.

/**
 * The shortest grace: the longest a live node may need to reach a (re)started orchestrator. That is the longest retry
 * delay of its backed-off daemon (docs/nodes.md §5.2: up to 30 s with ±20 % jitter, so 36 s), plus the time until a
 * reverse proxy routes to the orchestrator again (Traefik waits for its next health check, every 10 s,
 * docs/deployment.md §4.1), plus a margin for the request and the tick.
 */
export const OFFLINE_GRACE_MIN_MS = 60_000

/** A tick that comes more than this many intervals late means the process did not run (paused, event loop stalled). */
const LATE_TICK_FACTOR = 2

export interface OfflineDetectorOptions {
  offlineAfterMs: number
  /** the interval at which tick() is called */
  tickMs: number
  /** one detection pass (detectOfflineNodes) */
  detect: () => Promise<unknown>
  log: Logger
  now?: () => number
}

/**
 * Runs the offline detection on every tick, but only once the detector has watched for its grace,
 * max(SCANTOR_NODE_OFFLINE_AFTER, OFFLINE_GRACE_MIN_MS): long enough for every node to report again. The watch starts
 * when the reconciler lock is acquired (component start, failover) and starts again after the lock was lost, after a
 * tick that came late (the process did not run) and after a detection that failed or was still running at the next
 * tick (MongoDB, which records the statuses, was unavailable).
 */
export class OfflineDetector {
  readonly graceMs: number
  /** start of the current watch; null while not watching */
  private since: number | null = null
  private lastTickAt: number | null = null
  private running: Promise<void> | null = null
  private stopped = false
  private readonly now: () => number

  constructor(private readonly options: OfflineDetectorOptions) {
    this.graceMs = Math.max(options.offlineAfterMs, OFFLINE_GRACE_MIN_MS)
    this.now = options.now ?? Date.now
  }

  /** The reconciler lock was acquired: the statuses of every node count from now on. */
  acquired(): void {
    this.since = this.now()
    this.lastTickAt = this.since
  }

  /** The reconciler lock was lost: another orchestrator may watch, or MongoDB is unavailable. */
  lost(): void {
    this.since = null
  }

  /** Whether silence counts at this tick; (re)starts the watch when it was interrupted. */
  private watched(now: number): boolean {
    const late = this.lastTickAt === null || now - this.lastTickAt > LATE_TICK_FACTOR * this.options.tickMs
    this.lastTickAt = now
    if (this.since === null || late) {
      if (this.since !== null) this.options.log.info('node offline detection resumed after a late tick; every node gets the grace again', { graceMs: this.graceMs })
      this.since = now
    }
    return now - this.since >= this.graceMs
  }

  /** Called every tickMs while this orchestrator holds the reconciler lock. */
  tick(): void {
    if (this.stopped) return
    const now = this.now()
    if (this.running) {
      // The previous pass still waits for MongoDB, which then records no status either.
      if (this.since !== null) this.options.log.info('node offline detection is waiting for MongoDB; every node gets the grace again', { graceMs: this.graceMs })
      this.since = null
      this.lastTickAt = now
      return
    }
    if (!this.watched(now)) return
    this.running = this.options
      .detect()
      .then(
        () => undefined,
        (error: unknown) => {
          this.since = null
          this.options.log.error('node offline detection failed', { err: error })
        },
      )
      .finally(() => {
        this.running = null
      })
  }

  /** Ends the detector; waits for a pass in flight. */
  async stop(): Promise<void> {
    this.stopped = true
    await this.running
  }
}

export async function detectOfflineNodes(offlineAfterMs: number, log: Logger, now = new Date()): Promise<string[]> {
  const { nodes } = useCollections()
  const threshold = new Date(now.getTime() - offlineAfterMs)
  const stale = await nodes.find({ state: 'online', lastSeenAt: { $lt: threshold } }, { projection: { _id: 1, name: 1 } }).toArray()
  const offline: string[] = []
  for (const node of stale) {
    const result = await nodes.updateOne(
      { _id: node._id, state: 'online', lastSeenAt: { $lt: threshold } },
      { $set: { state: 'offline', updatedAt: now } },
    )
    if (result.modifiedCount === 0) continue
    offline.push(node._id)
    const lost = await markNodeWorkersLost(node._id, 'nodeOffline', now)
    if (lost.length > 0) await notifyAssignmentsChanged(node._id)
    await recordEvent({
      type: 'node.offline',
      level: 'warning',
      nodeId: node._id,
      message: `node ${node.name} sent no status for ${Math.round(offlineAfterMs / 1000)} s; ${lost.length} worker${lost.length === 1 ? '' : 's'} lost`,
      data: { lostWorkers: lost.length },
      at: now,
    }, log)
    log.warn('node offline', { nodeId: node._id, lostWorkers: lost.length })
  }
  return offline
}
