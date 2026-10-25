import type { Collection } from 'mongodb'
import { TERMINAL_SCAN_STATES, type ScanState } from '#shared/utils/enums'
import type { AnalysisDoc, JobDoc, ScanDoc } from '../../types/documents'
import { createJob } from '../../utils/jobs'
import type { Logger } from '../../utils/logger'
import { recordAnalysesCompleted } from '../metrics/catalogue'
import { recountScan, tryCompleteScan } from '../scans/completion'

/*
 * Lifecycle convergence of the reconciler (docs/architecture.md §11.2 step 9, §11.3; docs/queue.md §6.9, §8):
 *
 *   cancel     once the scan's RabbitMQ user and queue are gone, pending/retrying analyses become `cancelled`
 *              and the scan is recounted (never-run seqs count as cancelled implicitly). The conversion re-checks
 *              that the scan is still cancelled in the round it was read with and touches only analyses of that
 *              round or earlier: a retry-failed may have moved it to round R + 1 and reset analyses to `pending`
 *   periodic   every 60 s per running scan: recount, and the completion check when scheduling finished; at once
 *              after a resume. Paused scans are recounted (never completed) at the same cadence while their hint
 *              counters changed since their last recount
 *   final      terminal scans are recounted once more two minutes after entering their terminal state
 *   delete     scans `deleting` without an active scanDelete job get one (recovery after a crash between the
 *              state change and the job insert, or a job that gave up)
 */

export const RECOUNT_INTERVAL_MS = 60_000
export const FINAL_RECOUNT_DELAY_MS = 120_000
/** Terminal scans are looked at for their final recount for this long after their last update. */
const FINAL_RECOUNT_WINDOW_MS = 60 * 60_000
const DELETE_JOB_RETRY_MS = 10 * 60_000

export interface LifecycleDeps {
  scans: Collection<ScanDoc>
  analyses: Collection<AnalysisDoc>
  jobs: Collection<JobDoc>
  log: Logger
  now?: () => Date
}

export class LifecycleConvergence {
  private readonly lastRecount = new Map<string, number>()
  private readonly previousState = new Map<string, ScanState>()

  constructor(private readonly deps: LifecycleDeps) {}

  /**
   * `brokerPresent`: scan ids whose user or queue still exists after this tick's topology pass; null when the pass
   * failed (then cancelled scans wait for the next tick).
   */
  async run(brokerPresent: ReadonlySet<string> | null): Promise<void> {
    const now = this.deps.now?.() ?? new Date()
    if (brokerPresent) await this.convergeCancelled(brokerPresent, now)
    await this.periodicRecounts(now)
    await this.finalRecounts(now)
    await this.recoverDeletes(now)
  }

  private async convergeCancelled(brokerPresent: ReadonlySet<string>, now: Date): Promise<void> {
    const { scans, log } = this.deps
    const cancelled = await scans
      .find({ state: 'cancelled', updatedAt: { $gte: new Date(now.getTime() - FINAL_RECOUNT_WINDOW_MS) } }, { projection: { _id: 1, round: 1, completedAt: 1, stats: 1 } })
      .toArray()
    for (const scan of cancelled) {
      if (brokerPresent.has(scan._id)) continue
      const recountedAt = scan.stats.recountedAt?.getTime() ?? 0
      if (scan.completedAt && recountedAt >= scan.completedAt.getTime()) continue
      const cancelledAnalyses = await this.cancelUnfinished(scan, now)
      if (cancelledAnalyses === null) continue
      await recountScan(scan._id)
      log.info('cancelled scan converged', { scanId: scan._id, cancelledAnalyses })
    }
  }

  /**
   * pending/retrying analyses of a cancelled scan → cancelled (docs/data-model.md §6.3); returns the count, or null
   * when the scan is no longer cancelled in the round it was read with (a retry-failed started meanwhile).
   */
  private async cancelUnfinished(scan: Pick<ScanDoc, '_id' | 'round'>, now: Date): Promise<number | null> {
    const { scans, analyses } = this.deps
    if ((await scans.countDocuments({ _id: scan._id, state: 'cancelled', round: scan.round }, { limit: 1 })) === 0) return null
    // A retry that starts after the check writes round R + 1, which this update leaves alone.
    const result = await analyses.updateMany(
      { scanId: scan._id, round: { $lte: scan.round }, status: { $in: ['pending', 'retrying'] } },
      { $set: { status: 'cancelled', updatedAt: now } },
    )
    recordAnalysesCompleted('cancelled', result.modifiedCount)
    return result.modifiedCount
  }

  private async periodicRecounts(now: Date): Promise<void> {
    const { scans } = this.deps
    const running = await scans
      .find({ state: { $in: ['running', 'paused'] } }, { projection: { _id: 1, state: 1, scheduling: 1, updatedAt: 1, 'stats.recountedAt': 1 } })
      .toArray()
    const live = new Set<string>()
    for (const scan of running) {
      live.add(scan._id)
      const resumed = scan.state === 'running' && this.previousState.get(scan._id) === 'paused'
      this.previousState.set(scan._id, scan.state)
      const due = now.getTime() - (this.lastRecount.get(scan._id) ?? 0) >= RECOUNT_INTERVAL_MS
      if (scan.state === 'paused') {
        // Work that finished during the drain only moved the hint counters; recount once they settled, so a
        // paused scan shows exact stats. A paused scan never completes.
        if (due && scan.updatedAt.getTime() > (scan.stats.recountedAt?.getTime() ?? 0)) {
          this.lastRecount.set(scan._id, now.getTime())
          await recountScan(scan._id)
        }
        continue
      }
      if (!due && !resumed) continue
      this.lastRecount.set(scan._id, now.getTime())
      if (scan.scheduling.state === 'done' || scan.scheduling.state === 'failed') await tryCompleteScan(scan._id, resumed ? 'resume' : 'periodic')
      else await recountScan(scan._id)
    }
    for (const scanId of this.lastRecount.keys()) if (!live.has(scanId)) this.lastRecount.delete(scanId)
    for (const scanId of this.previousState.keys()) if (!live.has(scanId)) this.previousState.delete(scanId)
  }

  private async finalRecounts(now: Date): Promise<void> {
    const { scans } = this.deps
    const recent = await scans
      .find(
        {
          state: { $in: [...TERMINAL_SCAN_STATES] },
          updatedAt: { $gte: new Date(now.getTime() - FINAL_RECOUNT_WINDOW_MS) },
          completedAt: { $lte: new Date(now.getTime() - FINAL_RECOUNT_DELAY_MS) },
        },
        { projection: { _id: 1, state: 1, round: 1, completedAt: 1, stats: 1 } },
      )
      .toArray()
    for (const scan of recent) {
      const recountedAt = scan.stats.recountedAt?.getTime() ?? 0
      if (scan.completedAt && recountedAt >= scan.completedAt.getTime() + FINAL_RECOUNT_DELAY_MS) continue
      // An attempt event still in the ingest queue at cancel time may have written `retrying` after the cancel
      // convergence; the final pass cancels it too.
      if (scan.state === 'cancelled' && (await this.cancelUnfinished(scan, now)) === null) continue
      await recountScan(scan._id)
    }
  }

  private async recoverDeletes(now: Date): Promise<void> {
    const { scans, jobs, log } = this.deps
    const deleting = await scans.find({ state: 'deleting' }, { projection: { _id: 1, userId: 1 } }).toArray()
    for (const scan of deleting) {
      const last = await jobs.findOne({ kind: 'scanDelete', 'subject.id': scan._id }, { sort: { createdAt: -1 } })
      if (last?.active) continue
      if (last?.state === 'failed' && last.finishedAt && now.getTime() - last.finishedAt.getTime() < DELETE_JOB_RETRY_MS) continue
      const { created } = await createJob({ kind: 'scanDelete', userId: scan.userId, subject: { kind: 'scan', id: scan._id } }, jobs)
      if (created) log.info('created a missing scanDelete job', { scanId: scan._id })
    }
  }
}
