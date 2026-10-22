import type { Collection } from 'mongodb'
import type { ScanDoc, ScantorErrorDoc, WorkerDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import type { Logger } from '../../utils/logger'
import { tryCompleteScan } from '../scans/completion'
import { clearCondition, reconcileCondition, setCondition } from '../scans/conditions'
import { writeEvent } from '../scans/events'

/*
 * Scheduler supervision (docs/architecture.md §11.2 steps 3 and 6, docs/data-model.md §4.5.2, §4.5.4). Per running
 * scan with unfinished scheduling:
 *
 *   - `scheduling.restarts` counts scheduler crashes and retryable scheduler errors. Crashes of the current-epoch
 *     scheduler container (a new `container.lastExit` with exit code ≠ 0 or an OOM kill, stored by the node status
 *     handler) are counted here; retryable errors are counted by POST /api/runtime/errors. Each exit is counted once:
 *     exits are remembered in memory by worker, and exits from before this supervisor started are never counted (a
 *     restarted orchestrator may undercount, it never double-counts).
 *   - `restarts > SCANTOR_SCHEDULER_MAX_RESTARTS` fails scheduling (`scheduling.error`, condition schedulingFailed,
 *     event scan.schedulingFailed) unless the error path already did; the scan then completes as `failed` once its
 *     analyses are final.
 *   - the condition schedulerRestarting is raised while a restarted scheduler of the current epoch is not running and
 *     cleared once it runs again or scheduling has finished.
 *
 * Replacement schedulers (lost workers, resume) are created by placement with `epoch + 1` (../placement).
 */

export interface SchedulerSupervisorDeps {
  scans: Collection<ScanDoc>
  workers: Collection<WorkerDoc>
  config: Pick<Config, 'schedulerMaxRestarts'>
  log: Logger
  now?: () => Date
}

export function schedulingError(restarts: number, maxRestarts: number, lastError: ScantorErrorDoc | null | undefined, now: Date): ScantorErrorDoc {
  return {
    type: lastError?.type ?? 'platform',
    phase: 'schedule',
    retryable: false,
    attempt: restarts,
    at: now,
    message: `the scheduler restarted ${restarts} times (limit ${maxRestarts})${lastError ? `; last error: ${lastError.message}` : ''}`.slice(0, 4096),
  }
}

/** The scheduler worker of the scan's current epoch, newest first when several exist. */
export function currentScheduler(scan: Pick<ScanDoc, '_id' | 'scheduling'>, schedulers: readonly WorkerDoc[]): WorkerDoc | undefined {
  return schedulers
    .filter((worker) => worker.scanId === scan._id && worker.epoch === scan.scheduling.epoch)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
}

export class SchedulerSupervisor {
  /** the latest counted exit time per scheduler worker */
  private readonly counted = new Map<string, number>()
  private readonly startedAt: number

  constructor(private readonly deps: SchedulerSupervisorDeps) {
    this.startedAt = (deps.now?.() ?? new Date()).getTime()
  }

  async run(): Promise<void> {
    const { scans, workers } = this.deps
    const now = this.deps.now?.() ?? new Date()
    const supervised = await scans.find({ state: 'running', 'scheduling.state': { $in: ['pending', 'running'] } }).toArray()
    const schedulers =
      supervised.length === 0
        ? []
        : await workers.find({ scanId: { $in: supervised.map((scan) => scan._id) }, role: 'scheduler', state: { $nin: ['stopped', 'lost'] } }).toArray()
    const live = new Set<string>()
    for (const scan of supervised) {
      const scheduler = currentScheduler(scan, schedulers)
      if (scheduler) live.add(scheduler._id)
      await this.supervise(scan, scheduler, now)
    }
    for (const workerId of this.counted.keys()) if (!live.has(workerId)) this.counted.delete(workerId)

    // A finished or stopped scan has no scheduler to wait for.
    const stale = await scans
      .find(
        { 'conditions.type': 'schedulerRestarting', $nor: [{ state: 'running', 'scheduling.state': { $in: ['pending', 'running'] } }] },
        { projection: { _id: 1, userId: 1, conditions: 1 } },
      )
      .toArray()
    for (const scan of stale) await clearCondition(scan, 'schedulerRestarting', scans)
  }

  /** Counts a new crash of the current scheduler; returns the scan's restart count afterwards. */
  private async countCrash(scan: ScanDoc, scheduler: WorkerDoc | undefined): Promise<number> {
    const exit = scheduler?.container?.lastExit
    if (!scheduler || !exit || (exit.exitCode === 0 && !exit.oomKilled)) return scan.scheduling.restarts
    const exitAt = new Date(exit.at).getTime()
    if (exitAt <= this.startedAt || exitAt <= (this.counted.get(scheduler._id) ?? 0)) return scan.scheduling.restarts
    this.counted.set(scheduler._id, exitAt)
    const updated = await this.deps.scans.findOneAndUpdate(
      { _id: scan._id, 'scheduling.epoch': scheduler.epoch, 'scheduling.state': { $in: ['pending', 'running'] } },
      { $inc: { 'scheduling.restarts': 1 }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after', projection: { scheduling: 1 } },
    )
    const restarts = updated?.scheduling.restarts ?? scan.scheduling.restarts
    this.deps.log.warn('scheduler crashed', { scanId: scan._id, workerId: scheduler._id, exitCode: exit.exitCode, oomKilled: exit.oomKilled, restarts })
    return restarts
  }

  private async supervise(scan: ScanDoc, scheduler: WorkerDoc | undefined, now: Date): Promise<void> {
    const restarts = await this.countCrash(scan, scheduler)
    if (restarts > this.deps.config.schedulerMaxRestarts) {
      await this.failScheduling(scan, scheduler, restarts, now)
      return
    }
    const lastError = scheduler?.runtime?.lastError ?? null
    const restarting = restarts > 0 && scheduler?.state !== 'running'
    await reconcileCondition(
      scan,
      'schedulerRestarting',
      restarting
        ? {
            reason: 'restarting',
            message: `the scheduler restarted ${restarts} time${restarts === 1 ? '' : 's'}`,
            details: { restarts, error: lastError ? { type: lastError.type, phase: lastError.phase, message: lastError.message } : null },
          }
        : null,
      now,
      this.deps.scans,
    )
  }

  private async failScheduling(scan: ScanDoc, scheduler: WorkerDoc | undefined, restarts: number, now: Date): Promise<void> {
    const error = schedulingError(restarts, this.deps.config.schedulerMaxRestarts, scheduler?.runtime?.lastError, now)
    const updated = await this.deps.scans.findOneAndUpdate(
      { _id: scan._id, state: 'running', 'scheduling.state': { $in: ['pending', 'running'] } },
      { $set: { 'scheduling.state': 'failed', 'scheduling.error': error, 'scheduling.doneAt': now, updatedAt: now } },
      { projection: { _id: 1 } },
    )
    if (!updated) return
    this.deps.log.warn('scheduling failed: too many scheduler restarts', { scanId: scan._id, restarts })
    const summary = { type: error.type, phase: error.phase, message: error.message }
    await setCondition(scan, { type: 'schedulingFailed', reason: 'tooManyRestarts', message: error.message, details: { error: summary } }, now, this.deps.scans)
    await clearCondition(scan, 'schedulerRestarting', this.deps.scans)
    await writeEvent({ type: 'scan.schedulingFailed', level: 'error', userId: scan.userId, scanId: scan._id, message: error.message, data: { error: summary } })
    await tryCompleteScan(scan._id, 'schedulingFailed')
  }
}
