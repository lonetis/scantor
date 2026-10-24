import type { Collection } from 'mongodb'
import type { AnalysisStatus } from '#shared/utils/enums'
import type { AnalysisDoc, EventDoc, ScanDoc, ScanStatsDoc, StateReasonDoc } from '../../types/documents'
import { useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { stateChangedEvent, writeEvent } from './events'

/*
 * Recount and completion (docs/data-model.md §6.1, docs/queue.md §6.9), shared by the ingestor (orch-results), the
 * scheduler `done` route (orch-node-runtime) and the reconciler:
 *
 *   recountScan(scanId)              the authoritative aggregation of analysis statuses → scans.stats.*
 *   tryCompleteScan(scanId, trigger) recount, then the single conditional update running → completed | failed
 *
 * Completion requires `state: running`, `scheduling.state ∈ {done, failed}`, the round the recount was made for and
 * terminal ≥ scheduling.confirmed; it is the only path to `completed`/`failed` and is idempotent.
 */

export type ScanStats = ScanStatsDoc

export type CompletionTrigger = 'ingestor' | 'schedulerDone' | 'retryFailed' | 'resume' | 'periodic' | 'stalled' | (string & {})

export interface CompletionCollections {
  scans: Collection<ScanDoc>
  analyses: Collection<AnalysisDoc>
  events: Collection<EventDoc>
}

function collections(): CompletionCollections {
  const { scans, analyses, events } = useCollections()
  return { scans, analyses, events }
}

export type StatusCounts = Partial<Record<AnalysisStatus, number>>

export type CountedStats = Pick<ScanStatsDoc, 'pending' | 'retrying' | 'succeeded' | 'failed' | 'lost' | 'cancelled'>

/**
 * Exact stats from status counts. For cancelled scans the never-run seqs below `scheduling.confirmed` count as
 * cancelled implicitly (docs/data-model.md §4.5.3).
 */
export function statsFromCounts(counts: StatusCounts, scan: Pick<ScanDoc, 'state'> & { scheduling: Pick<ScanDoc['scheduling'], 'confirmed'> }): CountedStats {
  const stats: CountedStats = {
    pending: counts.pending ?? 0,
    retrying: counts.retrying ?? 0,
    succeeded: counts.succeeded ?? 0,
    failed: counts.failed ?? 0,
    lost: counts.lost ?? 0,
    cancelled: counts.cancelled ?? 0,
  }
  if (scan.state === 'cancelled') {
    const known = stats.pending + stats.retrying + stats.succeeded + stats.failed + stats.lost
    stats.cancelled = Math.max(stats.cancelled, scan.scheduling.confirmed - known, 0)
  }
  return stats
}

export function terminalOf(stats: CountedStats): number {
  return stats.succeeded + stats.failed + stats.lost + stats.cancelled
}

async function countStatuses(scanId: string, analyses: Collection<AnalysisDoc>): Promise<StatusCounts> {
  const groups = await analyses
    .aggregate<{ _id: AnalysisStatus; n: number }>([{ $match: { scanId } }, { $group: { _id: '$status', n: { $sum: 1 } } }])
    .toArray()
  return Object.fromEntries(groups.map((group) => [group._id, group.n]))
}

function statsSet(stats: CountedStats, now: Date): Record<string, unknown> {
  return {
    'stats.pending': stats.pending,
    'stats.retrying': stats.retrying,
    'stats.succeeded': stats.succeeded,
    'stats.failed': stats.failed,
    'stats.lost': stats.lost,
    'stats.cancelled': stats.cancelled,
    'stats.recountedAt': now,
  }
}

const RECOUNT_PROJECTION = { _id: 1, userId: 1, state: 1, round: 1, scheduling: 1, stats: 1 } as const

/** Counting attempts of one recount; only the last one writes even though the hint counters moved meanwhile. */
export const RECOUNT_ATTEMPTS = 3

type RecountView = Pick<ScanDoc, '_id' | 'userId' | 'state' | 'round' | 'scheduling' | 'stats'>

/** The hint counters the ingestor increments (docs/queue.md §6.8), as read before counting. */
function hintsUnchanged(stats: ScanStatsDoc): Record<string, number> {
  return { 'stats.succeeded': stats.succeeded, 'stats.failed': stats.failed, 'stats.retrying': stats.retrying }
}

/**
 * Counts the scan's analyses and writes the exact stats. The ingestor increments the hint counters after each flush,
 * and an increment that lands between the read of the scan and this write belongs to results the aggregation may
 * not have seen: overwriting it would leave the hints short until the next recount, and the ingestor's completion
 * check would miss the round's last results (docs/queue.md §6.9). So the write requires the hints it started from
 * and the recount counts again when they moved; the last attempt writes anyway.
 */
async function recount(scan: RecountView, deps: CompletionCollections, now: Date): Promise<{ stats: ScanStatsDoc; counted: CountedStats }> {
  let view = scan
  for (let attempt = 1; ; attempt++) {
    const counted = statsFromCounts(await countStatuses(view._id, deps.analyses), view)
    const last = attempt >= RECOUNT_ATTEMPTS
    const written = await deps.scans.updateOne(last ? { _id: view._id } : { _id: view._id, ...hintsUnchanged(view.stats) }, { $set: statsSet(counted, now) })
    if (last || written.matchedCount > 0) return { counted, stats: { ...view.stats, ...counted, recountedAt: now } }
    const fresh = (await deps.scans.findOne({ _id: view._id }, { projection: RECOUNT_PROJECTION })) as RecountView | null
    if (!fresh) return { counted, stats: { ...view.stats, ...counted, recountedAt: now } }
    view = fresh
  }
}

/** The authoritative recount of one scan; writes `stats` and `stats.recountedAt` and returns the new stats. */
export async function recountScan(scanId: string, deps: CompletionCollections = collections()): Promise<ScanStats> {
  const scan = await deps.scans.findOne({ _id: scanId }, { projection: RECOUNT_PROJECTION })
  if (!scan) throw new Error(`scan ${scanId} not found`)
  return (await recount(scan as RecountView, deps, new Date())).stats
}

function completionReason(scan: RecountView, counted: CountedStats, trigger: CompletionTrigger, now: Date): StateReasonDoc {
  const error = scan.scheduling.error
  if (error) return { code: 'schedulingFailed', message: `scheduling failed: ${error.message}`.slice(0, 1024), at: now }
  if (trigger === 'stalled') {
    return { code: 'stalled', message: `${counted.lost} analyses were recorded as lost after the scan stalled`, at: now }
  }
  return { code: 'completed', message: `all ${terminalOf(counted)} analyses finished`, at: now }
}

/**
 * Runs the completion function: recount, then one conditional update to `completed` (or `failed` when
 * `scheduling.error` is set). Returns true when this call completed the scan.
 */
export async function tryCompleteScan(scanId: string, trigger: CompletionTrigger, deps: CompletionCollections = collections()): Promise<boolean> {
  const scan = (await deps.scans.findOne({ _id: scanId }, { projection: RECOUNT_PROJECTION })) as RecountView | null
  if (!scan || scan.state !== 'running') return false
  if (scan.scheduling.state !== 'done' && scan.scheduling.state !== 'failed') return false
  const now = new Date()
  const { counted } = await recount(scan, deps, now)
  const terminal = terminalOf(counted)
  if (terminal < scan.scheduling.confirmed) return false
  const to = scan.scheduling.error ? 'failed' : 'completed'
  const stateReason = completionReason(scan, counted, trigger, now)
  const completed = await deps.scans.findOneAndUpdate(
    {
      _id: scanId,
      state: 'running',
      round: scan.round,
      'scheduling.state': { $in: ['done', 'failed'] },
      'scheduling.confirmed': { $lte: terminal },
    },
    { $set: { ...statsSet(counted, now), state: to, stateReason, completedAt: now, updatedAt: now } },
    { projection: { _id: 1 } },
  )
  if (!completed) return false
  useLogger('scans').info('scan finished', { scanId, state: to, trigger, terminal })
  await writeEvent(stateChangedEvent(scan, 'running', to, stateReason.code, stateReason.message), deps.events)
  return true
}
