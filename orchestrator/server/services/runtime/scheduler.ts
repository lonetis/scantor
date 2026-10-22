import { ACTIVE_WORKER_STATES } from '#shared/utils/enums'
import type { ResolutionDoc, ScanDoc, ScantorErrorDoc } from '../../types/documents'
import { apiError } from '../../utils/errors'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import type { WorkerPrincipal } from '../../utils/principal'
import { isoDate } from '../../utils/serialize'
import { notifyAssignmentsChanged } from '../nodes/assignments'
import { recordEvent } from '../nodes/events'
import { tryCompleteScan } from '../scans/completion'
import { clearScanCondition, raiseScanCondition } from './conditions'

// Scheduler routes of the runtime API (docs/api.md §8.5–§8.7, docs/runtime.md §11): template resolutions, the
// contiguous confirmed prefix (checkpoints with `$max` semantics) and the end of scheduling. Every call is fenced by
// the scheduling epoch: the worker's own epoch (from its token) must be the scan's current epoch and equal the
// epoch in the body, otherwise 409 staleEpoch with `details.currentEpoch` (docs/data-model.md §7 invariant 3, 4).
// `countSchedulerRestart` counts scheduler crashes and retryable scheduling errors and fails scheduling above
// SCANTOR_SCHEDULER_MAX_RESTARTS.

export const MAX_RESOLUTIONS = 16
const UNFINISHED = ['pending', 'running'] as const

function staleEpoch(requested: number, currentEpoch: number) {
  return apiError('staleEpoch', `scheduler epoch ${requested} was superseded`, { currentEpoch })
}

async function loadScan(scanId: string): Promise<ScanDoc> {
  const scan = await useCollections().scans.findOne({ _id: scanId })
  // A token of a worker of a vanished scan: the worker is gone too.
  if (!scan) throw apiError('unauthorized', 'the scan of this worker no longer exists')
  return scan
}

/** Asserts that the scheduler's epoch is current; returns the scan. */
export async function assertSchedulerEpoch(principal: WorkerPrincipal, bodyEpoch: number): Promise<ScanDoc> {
  const scan = await loadScan(principal.worker.scanId)
  const current = scan.scheduling.epoch
  if (bodyEpoch !== principal.worker.epoch || principal.worker.epoch !== current) throw staleEpoch(bodyEpoch, current)
  return scan
}

export function toApiResolution(resolution: ResolutionDoc) {
  return { ...resolution, at: isoDate(resolution.at) }
}

// ── resolved ────────────────────────────────────────────────────────────────

export interface ResolvedInput {
  epoch: number
  key: string
  template: string
  scanConfig: Record<string, unknown>
  provenance: Record<string, unknown>
  expectedTotal: number | null
}

export async function recordResolution(principal: WorkerPrincipal, input: ResolvedInput, log: Logger) {
  const { scans } = useCollections()
  const scan = await assertSchedulerEpoch(principal, input.epoch)
  const existing = scan.scheduling.resolved?.[input.key]
  if (existing) return { stored: false, resolution: toApiResolution(existing) }
  if (Object.keys(scan.scheduling.resolved ?? {}).length >= MAX_RESOLUTIONS) {
    throw apiError('validationFailed', `at most ${MAX_RESOLUTIONS} resolutions per scan`, {
      issues: [{ path: 'key', message: `at most ${MAX_RESOLUTIONS} resolutions per scan` }],
    })
  }
  const now = new Date()
  const resolution: ResolutionDoc = {
    template: input.template,
    scanConfig: input.scanConfig,
    provenance: input.provenance,
    expectedTotal: input.expectedTotal,
    at: now,
  }
  const field = `scheduling.resolved.${input.key}`
  const set: Record<string, unknown> = { [field]: resolution, updatedAt: now }
  if (input.key === 'schedule') set['stats.expectedTotal'] = input.expectedTotal
  const updated = await scans.updateOne(
    { _id: scan._id, 'scheduling.epoch': input.epoch, [field]: { $exists: false } },
    { $set: set },
  )
  if (updated.modifiedCount === 0) {
    // Another epoch resolved first, or the epoch moved on meanwhile.
    const fresh = await loadScan(scan._id)
    const stored = fresh.scheduling.resolved?.[input.key]
    if (stored) return { stored: false, resolution: toApiResolution(stored) }
    throw staleEpoch(input.epoch, fresh.scheduling.epoch)
  }
  await recordEvent({
    type: 'scan.schedulingResolved',
    level: 'info',
    userId: scan.userId,
    scanId: scan._id,
    workerId: principal.worker.id,
    message: `template ${input.template} resolved (${input.key})`,
    data: { key: input.key, template: input.template, provenance: input.provenance },
    at: now,
  }, log)
  return { stored: true, resolution: toApiResolution(resolution) }
}

// ── checkpoint ──────────────────────────────────────────────────────────────

export interface CheckpointInput {
  epoch: number
  confirmed: number
  tailHash: string | null
}

export async function recordCheckpoint(principal: WorkerPrincipal, input: CheckpointInput) {
  const { scans } = useCollections()
  const scan = await assertSchedulerEpoch(principal, input.epoch)
  const now = new Date()
  // Invariant 3: `confirmed` only increases; a stale or equal checkpoint returns the stored values unchanged.
  await scans.updateOne(
    { _id: scan._id, 'scheduling.epoch': input.epoch, 'scheduling.confirmed': { $lt: input.confirmed } },
    { $set: { 'scheduling.confirmed': input.confirmed, 'scheduling.tailHash': input.tailHash, 'scheduling.checkpointAt': now, updatedAt: now } },
  )
  // Advanced or not (an older or equal prefix), the answer is what is stored now; a newer epoch is still fenced.
  const fresh = await loadScan(scan._id)
  if (fresh.scheduling.epoch !== input.epoch) throw staleEpoch(input.epoch, fresh.scheduling.epoch)
  return { confirmed: fresh.scheduling.confirmed, tailHash: fresh.scheduling.tailHash, serverTime: Date.now() }
}

// ── done ────────────────────────────────────────────────────────────────────

export interface DoneInput {
  epoch: number
  outcome: 'done' | 'failed'
  confirmed: number
  tailHash: string | null
  error: ScantorErrorDoc | null
}

/** Drains a scheduler worker after scheduling ended (it exits by itself; this removes it from the desired set). */
async function drainScheduler(workerId: string, nodeId: string, reason: string, now: Date): Promise<void> {
  const draining = ACTIVE_WORKER_STATES.filter((state) => state !== 'draining')
  const result = await useCollections().workers.updateOne(
    { _id: workerId, state: { $in: [...draining] } },
    { $set: { state: 'draining', stateReason: { code: reason, message: 'scheduling finished', at: now }, updatedAt: now } },
  )
  if (result.modifiedCount === 1) await notifyAssignmentsChanged(nodeId)
}

export async function recordSchedulingDone(principal: WorkerPrincipal, input: DoneInput, log: Logger) {
  const { scans } = useCollections()
  const scan = await assertSchedulerEpoch(principal, input.epoch)
  const now = new Date()
  const failed = input.outcome === 'failed'
  // The stored prefix only grows: take the reported one when it is at least the stored one.
  const advance = input.confirmed >= scan.scheduling.confirmed
  const set: Record<string, unknown> = {
    'scheduling.state': failed ? 'failed' : 'done',
    'scheduling.doneAt': now,
    'scheduling.checkpointAt': now,
    updatedAt: now,
  }
  if (advance) {
    set['scheduling.confirmed'] = input.confirmed
    set['scheduling.tailHash'] = input.tailHash
  }
  if (failed) set['scheduling.error'] = input.error
  const updated = await scans.findOneAndUpdate(
    { _id: scan._id, 'scheduling.epoch': input.epoch, 'scheduling.state': { $in: [...UNFINISHED] } },
    { $set: set },
    { returnDocument: 'after' },
  )
  let current = updated
  if (!updated) {
    // Idempotent for the same epoch: scheduling already ended (done, failed or retrying since).
    current = await loadScan(scan._id)
    if (current.scheduling.epoch !== input.epoch) throw staleEpoch(input.epoch, current.scheduling.epoch)
  } else if (failed) {
    await raiseScanCondition(
      scan._id,
      {
        type: 'schedulingFailed',
        severity: 'error',
        reason: input.error?.type ?? 'failed',
        message: `scheduling failed: ${input.error?.message ?? 'unknown error'}`,
        details: { error: input.error ? { ...input.error, at: isoDate(input.error.at) } : null },
      },
      scan.userId,
      now,
    )
    await recordEvent({
      type: 'scan.schedulingFailed',
      level: 'error',
      userId: scan.userId,
      scanId: scan._id,
      workerId: principal.worker.id,
      message: `scheduling failed: ${input.error?.message ?? 'unknown error'}`,
      data: { error: input.error ? { ...input.error, at: isoDate(input.error.at) } : null },
      at: now,
    }, log)
  } else {
    await recordEvent({
      type: 'scan.schedulingDone',
      level: 'info',
      userId: scan.userId,
      scanId: scan._id,
      workerId: principal.worker.id,
      message: `scheduling finished with ${updated.scheduling.confirmed} analyses`,
      data: { confirmed: updated.scheduling.confirmed },
      at: now,
    }, log)
  }
  await clearScanCondition(scan._id, 'schedulerRestarting', scan.userId, {}, now)
  await drainScheduler(principal.worker.id, principal.worker.nodeId, failed ? 'schedulingFailed' : 'schedulingDone', now)
  await tryCompleteScan(scan._id, 'schedulerDone')
  return { serverTime: Date.now(), scheduling: { state: current!.scheduling.state, confirmed: current!.scheduling.confirmed } }
}

// ── restarts ────────────────────────────────────────────────────────────────

/**
 * Counts one scheduler restart for a retryable or `schedule`-phase error report of the scheduler of `epoch`
 * (docs/api.md §8.8). Above SCANTOR_SCHEDULER_MAX_RESTARTS, scheduling fails (`scheduling.error` set, condition
 * schedulingFailed) and the next state poll returns `stop`. Crashed scheduler containers are counted by the
 * reconciler's scheduler supervision, which also owns the condition schedulerRestarting. Returns the new restart
 * count, or null when the epoch is not current or scheduling already ended.
 */
export async function countSchedulerRestart(scanId: string, epoch: number, error: ScantorErrorDoc, maxRestarts: number, log: Logger): Promise<number | null> {
  const { scans } = useCollections()
  const now = new Date()
  const scan = await scans.findOneAndUpdate(
    { _id: scanId, 'scheduling.epoch': epoch, 'scheduling.state': { $in: [...UNFINISHED] } },
    { $inc: { 'scheduling.restarts': 1 }, $set: { updatedAt: now } },
    { returnDocument: 'after', projection: { userId: 1, scheduling: 1 } },
  )
  if (!scan) return null
  const restarts = scan.scheduling.restarts
  if (restarts > maxRestarts) {
    const failure: ScantorErrorDoc = {
      ...error,
      retryable: false,
      message: `scheduling failed after ${restarts} restarts (SCANTOR_SCHEDULER_MAX_RESTARTS=${maxRestarts}): ${error.message}`.slice(0, 4096),
      at: now,
    }
    const failed = await scans.updateOne(
      { _id: scanId, 'scheduling.epoch': epoch, 'scheduling.state': { $in: [...UNFINISHED] } },
      { $set: { 'scheduling.state': 'failed', 'scheduling.error': failure, 'scheduling.doneAt': now, updatedAt: now } },
    )
    if (failed.modifiedCount === 1) {
      log.warn('scheduler restarted too often; scheduling failed', { scanId, restarts })
      await raiseScanCondition(
        scanId,
        { type: 'schedulingFailed', severity: 'error', reason: 'maxRestarts', message: failure.message, details: { error: { ...failure, at: isoDate(now) } } },
        scan.userId,
        now,
      )
      await recordEvent({ type: 'scan.schedulingFailed', level: 'error', userId: scan.userId, scanId, message: failure.message, data: { error: { ...failure, at: isoDate(now) } }, at: now }, log)
      await clearScanCondition(scanId, 'schedulerRestarting', scan.userId, {}, now)
      await tryCompleteScan(scanId, 'schedulingFailed')
    }
  }
  return restarts
}
