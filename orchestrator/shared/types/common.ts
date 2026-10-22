import type {
  BuildErrorPhase,
  JobKind,
  JobState,
  ScantorErrorPhase,
  ScantorErrorType,
  ScheduleKind,
  StateReasonCode,
} from '../utils/enums'
import type { ErrorCode } from '../utils/error-codes'

// Shared building blocks of the REST representations (docs/api.md §1.6, §2, docs/data-model.md §4). All
// timestamps are ISO 8601 UTC strings with milliseconds; durations are integer milliseconds (`…Ms`).

/** ISO 8601 UTC timestamp with milliseconds, for example `2026-10-21T09:00:00.000Z`. */
export type IsoDate = string

/** A cursor-paginated list (docs/api.md §1.8). */
export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

/** A bounded list without a cursor (API keys, credentials, nodes, conditions, templates). */
export interface ItemList<T> {
  items: T[]
}

/** The error envelope of every `/api/*` error except the documented exceptions (docs/api.md §1.7). */
export interface ErrorBody {
  error: {
    code: ErrorCode
    message: string
    details?: Record<string, unknown>
  }
}

/** One entry of `details.issues` for `validationFailed` and `configInvalid`. */
export interface ValidationIssue {
  path: string
  message: string
}

/** The unified, runtime-owned error model (docs/data-model.md §4.6). */
export interface ScantorError {
  type: ScantorErrorType
  message: string
  retryable: boolean
  phase: ScantorErrorPhase
  attempt: number
  stack?: string
  details?: Record<string, unknown>
  at: IsoDate
}

/** A structured task-pipeline error (docs/data-model.md §4.2). */
export interface BuildError {
  phase: BuildErrorPhase
  file?: string
  line?: number
  column?: number
  message: string
}

/** A reference to a file attached to an analysis (docs/architecture.md §11.5). */
export interface FileRef {
  id: string
  name: string
  size: number
  sha256: string
  contentType: string
}

export interface Backoff {
  initialMs: number
  factor: number
  maxMs: number
  jitter: boolean
}

/** Per-process resources; a container gets processes × value (+ 256 MiB memory overhead). */
export interface ProcessResources {
  cpus: number
  memoryMiB: number
}

export interface NodeSelector {
  pool: string
  labels: Record<string, string>
}

/** Effective scan settings (docs/data-model.md §4.5.1). */
export interface ScanSettings {
  workers: number
  processes: number
  timeoutMs: number
  maxAttempts: number
  backoff: Backoff
  resources: ProcessResources
  maxAnalysesPerProcess: number
  nodeSelector: NodeSelector
  privileged: boolean
}

/** Manifest defaults normalised by check-static: ScanSettings without `nodeSelector`. */
export type ScanSettingsDefaults = Omit<ScanSettings, 'nodeSelector'>

export interface Platform {
  os: string
  arch: string
}

export interface ScheduleDescription {
  kind: ScheduleKind
  template?: string
}

export interface SecretPaths {
  taskConfig: string[]
  scanConfig: string[]
  analysisConfig: string[]
  result: string[]
}

/** The describe output of a revision or draft image (docs/data-model.md §4.2). */
export interface Description {
  protocolVersion: number
  connector: { language: string; version: string }
  schemas: {
    taskConfig: Record<string, unknown>
    scanConfig: Record<string, unknown>
    analysisConfig: Record<string, unknown>
    result: Record<string, unknown>
  }
  schedule: ScheduleDescription
  secretPaths: SecretPaths
  uploadPaths: { taskConfig: string[]; scanConfig: string[] }
  fileRefPaths: string[]
  warnings: string[]
}

export interface StateReason {
  code: StateReasonCode | (string & {})
  message: string
  at: IsoDate
}

/** Reference to an asynchronous job, returned with 202 responses (docs/api.md §2). */
export interface JobRef {
  id: string
  kind: JobKind
  state: JobState
}

/** `{job}` body of 202 responses. */
export interface JobAccepted {
  job: JobRef
}

/** A presigned download location. */
export interface DownloadLocation {
  url: string
  expiresAt: IsoDate
}
