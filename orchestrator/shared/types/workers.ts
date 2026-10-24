import type { WorkerRole, WorkerState } from '../utils/enums'
import type { IsoDate, ProcessResources, ScantorError } from './common'

// Worker representation (docs/api.md §2; docs/data-model.md §4.7). `Worker` collides with the DOM global of the
// same name when auto-imported into app code; import it explicitly or use the `ScanWorker` alias there.

export interface WorkerSpec {
  repository: string
  digest: string
  resources: ProcessResources
  privileged: boolean
  dindMode: 'sysbox' | 'privileged' | null
}

export interface WorkerProcesses {
  desired: number
  assigned: number
  applied: number | null
  running: number | null
}

export interface WorkerContainer {
  id: string
  name: string
  startedAt: IsoDate | null
  restarts: number
  lastExit: { exitCode: number; oomKilled: boolean; at: IsoDate; logTail: string } | null
  nextRestartAt: IsoDate | null
}

/** A scheduler's cumulative publish counters from its latest state poll (docs/runtime.md §5.1). */
export interface WorkerSchedulerCounters {
  published: number
  confirmed: number
  /** publishes the full scan queue refused (`x-overflow: reject-publish`), republished later */
  nacked: number
  backpressure: boolean
}

export interface WorkerRuntime {
  version: string | null
  protocolVersion: number | null
  bootstrappedAt: IsoDate | null
  lastSeenAt: IsoDate | null
  lastError: ScantorError | null
  /** schedulers only: the publish counters of the latest state poll (null for runners and before the first poll) */
  scheduler: WorkerSchedulerCounters | null
}

export interface Worker {
  id: string
  userId: string
  scanId: string
  role: WorkerRole
  nodeId: string | null
  epoch: number
  state: WorkerState
  stateReason: { code: string; message: string; at: IsoDate } | null
  spec: WorkerSpec
  processes: WorkerProcesses
  container: WorkerContainer | null
  runtime: WorkerRuntime | null
  /** the latest on-demand log tail (docs/data-model.md §4.7) */
  logs: WorkerLogTail | null
  node: { id: string; name: string } | null
  scan: { id: string; name: string | null }
  createdAt: IsoDate
  assignedAt: IsoDate | null
  startedAt: IsoDate | null
  stoppedAt: IsoDate | null
  updatedAt: IsoDate
  /** set on `stopped`/`lost`: the document expires 7 days after it stopped */
  expiresAt?: IsoDate | null
}

export interface WorkerLogTail {
  requestId: string
  requestedAt: IsoDate
  tailBytes: number
  text: string | null
  collectedAt: IsoDate | null
  truncated: boolean
}

export type ScanWorker = Worker
