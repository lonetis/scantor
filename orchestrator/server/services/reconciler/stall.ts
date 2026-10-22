import type { Collection } from 'mongodb'
import type { AnalysisDoc, ScanDoc, ScantorErrorDoc } from '../../types/documents'
import type { Logger } from '../../utils/logger'
import { getScanInflight } from '../inflight'
import { recordAnalysesCompleted } from '../metrics/catalogue'
import { recountScan, terminalOf, tryCompleteScan } from '../scans/completion'
import { setCondition } from '../scans/conditions'
import { writeEvent } from '../scans/events'
import type { QueueCounts } from './topology'

/*
 * Stall detection and lost gap fill (docs/queue.md §9). A running scan whose scheduling finished (not during
 * retry-failed) is stalled when, continuously for SCANTOR_SCAN_STALL_AFTER, its queue holds no ready, unacked or
 * delayed message (a missing queue counts as empty), no runner reports busy analyses, and the latest recount has
 * fewer final analyses than `scheduling.confirmed`. Then missing seqs are inserted as `lost` (no config), the
 * remaining pending/retrying analyses become `lost` (keeping their config), the condition `stalled {lost}` and the
 * event `scan.lostAnalyses {count}` are written, and the completion function runs.
 */

export const GAP_FILL_BATCH = 1000
export const LOST_MESSAGE = 'lost: no message for this analysis remained in the queue and no worker was processing it'

export interface StallDeps {
  scans: Collection<ScanDoc>
  analyses: Collection<AnalysisDoc>
  stallAfterMs: number
  log: Logger
  now?: () => Date
}

/** True when the queue counts are known and all zero. */
export function queueEmpty(counts: QueueCounts | undefined): boolean {
  if (!counts) return false
  return counts.ready === 0 && counts.unacked === 0 && counts.delayed === 0
}

/** Seqs in [from, to) that have no document, given the present seqs of that range in ascending order. */
export function gapsIn(present: readonly number[], from: number, to: number): number[] {
  const gaps: number[] = []
  let next = from
  for (const seq of present) {
    for (; next < seq && next < to; next++) gaps.push(next)
    next = Math.max(next, seq + 1)
  }
  for (; next < to; next++) gaps.push(next)
  return gaps
}

function lostError(now: Date): ScantorErrorDoc {
  return { type: 'platform', phase: 'platform', retryable: false, attempt: 0, at: now, message: LOST_MESSAGE }
}

/** Gap fill and conversion; returns the number of analyses recorded as lost. */
export async function recordLostAnalyses(scan: Pick<ScanDoc, '_id' | 'userId' | 'round' | 'scheduling'>, analyses: Collection<AnalysisDoc>, now: Date): Promise<number> {
  let lost = 0
  const confirmed = scan.scheduling.confirmed
  for (let from = 0; from < confirmed; from += GAP_FILL_BATCH) {
    const to = Math.min(confirmed, from + GAP_FILL_BATCH)
    const present = await analyses
      .find({ scanId: scan._id, seq: { $gte: from, $lt: to } }, { projection: { _id: 0, seq: 1 } })
      .sort({ seq: 1 })
      .map((doc) => doc.seq)
      .toArray()
    const gaps = gapsIn(present, from, to)
    if (gaps.length === 0) continue
    const docs: AnalysisDoc[] = gaps.map((seq) => ({
      _id: `${scan._id}-${seq}`,
      scanId: scan._id,
      userId: scan.userId,
      seq,
      round: scan.round,
      status: 'lost',
      attempt: 0,
      attempts: [],
      files: [],
      error: lostError(now),
      createdAt: now,
      updatedAt: now,
    }))
    try {
      const result = await analyses.insertMany(docs, { ordered: false })
      lost += result.insertedCount
    } catch (error) {
      // E11000: a result arrived meanwhile; that document wins.
      const inserted = (error as { insertedCount?: number; result?: { insertedCount?: number } }).insertedCount
      const writeErrors = (error as { writeErrors?: { code?: number }[] | { code?: number } }).writeErrors
      const list = Array.isArray(writeErrors) ? writeErrors : writeErrors ? [writeErrors] : []
      if (list.length === 0 || list.some((entry) => entry.code !== 11000)) throw error
      lost += inserted ?? docs.length - list.length
    }
  }
  const converted = await analyses.updateMany({ scanId: scan._id, status: { $in: ['pending', 'retrying'] } }, [
    { $set: { status: 'lost', updatedAt: now, error: { ...lostError(now), attempt: '$attempt' } } },
  ])
  lost += converted.modifiedCount
  recordAnalysesCompleted('lost', lost)
  return lost
}

export class StallDetector {
  private readonly since = new Map<string, number>()

  constructor(private readonly deps: StallDeps) {}

  /** Evaluates every running scan; `queueCounts` come from this tick's topology listing. */
  async run(queueCounts: ReadonlyMap<string, QueueCounts>): Promise<void> {
    const now = this.deps.now?.() ?? new Date()
    const candidates = await this.deps.scans.find({ state: 'running', 'scheduling.state': { $in: ['done', 'failed'] } }).toArray()
    const seen = new Set<string>()
    for (const scan of candidates) {
      seen.add(scan._id)
      const stalledNow =
        queueEmpty(queueCounts.get(scan._id)) &&
        getScanInflight(scan._id).items.length === 0 &&
        terminalOf(scan.stats) < scan.scheduling.confirmed
      if (!stalledNow) {
        this.since.delete(scan._id)
        continue
      }
      const since = this.since.get(scan._id) ?? now.getTime()
      this.since.set(scan._id, since)
      if (now.getTime() - since < this.deps.stallAfterMs) continue
      // The hint counters may lag: decide on a fresh recount.
      const stats = await recountScan(scan._id)
      if (terminalOf(stats) >= scan.scheduling.confirmed) {
        this.since.delete(scan._id)
        await tryCompleteScan(scan._id, 'periodic')
        continue
      }
      await this.handleStall(scan, now)
      this.since.delete(scan._id)
    }
    for (const scanId of this.since.keys()) if (!seen.has(scanId)) this.since.delete(scanId)
  }

  private async handleStall(scan: ScanDoc, now: Date): Promise<void> {
    const lost = await recordLostAnalyses(scan, this.deps.analyses, now)
    this.deps.log.warn('scan stalled; recorded lost analyses', { scanId: scan._id, lost })
    await setCondition(scan, { type: 'stalled', reason: 'lostAnalyses', message: `${lost} analyses were recorded as lost`, details: { lost } }, now, this.deps.scans)
    await writeEvent({
      type: 'scan.lostAnalyses',
      level: 'warning',
      userId: scan.userId,
      scanId: scan._id,
      message: `${lost} analyses had no message in the queue and no worker processing them; recorded as lost`,
      data: { count: lost },
    })
    await tryCompleteScan(scan._id, 'stalled')
  }
}
