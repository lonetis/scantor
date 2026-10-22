import type { DindMode, NodeState, PendingReason, ScanState, SchedulingState, WorkerRole, WorkerState } from '#shared/utils/enums'

// The snapshot placement works on and the plans it produces (docs/nodes.md §12). Everything here is plain data, so
// the planners are pure, deterministic functions that unit tests can table-drive.

export const MIB = 1024 * 1024
/** Per-container memory overhead on top of processes × memoryMiB (docs/data-model.md §4.5.1). */
export const CONTAINER_OVERHEAD_BYTES = 256 * MIB

export interface PlacementScan {
  id: string
  userId: string
  state: ScanState
  createdAt: Date
  startedAt: Date | null
  schedulingState: SchedulingState
  settings: {
    workers: number
    processes: number
    resources: { cpus: number; memoryMiB: number }
    nodeSelector: { pool: string; labels: Record<string, string> }
  }
  revision: { repository: string; digest: string; platform: { os: string; arch: string }; privileged: boolean }
}

export interface PlacementWorker {
  id: string
  scanId: string
  userId: string
  role: WorkerRole
  state: WorkerState
  nodeId: string | null
  createdAt: Date
  digest: string
  resources: { cpus: number; memoryMiB: number }
  privileged: boolean
  processes: { desired: number; assigned: number; running: number | null }
  /** the current `stateReason.code` (pending reasons) */
  reason: string | null
}

export interface PlacementNode {
  id: string
  builtIn: boolean
  state: NodeState
  cordoned: boolean
  hasToken: boolean
  pool: string
  labels: Record<string, string>
  maxWorkers: number | null
  info: {
    os: string
    arch: string
    cpus: number
    memoryBytes: number
    diskFreeBytes: number
    dindMode: DindMode
    maxWorkers: number
  } | null
}

export interface PlacementSnapshot {
  now: Date
  scans: PlacementScan[]
  /** workers in non-terminal states (pending … draining) */
  workers: PlacementWorker[]
  nodes: PlacementNode[]
  /** `user.maxWorkers` by user id (0 = unlimited; missing = unlimited) */
  userMaxWorkers: Record<string, number>
  /** in-memory busy[] length by worker id (state polls) */
  busy: Record<string, number>
  minFreeDiskBytes: number
  maxConcurrentPulls: number
}

/** Phase 1 (docs/nodes.md §12.1): workers to create, stop and drain so counts match the desired set. */
export interface DesiredPlan {
  inserts: { scanId: string; role: WorkerRole; count: number }[]
  /** pending workers no longer needed → stopped */
  stops: { workerId: string; scanId: string }[]
  /** placed workers no longer needed → draining */
  drains: { workerId: string; scanId: string; nodeId: string; reason: string }[]
  /** workers whose processes.desired must follow the scan's settings */
  desiredUpdates: { workerId: string; desired: number }[]
}

export interface Placement {
  workerId: string
  scanId: string
  nodeId: string
  dindMode: 'sysbox' | 'privileged' | null
  assigned: number
}

/** Phase 2 (docs/nodes.md §12.3–§12.6): placements, pending reasons, live resizes and the workersPending condition. */
export interface PlacementPlan {
  placements: Placement[]
  /** pending workers whose reason changed */
  pending: { workerId: string; scanId: string; reason: PendingReason; previous: string | null }[]
  resizes: { workerId: string; nodeId: string; assigned: number }[]
  /** per scan: the workersPending details, or null to clear the condition */
  conditions: Record<string, { count: number; reasons: Partial<Record<PendingReason, number>> } | null>
  /** nodes whose desired set changed (assignmentsRev must be bumped) */
  touchedNodes: string[]
}
