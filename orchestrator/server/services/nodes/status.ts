import type { NodeStatusBody, NodeWorkerReport } from '#shared/schemas/nodes'
import { ACTIVE_WORKER_STATES, type WorkerState } from '#shared/utils/enums'
import type { NodeDoc, StateReasonDoc, WorkerDoc } from '../../types/documents'
import { apiError } from '../../utils/errors'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { forgetWorker } from '../inflight'
import { clearScanCondition, raiseScanCondition } from '../runtime/conditions'
import { type EventInput, recordEvent, recordEvents } from './events'
import { leaseRemainingMs } from './lease'
import { tailBytesOf } from './logs'
import { workerExpiresAt } from './workers'

// POST /api/node/status (docs/api.md §7.3, docs/nodes.md §7): the node's heartbeat and a complete snapshot of its
// workers. The orchestrator stores the node info (including the clock offset, from which the reconciler derives the
// scan condition clockSkew), moves worker states (docs/data-model.md §6.6), records container details and applied
// limits, raises `crashLoop` and `imagePullFailed`, and completes drains: a `draining` worker reported `removed`, or
// absent from two consecutive reports, is `stopped`. Entries for workers that are not assigned to the reporting
// node are ignored and logged. Scheduler crashes are counted by the reconciler's scheduler supervision from the
// `container.lastExit` stored here.

/** Consecutive reports without a draining worker after which it counts as stopped. */
export const DRAIN_ABSENT_REPORTS = 2
const LOG_TAIL_MAX_BYTES = 4096

export interface WorkerUpdate {
  workerId: string
  /** the update applies only while the worker is in one of these states */
  fromStates: WorkerState[]
  set: Record<string, unknown>
}

export interface CrashReport {
  worker: WorkerDoc
  exitCode: number
  oomKilled: boolean
  restarts: number
  logTail: string
  at: Date
}

export interface StatusPlan {
  updates: WorkerUpdate[]
  crashes: CrashReport[]
  pullFailures: { worker: WorkerDoc; message: string }[]
  /** workers whose task image arrived on the node (assigned or pulling, now created): imagePullFailed clears */
  pulled: WorkerDoc[]
  stopped: WorkerDoc[]
  /** worker ids reported by the node that are not active workers of it */
  ignored: string[]
  /** next absence counts of draining workers */
  absences: Map<string, number>
}

const PRE_START: readonly WorkerState[] = ['assigned', 'pulling']
const CONTAINER_EXISTS: readonly NodeWorkerReport['state'][] = ['starting', 'running', 'backoff']

/** State transition implied by a report (null = none). */
export function nextWorkerState(current: WorkerState, reported: NodeWorkerReport['state']): WorkerState | null {
  switch (reported) {
    case 'pulling':
      return current === 'assigned' ? 'pulling' : null
    case 'starting':
    case 'running':
      // The node's `running` means the container runs; the worker is `running` only after its first bootstrap.
      return [...PRE_START, 'backoff'].includes(current) ? 'starting' : null
    case 'backoff':
      return [...PRE_START, 'starting', 'running'].includes(current) ? 'backoff' : null
    case 'removed':
      return current === 'draining' ? 'stopped' : null
    default:
      return null
  }
}

/** The last 4 KiB of a log tail, cut on a UTF-8 boundary. */
export function boundLogTail(text: string, maxBytes = LOG_TAIL_MAX_BYTES): string {
  return tailBytesOf(text, maxBytes).text
}

function exitReason(exitCode: number, oomKilled: boolean, at: Date): StateReasonDoc {
  if (exitCode === 0 && !oomKilled) return { code: 'exited', message: 'the runtime exited normally; restarting', at }
  return { code: 'crashed', message: `exited with code ${exitCode}${oomKilled ? ' (OOM killed)' : ''}`, at }
}

function sameTime(a: Date | null | undefined, b: Date): boolean {
  return a instanceof Date && a.getTime() === b.getTime()
}

/** Plans every worker change of one status report (pure; docs/data-model.md §6.6). */
export function planStatus(input: {
  workers: WorkerDoc[]
  reports: NodeWorkerReport[]
  absences: ReadonlyMap<string, number>
  now: Date
}): StatusPlan {
  const { now } = input
  const byId = new Map(input.workers.map((worker) => [worker._id, worker]))
  const reported = new Map<string, NodeWorkerReport>()
  const ignored: string[] = []
  for (const report of input.reports) {
    if (byId.has(report.workerId)) reported.set(report.workerId, report)
    else ignored.push(report.workerId)
  }

  const plan: StatusPlan = { updates: [], crashes: [], pullFailures: [], pulled: [], stopped: [], ignored, absences: new Map() }

  for (const worker of input.workers) {
    const report = reported.get(worker._id)
    if (!report) {
      if (worker.state === 'draining') {
        const absent = (input.absences.get(worker._id) ?? 0) + 1
        if (absent >= DRAIN_ABSENT_REPORTS) {
          plan.updates.push({
            workerId: worker._id,
            fromStates: ['draining'],
            set: { state: 'stopped', stoppedAt: now, expiresAt: workerExpiresAt(now), updatedAt: now },
          })
          plan.stopped.push(worker)
        } else {
          plan.absences.set(worker._id, absent)
        }
      }
      continue
    }

    const set: Record<string, unknown> = {}
    const next = nextWorkerState(worker.state, report.state)
    const reportedExit = report.lastExit
      ? { exitCode: report.lastExit.exitCode, oomKilled: report.lastExit.oomKilled, at: new Date(report.lastExit.at), logTail: boundLogTail(report.lastExit.logTail) }
      : null
    const lastExit = reportedExit ?? worker.container?.lastExit ?? null

    if (report.containerId) {
      set.container = {
        id: report.containerId,
        name: `scantor-w-${worker._id}`,
        startedAt: report.startedAt ? new Date(report.startedAt) : (worker.container?.startedAt ?? null),
        restarts: report.restarts ?? worker.container?.restarts ?? 0,
        lastExit,
        nextRestartAt: report.nextRestartAt ? new Date(report.nextRestartAt) : null,
      }
    }
    if (report.applied) set['processes.applied'] = report.applied.processes

    // A new exit with a non-zero code or an OOM kill is a crash; exit 0 (drain, stop, 401) never is.
    if (reportedExit && !sameTime(worker.container?.lastExit?.at, reportedExit.at) && (reportedExit.exitCode !== 0 || reportedExit.oomKilled)) {
      plan.crashes.push({
        worker,
        exitCode: reportedExit.exitCode,
        oomKilled: reportedExit.oomKilled,
        restarts: report.restarts ?? worker.container?.restarts ?? 0,
        logTail: reportedExit.logTail,
        at: reportedExit.at,
      })
    }

    if (worker.state !== 'draining') {
      if (report.state === 'backoff' && (next === 'backoff' || worker.state === 'backoff')) {
        set.stateReason = exitReason(lastExit?.exitCode ?? 0, lastExit?.oomKilled ?? false, now)
      } else if (report.state === 'error' && report.error) {
        set.stateReason = { code: report.error.code, message: report.error.message, at: now }
      } else if (next === 'starting' || next === 'pulling') {
        set.stateReason = null
      }
    }
    if (worker.state !== 'draining' && report.state === 'error' && report.error?.code === 'imagePullFailed') {
      plan.pullFailures.push({ worker, message: report.error.message })
    }
    if (PRE_START.includes(worker.state) && CONTAINER_EXISTS.includes(report.state)) plan.pulled.push(worker)

    if (next) {
      set.state = next
      if (next === 'stopped') {
        set.stoppedAt = now
        set.expiresAt = workerExpiresAt(now)
        plan.stopped.push(worker)
      }
      if (next === 'starting' && !worker.startedAt && report.startedAt) set.startedAt = new Date(report.startedAt)
    }
    if (Object.keys(set).length === 0) continue
    set.updatedAt = now
    // State changes are conditional on the state that was planned against; other fields apply in any active state.
    plan.updates.push({ workerId: worker._id, fromStates: next ? [worker.state] : [...ACTIVE_WORKER_STATES], set })
  }
  return plan
}

// ── handler ─────────────────────────────────────────────────────────────────

/** Absence counts of draining workers per worker id (in memory; restarting merely delays a stop by two reports). */
const drainAbsences = new Map<string, number>()

export interface NodeStatusResponse {
  serverTime: number
  rev: number
  nextStatusMs: number
}

export interface StatusSettings {
  nodeStatusIntervalMs: number
  nodeOfflineAfterMs: number
}

/** Stores the node part of a report; the update requires the reporting instance to still hold the lease. */
async function recordNodeReport(node: NodeDoc, body: NodeStatusBody, settings: StatusSettings, now: Date): Promise<number> {
  const { nodes } = useCollections()
  const info = {
    ...(node.info ?? { hostname: '', os: '', arch: '', kernel: '', dockerVersion: '' }),
    ...body.info,
    clockOffsetMs: body.clockOffsetMs,
  }
  const updated = await nodes.findOneAndUpdate(
    { _id: node._id, 'instance.id': body.instanceId, state: { $ne: 'revoked' }, tokenHash: { $type: 'string' } },
    { $set: { info, lastSeenAt: now, 'instance.lastSeenAt': now, 'instance.version': body.info.version, state: 'online', updatedAt: now } },
    { returnDocument: 'after', projection: { assignmentsRev: 1 } },
  )
  if (updated) return updated.assignmentsRev
  // The lease or the token changed between the lease check and this update.
  const current = await nodes.findOne({ _id: node._id }, { projection: { state: 1, tokenHash: 1, instance: 1 } })
  if (!current || current.state === 'revoked' || !current.tokenHash) throw apiError('unauthorized', 'unknown or revoked node token')
  throw apiError('nodeInstanceConflict', 'another daemon instance holds the lease of this node', {
    retryAfterMs: current.instance ? leaseRemainingMs(current.instance, now, settings.nodeOfflineAfterMs) : 0,
  })
}

export async function handleStatus(node: NodeDoc, body: NodeStatusBody, settings: StatusSettings, log: Logger): Promise<NodeStatusResponse> {
  const { workers } = useCollections()
  const now = new Date()
  const rev = await recordNodeReport(node, body, settings, now)
  if (node.state !== 'online') {
    await recordEvent({ type: 'node.online', level: 'info', nodeId: node._id, message: `node ${node.name} is online again`, data: { instanceId: body.instanceId }, at: now }, log)
  }

  const active = await workers.find({ nodeId: node._id, state: { $in: [...ACTIVE_WORKER_STATES] } }).toArray()
  const plan = planStatus({ workers: active, reports: body.workers ?? [], absences: drainAbsences, now })
  for (const worker of active) drainAbsences.delete(worker._id)
  for (const [workerId, count] of plan.absences) drainAbsences.set(workerId, count)

  if (plan.ignored.length > 0) {
    const known = await workers.countDocuments({ _id: { $in: plan.ignored }, nodeId: node._id })
    // Terminal workers of this node (lost while it was away) are expected until the daemon removes them.
    if (known < plan.ignored.length) {
      log.warn('node reported workers that are not assigned to it; ignored', { nodeId: node._id, count: plan.ignored.length - known })
    }
  }

  if (plan.updates.length > 0) {
    await workers.bulkWrite(
      plan.updates.map((update) => ({
        updateOne: { filter: { _id: update.workerId, nodeId: node._id, state: { $in: update.fromStates } }, update: { $set: update.set } },
      })),
      { ordered: false },
    )
  }
  for (const worker of plan.stopped) forgetWorker(worker._id)

  await applyStatusEffects(node, plan, now, log)
  return { serverTime: Date.now(), rev, nextStatusMs: settings.nodeStatusIntervalMs }
}

async function applyStatusEffects(node: NodeDoc, plan: StatusPlan, now: Date, log: Logger): Promise<void> {
  const events: EventInput[] = []
  for (const crash of plan.crashes) {
    const { worker } = crash
    const description = `worker exited with code ${crash.exitCode}${crash.oomKilled ? ' (OOM killed)' : ''}, restart ${crash.restarts}`
    events.push({
      type: 'worker.crashed',
      level: 'error',
      userId: worker.userId,
      scanId: worker.scanId,
      workerId: worker._id,
      nodeId: node._id,
      message: description,
      data: { exitCode: crash.exitCode, oomKilled: crash.oomKilled, restarts: crash.restarts },
      at: crash.at,
    })
    await raiseScanCondition(
      worker.scanId,
      {
        type: 'crashLoop',
        severity: 'error',
        reason: crash.oomKilled ? 'oomKilled' : 'exitCode',
        message: `a ${worker.role} worker keeps crashing: ${description}`,
        details: { workerId: worker._id, nodeId: node._id, exitCode: crash.exitCode, oomKilled: crash.oomKilled, restarts: crash.restarts, logTail: crash.logTail },
      },
      worker.userId,
      now,
    )
  }

  const pullFailureScans = new Map<string, { worker: WorkerDoc; message: string }>()
  for (const failure of plan.pullFailures) pullFailureScans.set(failure.worker.scanId, failure)
  for (const [scanId, { worker, message }] of pullFailureScans) {
    await raiseScanCondition(
      scanId,
      { type: 'imagePullFailed', severity: 'error', reason: 'imagePullFailed', message: `pulling the task image failed on node ${node.name}: ${message}`, details: { nodeId: node._id, message } },
      worker.userId,
      now,
    )
  }
  const pulledScans = new Map(plan.pulled.map((worker) => [worker.scanId, worker.userId]))
  for (const [scanId, userId] of pulledScans) {
    if (!pullFailureScans.has(scanId)) await clearScanCondition(scanId, 'imagePullFailed', userId, {}, now)
  }

  for (const worker of plan.stopped) {
    events.push({
      type: 'worker.stopped',
      level: 'info',
      userId: worker.userId,
      scanId: worker.scanId,
      workerId: worker._id,
      nodeId: node._id,
      message: `${worker.role} worker stopped`,
      data: { nodeId: node._id },
      at: now,
    })
  }
  await recordEvents(events, log)
}
