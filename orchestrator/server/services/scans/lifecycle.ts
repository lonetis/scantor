import type { Filter, UpdateFilter } from 'mongodb'
import type { ScaleScanBody } from '#shared/schemas/scans'
import type { ScanAction } from '#shared/utils/scan-actions'
import { ACTIVE_SCAN_STATES, TERMINAL_SCAN_STATES } from '#shared/utils/enums'
import type { JobDoc, ScanDoc, StateReasonDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import { ApiError, apiError, notFound, validationError } from '../../utils/errors'
import { cancelActiveJobs, createJob } from '../../utils/jobs'
import { useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { assertPrivilegedAllowed, loadScanRevision } from './access'
import { setCondition } from './conditions'
import { stateChangedEvent, writeEvent } from './events'
import { decideTransition } from './state-machine'

/*
 * Scan lifecycle operations (docs/architecture.md §11.3, docs/queue.md §8). Every operation only changes intent in
 * MongoDB (plus a job for retry-failed and delete); the reconciler converges RabbitMQ, workers and analyses.
 * Updates are conditional on the state the decision was made for; a concurrent change makes the update miss, and
 * the decision is made again on the fresh document.
 */

const MAX_ATTEMPTS = 3

export interface TransitionResult {
  scan: ScanDoc
  changed: boolean
}

function reason(code: string, message: string, at: Date): StateReasonDoc {
  return { code, message, at }
}

async function loadScan(scanId: string): Promise<ScanDoc> {
  const scan = await useCollections().scans.findOne({ _id: scanId })
  if (!scan) throw notFound('scan')
  return scan
}

/**
 * Applies a lifecycle action: decides on `scan`, then updates conditionally on its state; on a lost race reloads and
 * decides again. `build` returns the extra filter and the update of an allowed transition.
 */
async function transition(
  scan: ScanDoc,
  action: ScanAction,
  build: (current: ScanDoc, now: Date) => { filter?: Filter<ScanDoc>; update: UpdateFilter<ScanDoc> },
): Promise<TransitionResult> {
  const { scans } = useCollections()
  let current = scan
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (decideTransition(action, current) === 'unchanged') return { scan: current, changed: false }
    const now = new Date()
    const { filter, update } = build(current, now)
    const updated = await scans.findOneAndUpdate({ _id: current._id, state: current.state, ...filter }, update, { returnDocument: 'after' })
    if (updated) return { scan: updated, changed: true }
    current = await loadScan(current._id)
  }
  throw apiError('invalidState', 'the scan changed concurrently; try again', { state: current.state })
}

async function stateChanged(before: ScanDoc, after: ScanDoc): Promise<void> {
  if (before.state === after.state) return
  await writeEvent(stateChangedEvent(after, before.state, after.state, after.stateReason?.code ?? 'user', after.stateReason?.message))
}

// ── pause, resume, scale, cancel ────────────────────────────────────────────

export async function pauseScan(scan: ScanDoc): Promise<ScanDoc> {
  const result = await transition(scan, 'pause', (_current, now) => ({
    update: { $set: { state: 'paused', pausedAt: now, updatedAt: now, stateReason: reason('user', 'paused by the user', now) } },
  }))
  if (result.changed) await stateChanged(scan, result.scan)
  return result.scan
}

export async function resumeScan(scan: ScanDoc): Promise<ScanDoc> {
  if (scan.state === 'paused') {
    await loadScanRevision(scan)
    await assertPrivilegedAllowed(scan.revision.privileged, scan.userId)
  }
  const hadBreaker = scan.conditions.some((condition) => condition.type === 'breakerTripped')
  const result = await transition(scan, 'resume', (_current, now) => ({
    update: {
      $set: { state: 'running', updatedAt: now, stateReason: reason('user', 'resumed by the user', now) },
      $pull: { conditions: { type: 'breakerTripped' } },
    },
  }))
  if (!result.changed) return result.scan
  await stateChanged(scan, result.scan)
  if (hadBreaker) {
    await writeEvent({
      type: 'scan.conditionCleared',
      level: 'info',
      userId: scan.userId,
      scanId: scan._id,
      message: 'condition breakerTripped cleared',
      data: { type: 'breakerTripped', reason: 'resumed' },
    })
  }
  return result.scan
}

/** Instance limits of scaleScan (400 validationFailed above them). */
export function scaleIssues(body: ScaleScanBody, config: Pick<Config, 'maxWorkersPerScan' | 'maxProcessesPerWorker'>) {
  const issues: { path: string; message: string }[] = []
  if (body.workers !== undefined && body.workers > config.maxWorkersPerScan) {
    issues.push({ path: 'workers', message: `must be between 1 and ${config.maxWorkersPerScan}` })
  }
  if (body.processes !== undefined && body.processes > config.maxProcessesPerWorker) {
    issues.push({ path: 'processes', message: `must be between 1 and ${config.maxProcessesPerWorker}` })
  }
  return issues
}

export async function scaleScan(scan: ScanDoc, body: ScaleScanBody, config: Config): Promise<ScanDoc> {
  const issues = scaleIssues(body, config)
  if (issues.length > 0) throw validationError(issues)
  const workers = body.workers ?? scan.settings.workers
  const processes = body.processes ?? scan.settings.processes
  decideTransition('scale', scan)
  if (workers === scan.settings.workers && processes === scan.settings.processes) return scan
  const result = await transition(scan, 'scale', (_current, now) => ({
    update: { $set: { 'settings.workers': workers, 'settings.processes': processes, updatedAt: now } },
  }))
  await writeEvent({
    type: 'scan.scaled',
    level: 'info',
    userId: scan.userId,
    scanId: scan._id,
    message: `scaled to ${workers} workers × ${processes} processes`,
    data: { workers, processes },
  })
  return result.scan
}

export async function cancelScan(scan: ScanDoc, cause: { code: string; message: string } = { code: 'user', message: 'cancelled by the user' }): Promise<ScanDoc> {
  const result = await transition(scan, 'cancel', (current, now) => ({
    update: {
      $set: {
        state: 'cancelled',
        completedAt: now,
        updatedAt: now,
        stateReason: reason(cause.code, cause.message, now),
        // An interrupted retry of failed analyses ends here; scheduling returns to its finished state.
        ...(current.scheduling.state === 'retrying' ? { 'scheduling.state': current.scheduling.error ? 'failed' : 'done' } : {}),
      },
    },
  }))
  if (!result.changed) return result.scan
  const cancelledJobs = await cancelActiveJobs('scanRetryFailed', scan._id)
  if (cancelledJobs > 0) useLogger('scans').info('cancelled the retry-failed job of a cancelled scan', { scanId: scan._id })
  await stateChanged(scan, result.scan)
  return result.scan
}

// ── retry-failed ────────────────────────────────────────────────────────────

/** Number of analyses retry-failed would reset (failed or lost with a stored config, up to `limit`). */
export async function retryableCount(scanId: string, round: number, limit = 1): Promise<number> {
  return useCollections().analyses.countDocuments(
    { scanId, status: { $in: ['failed', 'lost'] }, round: { $lte: round }, config: { $exists: true } },
    { limit },
  )
}

export async function retryFailedAnalyses(scan: ScanDoc): Promise<{ scan: ScanDoc; job: JobDoc }> {
  decideTransition('retryFailed', scan)
  await loadScanRevision(scan)
  await assertPrivilegedAllowed(scan.revision.privileged, scan.userId)
  if ((await retryableCount(scan._id, scan.round)) === 0) {
    throw apiError('nothingToRetry', 'no failed or lost analysis with a stored config to retry; restart the scan to re-run cancelled or never-run analyses')
  }

  const round = scan.round + 1
  const cancelled = scan.state === 'cancelled'
  // The job is created first (the partial unique index allows one active retry per scan) and starts a moment
  // later; its handler checks that the scan really entered `retrying` for this round before it touches anything.
  // The cancel time lets the job wait for the cancelled round to settle (retry-failed.ts settleEarlierRounds).
  const { job, created } = await createJob({
    kind: 'scanRetryFailed',
    userId: scan.userId,
    subject: { kind: 'scan', id: scan._id },
    params: { round, materialize: cancelled, ...(cancelled ? { cancelledAt: scan.completedAt ?? new Date() } : {}) },
    notBefore: new Date(Date.now() + 2000),
  })
  if (!created) throw apiError('invalidState', 'a retry of failed analyses is already running', { state: scan.state })

  const now = new Date()
  const { scans } = useCollections()
  const updated = await scans.findOneAndUpdate(
    { _id: scan._id, state: scan.state, round: scan.round, 'scheduling.state': { $in: ['done', 'failed'] } },
    {
      $set: {
        round,
        'scheduling.state': 'retrying',
        state: 'running',
        completedAt: null,
        updatedAt: now,
        stateReason: reason('user', `retrying failed and lost analyses in round ${round}`, now),
      },
    },
    { returnDocument: 'after' },
  )
  if (!updated) {
    await cancelActiveJobs('scanRetryFailed', scan._id)
    const fresh = await loadScan(scan._id)
    decideTransition('retryFailed', fresh)
    throw apiError('invalidState', 'the scan changed concurrently; try again', { state: fresh.state })
  }
  await stateChanged(scan, updated)
  return { scan: updated, job }
}

// ── delete ──────────────────────────────────────────────────────────────────

export async function deleteScan(scan: ScanDoc): Promise<{ scan: ScanDoc; job: JobDoc }> {
  const result = await transition(scan, 'delete', (_current, now) => ({
    filter: { state: { $in: [...TERMINAL_SCAN_STATES] } },
    update: { $set: { state: 'deleting', updatedAt: now, stateReason: reason('user', 'deleted by the user', now) } },
  }))
  const { job } = await createJob({ kind: 'scanDelete', userId: scan.userId, subject: { kind: 'scan', id: scan._id } })
  if (result.changed) await stateChanged(scan, result.scan)
  return { scan: result.scan, job }
}

// ── system-initiated transitions (contracts for other areas) ────────────────

/**
 * Pauses a running scan on behalf of the platform: the ingestor's circuit breaker (`failureRate`, details
 * `{ratio, attempts, windowMs}`, condition `breakerTripped`) or another system reason. No-op unless running.
 */
export async function pauseScanBySystem(scanId: string, pauseReason: 'failureRate' | 'brokerAlarm' | (string & {}), details?: object): Promise<void> {
  const { scans } = useCollections()
  const now = new Date()
  const info = (details ?? {}) as Record<string, unknown>
  const set: Record<string, unknown> = { state: 'paused', pausedAt: now, updatedAt: now }
  if (pauseReason === 'failureRate') {
    const ratio = Number(info.ratio ?? 0)
    const attempts = Number(info.attempts ?? 0)
    const windowMs = Number(info.windowMs ?? 0)
    set.stateReason = reason('failureRate', `${Math.round(ratio * 100)}% of the last ${attempts} attempts failed`, now)
    set.breaker = { trippedAt: now, ratio, attempts, windowMs }
  } else {
    set.stateReason = reason(pauseReason, typeof info.message === 'string' ? info.message : `paused by the platform (${pauseReason})`, now)
  }
  const before = await scans.findOneAndUpdate({ _id: scanId, state: 'running' }, { $set: set }, { returnDocument: 'before' })
  if (!before) return
  const after = { ...before, ...(set as Partial<ScanDoc>) } as ScanDoc
  useLogger('scans').warn('scan paused by the platform', { scanId, reason: pauseReason })
  await stateChanged(before, after)
  if (pauseReason === 'failureRate') {
    const breaker = set.breaker as { ratio: number; attempts: number; windowMs: number }
    await setCondition(before, {
      type: 'breakerTripped',
      reason: 'failureRate',
      message: (set.stateReason as StateReasonDoc).message,
      details: { ratio: breaker.ratio, attempts: breaker.attempts, windowMs: breaker.windowMs },
    }, now)
  }
}

/** Cancels every non-terminal scan of a user (ban with cancelScans, user purge step 10). */
export async function cancelScansOfUser(userId: string): Promise<void> {
  const { scans } = useCollections()
  const active = await scans.find({ userId, state: { $in: [...ACTIVE_SCAN_STATES] } }).toArray()
  for (const scan of active) {
    try {
      await cancelScan(scan, { code: 'user', message: 'cancelled because the owner lost access' })
    } catch (error) {
      // The scan finished meanwhile (completed or failed): nothing left to cancel.
      if (!(error instanceof ApiError) || error.data?.code !== 'invalidState') throw error
    }
  }
}
