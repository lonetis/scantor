import type { ScantorError } from '#shared/types/common'
import type { Condition, Resolution, Scan, ScanProgress, ScanStats, ScanSummary, Scheduling, ScanWorkersSummary } from '#shared/types/scans'
import type { WorkerState } from '#shared/utils/enums'
import { ACTIVE_WORKER_STATES } from '#shared/utils/enums'
import type { ConditionDoc, ResolutionDoc, ScanDoc, ScanStatsDoc, ScantorErrorDoc, SchedulingDoc } from '../../types/documents'
import { maskSecrets } from '../../utils/secrets'
import { isoDate, isoDateOrNull } from '../../utils/serialize'
import { sortConditions } from './conditions'

// Scan representations (docs/api.md §2 `Scan`, `ScanSummary`): `_id` → `id`, ISO timestamps, `secrets` omitted,
// plus the derived `revision.ref`, `progress` and (for `Scan`) the `workers` summary.

const FINISHED_SCHEDULING = new Set(['done', 'failed', 'retrying'])

export function terminalCount(stats: Pick<ScanStatsDoc, 'succeeded' | 'failed' | 'lost' | 'cancelled'>): number {
  return stats.succeeded + stats.failed + stats.lost + stats.cancelled
}

/**
 * `total` = stats.expectedTotal when known, else scheduling.confirmed once scheduling finished, else null;
 * `etaSeconds` = (total − terminal) / ratePerMin × 60 for running scans, null when unknown (docs/api.md §2).
 */
export function scanProgress(scan: Pick<ScanDoc, 'state' | 'stats' | 'scheduling'>): ScanProgress {
  const scheduled = scan.scheduling.confirmed
  const terminal = terminalCount(scan.stats)
  const total = scan.stats.expectedTotal ?? (FINISHED_SCHEDULING.has(scan.scheduling.state) ? scheduled : null)
  let percent: number | null = null
  if (total !== null) percent = total === 0 ? 100 : Math.min(100, Math.floor((terminal / total) * 1000) / 10)
  let etaSeconds: number | null = null
  if (scan.state === 'running' && total !== null && scan.stats.ratePerMin > 0) {
    etaSeconds = Math.max(0, Math.round(((total - terminal) / scan.stats.ratePerMin) * 60))
  }
  return { scheduled, terminal, total, percent, etaSeconds }
}

export function toApiError(error: ScantorErrorDoc): ScantorError {
  const result: ScantorError = {
    type: error.type,
    message: error.message,
    retryable: error.retryable,
    phase: error.phase,
    attempt: error.attempt,
    at: isoDate(new Date(error.at)),
  }
  if (error.stack !== undefined) result.stack = error.stack
  if (error.details !== undefined) result.details = error.details
  return result
}

export function toApiCondition(condition: ConditionDoc): Condition {
  const result: Condition = {
    type: condition.type,
    severity: condition.severity,
    reason: condition.reason,
    message: condition.message,
    since: isoDate(condition.since),
    updatedAt: isoDate(condition.updatedAt),
  }
  if (condition.details) result.details = condition.details
  return result
}

function toApiResolution(resolution: ResolutionDoc, secretPaths: readonly string[]): Resolution {
  return {
    template: resolution.template,
    scanConfig: maskSecrets(resolution.scanConfig, secretPaths),
    provenance: resolution.provenance,
    expectedTotal: resolution.expectedTotal,
    at: isoDate(resolution.at),
  }
}

function toApiScheduling(scheduling: SchedulingDoc, secretPaths: readonly string[]): Scheduling {
  return {
    state: scheduling.state,
    confirmed: scheduling.confirmed,
    tailHash: scheduling.tailHash,
    epoch: scheduling.epoch,
    restarts: scheduling.restarts,
    resolved: Object.fromEntries(Object.entries(scheduling.resolved ?? {}).map(([key, value]) => [key, toApiResolution(value, secretPaths)])),
    error: scheduling.error ? toApiError(scheduling.error) : null,
    startedAt: isoDateOrNull(scheduling.startedAt),
    checkpointAt: isoDateOrNull(scheduling.checkpointAt),
    doneAt: isoDateOrNull(scheduling.doneAt),
  }
}

function toApiStats(stats: ScanStatsDoc): ScanStats {
  return {
    pending: stats.pending,
    retrying: stats.retrying,
    succeeded: stats.succeeded,
    failed: stats.failed,
    lost: stats.lost,
    cancelled: stats.cancelled,
    expectedTotal: stats.expectedTotal,
    ratePerMin: stats.ratePerMin,
    recountedAt: isoDateOrNull(stats.recountedAt),
  }
}

function stateReason(scan: Pick<ScanDoc, 'stateReason'>): Scan['stateReason'] {
  return scan.stateReason ? { code: scan.stateReason.code, message: scan.stateReason.message, at: isoDate(scan.stateReason.at) } : null
}

/** Desired worker count of a scan (docs/nodes.md §12.1): scheduler while scheduling is unfinished + runners. */
export function desiredWorkers(scan: Pick<ScanDoc, 'state' | 'settings' | 'scheduling'>): { scheduler: number; runners: number } {
  if (scan.state !== 'running') return { scheduler: 0, runners: 0 }
  return {
    scheduler: scan.scheduling.state === 'pending' || scan.scheduling.state === 'running' ? 1 : 0,
    runners: scan.settings.workers,
  }
}

/** Counts of the scan's non-terminal workers by state. */
export type WorkerStateCounts = Partial<Record<WorkerState, number>>

export function workersSummary(scan: Pick<ScanDoc, 'state' | 'settings' | 'scheduling'>, counts: WorkerStateCounts): ScanWorkersSummary {
  const desired = desiredWorkers(scan)
  let active = 0
  for (const state of ACTIVE_WORKER_STATES) active += counts[state] ?? 0
  const byState: WorkerStateCounts = {}
  for (const [state, count] of Object.entries(counts) as [WorkerState, number][]) if (count > 0) byState[state] = count
  return { desired: desired.scheduler + desired.runners, active, pending: counts.pending ?? 0, byState }
}

export function revisionRef(scan: Pick<ScanDoc, 'task' | 'revision'>): string {
  return `${scan.task.name}@${scan.revision.number}`
}

export function toApiScan(scan: ScanDoc, workerCounts: WorkerStateCounts): Scan {
  return {
    id: scan._id,
    userId: scan.userId,
    name: scan.name ?? null,
    task: { id: scan.task.id, name: scan.task.name },
    revision: { ...scan.revision, ref: revisionRef(scan) },
    state: scan.state,
    stateReason: stateReason(scan),
    taskConfig: scan.taskConfig,
    scanConfig: scan.scanConfig,
    secretPaths: scan.secretPaths,
    uploadIds: scan.uploadIds,
    settings: scan.settings,
    round: scan.round,
    scheduling: toApiScheduling(scan.scheduling, scan.secretPaths.scanConfig),
    stats: toApiStats(scan.stats),
    progress: scanProgress(scan),
    workers: workersSummary(scan, workerCounts),
    conditions: sortConditions(scan.conditions).map(toApiCondition),
    breaker: scan.breaker
      ? { trippedAt: isoDate(scan.breaker.trippedAt), ratio: scan.breaker.ratio, attempts: scan.breaker.attempts, windowMs: scan.breaker.windowMs }
      : null,
    clonedFrom: scan.clonedFrom,
    createdAt: isoDate(scan.createdAt),
    updatedAt: isoDate(scan.updatedAt),
    startedAt: isoDateOrNull(scan.startedAt),
    pausedAt: isoDateOrNull(scan.pausedAt),
    completedAt: isoDateOrNull(scan.completedAt),
    deletedAt: isoDateOrNull(scan.deletedAt),
  }
}

export function toScanSummary(scan: ScanDoc): ScanSummary {
  return {
    id: scan._id,
    userId: scan.userId,
    name: scan.name ?? null,
    task: { id: scan.task.id, name: scan.task.name },
    revision: { id: scan.revision.id, number: scan.revision.number, ref: revisionRef(scan) },
    state: scan.state,
    stateReason: stateReason(scan),
    settings: { workers: scan.settings.workers, processes: scan.settings.processes },
    progress: scanProgress(scan),
    stats: toApiStats(scan.stats),
    conditionsCount: scan.conditions.length,
    createdAt: isoDate(scan.createdAt),
    completedAt: isoDateOrNull(scan.completedAt),
  }
}
