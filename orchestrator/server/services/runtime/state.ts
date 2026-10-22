import type { ScanState, SchedulingState, WorkerRole, WorkerState } from '#shared/utils/enums'
import type { ScanDoc, WorkerDoc } from '../../types/documents'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import type { WorkerPrincipal } from '../../utils/principal'
import { type BusyItem, forgetWorker, recordWorkerBusy } from '../inflight'
import { mergeRuntime } from './worker-runtime'

// POST /api/runtime/state (docs/api.md §8.2, docs/runtime.md §5): the runtime's heartbeat. `busy[]` feeds the
// in-memory in-flight store; `runtime.lastSeenAt` and `processes.running` are stored. The response tells the runtime
// what to do (`run`, `drain`, `stop`) and how many processes it may run: min(desired, node-applied) while scaling
// up, the desired value at once while scaling down (docs/nodes.md §12.6).

export type RuntimeAction = 'run' | 'drain' | 'stop'

export const STATE_POLL_MS = 5000

const STOPPED_SCAN_STATES: ScanState[] = ['cancelled', 'completed', 'failed', 'deleting', 'deleted']

export interface ActionInput {
  scanState: ScanState | null
  workerState: WorkerState
  role: WorkerRole
  workerEpoch: number
  schedulingState: SchedulingState
  schedulingEpoch: number
}

/** What a worker must do now (docs/api.md §8.2 action table). */
export function runtimeAction(input: ActionInput): RuntimeAction {
  if (input.scanState === null || STOPPED_SCAN_STATES.includes(input.scanState)) return 'stop'
  if (input.workerState === 'stopped' || input.workerState === 'lost') return 'stop'
  if (input.role === 'scheduler') {
    if (input.workerEpoch !== input.schedulingEpoch || input.schedulingState === 'failed') return 'stop'
  }
  if (input.workerState === 'draining' || input.scanState === 'paused') return 'drain'
  if (input.role === 'scheduler' && input.schedulingState !== 'pending' && input.schedulingState !== 'running') return 'drain'
  return 'run'
}

/** The processes a worker may run: schedulers 1; runners min(desired, applied) up, desired at once down. */
export function allowedProcesses(worker: Pick<WorkerDoc, 'role' | 'processes'>, maxProcessesPerWorker: number): number {
  if (worker.role === 'scheduler') return 1
  const limit = worker.processes.applied ?? worker.processes.assigned
  return Math.max(1, Math.min(worker.processes.desired, limit, maxProcessesPerWorker))
}

export interface StateReport {
  processes: { running: number; busy: number }
  busy: BusyItem[]
  consuming: boolean
  clockOffsetMs: number
  tmpFreeBytes: number
  counters?: Record<string, number>
  scheduler?: Record<string, unknown> | null
}

export interface RuntimeStateResponse {
  serverTime: number
  action: RuntimeAction
  processes: number
  scanState: ScanState | 'deleted'
  nextPollMs: number
}

export async function handleRuntimeState(principal: WorkerPrincipal, report: StateReport, settings: { maxProcessesPerWorker: number }, log: Logger): Promise<RuntimeStateResponse> {
  const { workers, scans } = useCollections()
  const now = new Date()
  const { worker: identity } = principal
  const [worker, scan] = await Promise.all([
    workers.findOneAndUpdate(
      { _id: identity.id },
      [{ $set: { runtime: mergeRuntime({ lastSeenAt: now }), 'processes.running': report.processes.running, updatedAt: now } }],
      { returnDocument: 'after' },
    ),
    scans.findOne({ _id: identity.scanId }, { projection: { state: 1, scheduling: 1 } }) as Promise<Pick<ScanDoc, '_id' | 'state' | 'scheduling'> | null>,
  ])
  if (!worker) {
    forgetWorker(identity.id)
    return { serverTime: Date.now(), action: 'stop', processes: 0, scanState: scan?.state ?? 'deleted', nextPollMs: STATE_POLL_MS }
  }
  const action = runtimeAction({
    scanState: scan?.state ?? null,
    workerState: worker.state,
    role: worker.role,
    workerEpoch: worker.epoch,
    schedulingState: scan?.scheduling.state ?? 'failed',
    schedulingEpoch: scan?.scheduling.epoch ?? -1,
  })
  if (action === 'stop') forgetWorker(identity.id)
  else recordWorkerBusy({ workerId: identity.id, scanId: identity.scanId, nodeId: identity.nodeId, busy: report.busy, at: now })
  if (worker.runtime === null) log.debug('state poll before the first bootstrap', { workerId: identity.id })
  return {
    serverTime: Date.now(),
    action,
    processes: allowedProcesses(worker, settings.maxProcessesPerWorker),
    scanState: scan?.state ?? 'deleted',
    nextPollMs: STATE_POLL_MS,
  }
}
