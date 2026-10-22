import type { ConditionType, ScanState, SchedulingState, Severity, WorkerState } from '../utils/enums'
import type { IsoDate, Platform, ScanSettings, ScantorError, ScheduleDescription, SecretPaths, StateReason } from './common'

// Scan representations (docs/api.md §2, §4.13; docs/data-model.md §4.5).

export interface ScanTaskRef {
  id: string
  name: string
}

export interface ScanRevisionRef {
  id: string
  number: number
  ref: string
  language: string
  repository: string
  digest: string
  platform: Platform
  privileged: boolean
  schedule: ScheduleDescription
}

export interface Resolution {
  template: string
  scanConfig: Record<string, unknown>
  provenance: Record<string, unknown>
  expectedTotal: number | null
  at: IsoDate
}

export interface Scheduling {
  state: SchedulingState
  confirmed: number
  tailHash: string | null
  epoch: number
  restarts: number
  resolved: Record<string, Resolution>
  error: ScantorError | null
  startedAt: IsoDate | null
  checkpointAt: IsoDate | null
  doneAt: IsoDate | null
}

export interface ScanStats {
  pending: number
  retrying: number
  succeeded: number
  failed: number
  lost: number
  cancelled: number
  expectedTotal: number | null
  ratePerMin: number
  recountedAt: IsoDate | null
}

/** `total` = expectedTotal if known, else `scheduling.confirmed` once scheduling is done, else null. */
export interface ScanProgress {
  scheduled: number
  terminal: number
  total: number | null
  percent: number | null
  etaSeconds: number | null
}

export interface ScanWorkersSummary {
  desired: number
  active: number
  pending: number
  byState: Partial<Record<WorkerState, number>>
}

export interface Condition {
  type: ConditionType
  severity: Severity
  reason: string
  message: string
  since: IsoDate
  updatedAt: IsoDate
  details?: Record<string, unknown>
}

export interface Breaker {
  trippedAt: IsoDate
  ratio: number
  attempts: number
  windowMs: number
}

export interface Scan {
  id: string
  userId: string
  name?: string | null
  task: ScanTaskRef
  revision: ScanRevisionRef
  state: ScanState
  stateReason: StateReason | null
  taskConfig: Record<string, unknown>
  scanConfig: Record<string, unknown>
  secretPaths: SecretPaths
  uploadIds: string[]
  settings: ScanSettings
  round: number
  scheduling: Scheduling
  stats: ScanStats
  progress: ScanProgress
  workers: ScanWorkersSummary
  conditions: Condition[]
  breaker: Breaker | null
  clonedFrom: string | null
  createdAt: IsoDate
  updatedAt: IsoDate
  startedAt: IsoDate | null
  pausedAt: IsoDate | null
  completedAt: IsoDate | null
  deletedAt: IsoDate | null
}

export interface ScanSummary {
  id: string
  userId: string
  name?: string | null
  task: ScanTaskRef
  revision: { id: string; number: number; ref: string }
  state: ScanState
  stateReason: StateReason | null
  settings: Pick<ScanSettings, 'workers' | 'processes'>
  progress: ScanProgress
  stats: ScanStats
  conditionsCount: number
  createdAt: IsoDate
  completedAt: IsoDate | null
}

export interface InflightAnalysis {
  analysisId: string
  seq: number
  round: number
  attempt: number
  startedAt: IsoDate
  workerId: string
  nodeId: string
  progress: unknown
}

export interface InflightList {
  items: InflightAnalysis[]
  updatedAt: IsoDate | null
}

export interface WorkerLogs {
  text: string
  collectedAt: IsoDate | null
  requestedAt: IsoDate | null
  pending: boolean
  truncated: boolean
}
