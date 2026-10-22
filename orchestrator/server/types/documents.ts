import type {
  AnalysisStatus,
  BuildErrorPhase,
  ConditionType,
  CredentialKind,
  DindMode,
  EditorState,
  EndpointProfile,
  EventLevel,
  ExportFormat,
  ExportState,
  JobKind,
  JobState,
  JobSubjectKind,
  NodeState,
  RevisionSourceKind,
  RevisionState,
  ScanState,
  ScantorErrorPhase,
  ScantorErrorType,
  ScheduleKind,
  SchedulingState,
  Severity,
  TaskSourceKind,
  TestRunAnalysisStatus,
  TestRunState,
  UploadKind,
  WorkerRole,
  WorkerState,
} from '#shared/utils/enums'

// MongoDB document types of every scantor collection, including internal fields (docs/data-model.md §4).
// Server-only: API representations live in shared/types and are produced by mappers. Timestamps are BSON Dates.

// ── shared shapes ───────────────────────────────────────────────────────────

export interface ScantorErrorDoc {
  type: ScantorErrorType
  message: string
  retryable: boolean
  phase: ScantorErrorPhase
  attempt: number
  stack?: string
  details?: Record<string, unknown>
  at: Date
}

export interface BuildErrorDoc {
  phase: BuildErrorPhase
  file?: string
  line?: number
  column?: number
  message: string
}

export interface FileRefDoc {
  id: string
  name: string
  size: number
  sha256: string
  contentType: string
  /** internal: S3 key */
  key?: string
}

export interface BackoffDoc {
  initialMs: number
  factor: number
  maxMs: number
  jitter: boolean
}

export interface ProcessResourcesDoc {
  cpus: number
  memoryMiB: number
}

export interface ScanSettingsDoc {
  workers: number
  processes: number
  timeoutMs: number
  maxAttempts: number
  backoff: BackoffDoc
  resources: ProcessResourcesDoc
  maxAnalysesPerProcess: number
  nodeSelector: { pool: string; labels: Record<string, string> }
  privileged: boolean
}

export type ScanSettingsDefaultsDoc = Omit<ScanSettingsDoc, 'nodeSelector'>

export interface SecretPathsDoc {
  taskConfig: string[]
  scanConfig: string[]
  analysisConfig: string[]
  result: string[]
}

export interface DescriptionDoc {
  protocolVersion: number
  connector: { language: string; version: string }
  schemas: {
    taskConfig: Record<string, unknown>
    scanConfig: Record<string, unknown>
    analysisConfig: Record<string, unknown>
    result: Record<string, unknown>
  }
  schedule: { kind: ScheduleKind; template?: string }
  secretPaths: SecretPathsDoc
  uploadPaths: { taskConfig: string[]; scanConfig: string[] }
  fileRefPaths: string[]
  warnings: string[]
}

export interface StateReasonDoc {
  code: string
  message: string
  at: Date
}

export interface TimingsDoc {
  scheduledAt: Date | null
  startedAt: Date | null
  finishedAt: Date | null
  durationMs: number | null
}

export interface AttemptDoc {
  attempt: number
  round: number
  executionId: string
  workerId: string | null
  nodeId: string | null
  startedAt: Date | null
  finishedAt: Date | null
  durationMs: number | null
  error: ScantorErrorDoc | null
  logTail: string
}

// ── tasks (§4.1) ────────────────────────────────────────────────────────────

export interface GitSourceDoc {
  url: string
  ref: string
  path: string
  credentialId?: string | null
  commit: string
  packSha256: string
  pulledAt: Date
}

export interface RevisionPointerDoc {
  id: string
  number: number
  state: RevisionState
  packSha256: string
  createdAt: Date
}

export interface TaskDoc {
  _id: string
  userId: string
  name: string
  language: string
  description?: string | null
  source: { kind: TaskSourceKind; template?: string; git?: GitSourceDoc }
  workspace: {
    packSha256: string | null
    fileCount: number
    bytes: number
    checkedAt: Date | null
    lastSyncSha256: string | null
  }
  revisionSeq: number
  latestRevision: RevisionPointerDoc | null
  latestReadyRevision: RevisionPointerDoc | null
  privileged: boolean
  deletingAt?: Date | null
  createdAt: Date
  updatedAt: Date
}

// ── revisions (§4.2) ────────────────────────────────────────────────────────

export interface RevisionDoc {
  _id: string
  userId: string
  taskId: string
  taskName: string
  number: number
  state: RevisionState
  message?: string | null
  source: {
    kind: RevisionSourceKind
    packSha256: string
    packBytes: number
    fileCount: number
    git?: { url: string; ref: string; path: string; commit: string; dirty: boolean }
  }
  snapshotKey: string
  manifest?: Record<string, unknown> | null
  language?: string | null
  baseImage?: { ref: string; digest: string } | null
  image?: {
    repository: string
    tag: string
    digest: string
    bytes: number
    platform: { os: string; arch: string }
  } | null
  description?: DescriptionDoc | null
  settingsDefaults?: ScanSettingsDefaultsDoc | null
  privileged: boolean
  buildLogKey: string
  errors: BuildErrorDoc[]
  jobId: string
  createdAt: Date
  startedAt?: Date | null
  finishedAt?: Date | null
  updatedAt: Date
}

// ── testRuns, testRunAnalyses (§4.3, §4.4) ──────────────────────────────────

export interface TestRunDoc {
  _id: string
  userId: string
  taskId: string
  taskName: string
  state: TestRunState
  input: {
    taskConfig?: Record<string, unknown>
    scanConfig?: Record<string, unknown>
    analysisConfig?: Record<string, unknown>
    limit: number
    maxAttempts: number
    timeoutMs: number
  }
  /** internal: encrypted writeOnly input values by config kind and JSON pointer */
  secrets?: Record<string, Record<string, string>>
  packSha256?: string | null
  draftImage?: { ref: string; digest: string; cached: boolean } | null
  description?: DescriptionDoc | null
  errors: BuildErrorDoc[]
  summary: { analyses: number; succeeded: number; failed: number }
  buildLogKey: string
  logKey: string
  jobId: string
  createdAt: Date
  startedAt?: Date | null
  finishedAt?: Date | null
  updatedAt: Date
  expiresAt: Date
}

export interface TestRunAnalysisDoc {
  _id: string
  testRunId: string
  userId: string
  seq: number
  status: TestRunAnalysisStatus
  attempt: number
  config?: Record<string, unknown>
  result?: Record<string, unknown> | null
  error?: ScantorErrorDoc | null
  attempts: Omit<AttemptDoc, 'round' | 'executionId' | 'workerId' | 'nodeId'>[]
  files: FileRefDoc[]
  logTail?: string
  timings?: TimingsDoc
  createdAt: Date
  updatedAt: Date
  expiresAt: Date
}

// ── scans (§4.5) ────────────────────────────────────────────────────────────

export interface ResolutionDoc {
  template: string
  scanConfig: Record<string, unknown>
  provenance: Record<string, unknown>
  expectedTotal: number | null
  at: Date
}

export interface SchedulingDoc {
  state: SchedulingState
  confirmed: number
  tailHash: string | null
  epoch: number
  restarts: number
  resolved: Record<string, ResolutionDoc>
  error: ScantorErrorDoc | null
  startedAt: Date | null
  checkpointAt: Date | null
  doneAt: Date | null
}

export interface ScanStatsDoc {
  pending: number
  retrying: number
  succeeded: number
  failed: number
  lost: number
  cancelled: number
  expectedTotal: number | null
  ratePerMin: number
  recountedAt: Date | null
}

export interface ConditionDoc {
  type: ConditionType
  severity: Severity
  reason: string
  message: string
  since: Date
  updatedAt: Date
  details?: Record<string, unknown>
}

export interface ScanDoc {
  _id: string
  userId: string
  name?: string | null
  task: { id: string; name: string }
  revision: {
    id: string
    number: number
    language: string
    repository: string
    digest: string
    platform: { os: string; arch: string }
    privileged: boolean
    schedule: { kind: ScheduleKind; template?: string }
  }
  state: ScanState
  stateReason: StateReasonDoc | null
  taskConfig: Record<string, unknown>
  scanConfig: Record<string, unknown>
  /** internal: encrypted writeOnly values by config kind and JSON pointer */
  secrets: { taskConfig: Record<string, string>; scanConfig: Record<string, string> }
  secretPaths: SecretPathsDoc
  uploadIds: string[]
  settings: ScanSettingsDoc
  round: number
  scheduling: SchedulingDoc
  stats: ScanStatsDoc
  conditions: ConditionDoc[]
  breaker: { trippedAt: Date; ratio: number; attempts: number; windowMs: number } | null
  clonedFrom: string | null
  createdAt: Date
  updatedAt: Date
  startedAt: Date | null
  pausedAt: Date | null
  completedAt: Date | null
  deletedAt: Date | null
  purgeAfter?: Date
}

// ── analyses (§4.6) ─────────────────────────────────────────────────────────

export interface AnalysisDoc {
  _id: string
  scanId: string
  userId: string
  seq: number
  round: number
  status: AnalysisStatus
  attempt: number
  config?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: ScantorErrorDoc
  attempts: AttemptDoc[]
  files: FileRefDoc[]
  logTail?: string
  timings?: TimingsDoc
  workerId?: string
  nodeId?: string
  executionId?: string
  createdAt: Date
  updatedAt: Date
}

// ── workers (§4.7) ──────────────────────────────────────────────────────────

export interface WorkerDoc {
  _id: string
  userId: string
  scanId: string
  role: WorkerRole
  nodeId: string | null
  epoch: number
  state: WorkerState
  stateReason: StateReasonDoc | null
  spec: {
    repository: string
    digest: string
    resources: ProcessResourcesDoc
    privileged: boolean
    dindMode: 'sysbox' | 'privileged' | null
    specHash: string
  }
  processes: { desired: number; assigned: number; applied: number | null; running: number | null }
  container: {
    id: string
    name: string
    startedAt: Date | null
    restarts: number
    lastExit: { exitCode: number; oomKilled: boolean; at: Date; logTail: string } | null
    nextRestartAt: Date | null
  } | null
  runtime: {
    version: string | null
    protocolVersion: number | null
    bootstrappedAt: Date | null
    lastSeenAt: Date | null
    lastError: ScantorErrorDoc | null
  } | null
  logs: {
    requestId: string
    requestedAt: Date
    tailBytes: number
    text: string | null
    collectedAt: Date | null
    truncated: boolean
  } | null
  createdAt: Date
  assignedAt: Date | null
  startedAt: Date | null
  stoppedAt: Date | null
  updatedAt: Date
  expiresAt?: Date
}

// ── nodes (§4.8) ────────────────────────────────────────────────────────────

export interface NodeDoc {
  _id: string
  name: string
  builtIn: boolean
  state: NodeState
  endpointProfile: EndpointProfile
  /** internal: lowercase hex SHA-256 of the full token; null when revoked */
  tokenHash: string | null
  tokenPrefix?: string | null
  tokenRotatedAt: Date | null
  pool: string
  labels: Record<string, string>
  maxWorkers: number | null
  cordoned: boolean
  instance: { id: string; version: string; startedAt: Date; lastSeenAt: Date } | null
  info: {
    version: string
    hostname: string
    os: string
    arch: string
    kernel: string
    dockerVersion: string
    cpus: number
    memoryBytes: number
    diskFreeBytes: number
    dindMode: DindMode
    maxWorkers: number
    egressDenyApplied: boolean
    clockOffsetMs?: number
  } | null
  assignmentsRev: number
  lastSeenAt: Date | null
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

// ── credentials, uploads (§4.9, §4.10) ──────────────────────────────────────

export interface CredentialDoc {
  _id: string
  userId: string
  kind: CredentialKind
  name: string
  host: string
  username: string
  /** internal: AES-256-GCM `enc:v1:…` (HKDF label `credentials`, AAD `credentials:<_id>:secretEnc`) */
  secretEnc: string
  last4: string
  lastUsedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface UploadDoc {
  _id: string
  userId: string
  kind: UploadKind
  name: string
  contentType: string
  bytes: number
  sha256: string
  lines: number
  /** internal: `uploads/<userId>/<sha256>` */
  key: string
  lastUsedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

// ── events (§4.11) ──────────────────────────────────────────────────────────

export interface EventDoc {
  _id: string
  at: Date
  type: string
  level: EventLevel
  userId: string | null
  scanId?: string
  taskId?: string
  revisionId?: string
  workerId?: string
  nodeId?: string
  message: string
  data?: Record<string, unknown>
}

// ── jobs (§4.12) ────────────────────────────────────────────────────────────

export interface JobDoc {
  _id: string
  kind: JobKind
  userId: string | null
  subject: { kind: JobSubjectKind; id: string }
  state: JobState
  /** true while queued or running (partial unique index: one active job per kind and subject) */
  active: boolean
  params: Record<string, unknown>
  cursor: Record<string, unknown>
  progress: { done: number; total: number | null }
  attempts: number
  maxAttempts: number
  lease: { owner: string; expiresAt: Date } | null
  notBefore: Date
  error: { code: string; message: string } | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  updatedAt: Date
  expiresAt?: Date
}

// ── locks (§4.13) ───────────────────────────────────────────────────────────

export type LockName = 'reconciler' | 'gc' | 'bootSweep' | 'migrations' | 'registryGc'

export interface LockDoc {
  _id: LockName | (string & {})
  owner: string
  acquiredAt: Date
  expiresAt: Date
}

// ── exports (§4.14) ─────────────────────────────────────────────────────────

export interface ExportDoc {
  _id: string
  userId: string
  scanId: string
  format: ExportFormat
  filter: Record<string, unknown>
  fields: string[] | null
  afterSeq: number | null
  state: ExportState
  /** internal: `exports/<userId>/<exportId>.<format>` */
  key: string
  bytes: number
  rows: number
  error: { code: string; message: string } | null
  jobId: string
  createdAt: Date
  finishedAt: Date | null
  updatedAt: Date
  expiresAt: Date
}

// ── editors, meta (§4.15, §4.16) ────────────────────────────────────────────

export interface EditorDoc {
  /** the user id */
  _id: string
  state: EditorState
  containerId: string | null
  containerName: string | null
  image: string
  /** internal */
  apiKeyId: string | null
  /** internal */
  apiKeyExpiresAt: Date | null
  startedAt: Date | null
  lastActivityAt: Date | null
  stoppedAt: Date | null
  updatedAt: Date
  error: string | null
}

export interface MetaDoc {
  _id: 'schema' | (string & {})
  version: number
  updatedAt: Date
}

// ── better-auth collections read directly for listings (docs/data-model.md §3) ──

export interface AuthUserDoc {
  _id: string
  name: string
  email: string
  emailVerified: boolean
  image?: string | null
  role?: string | null
  banned?: boolean | null
  banReason?: string | null
  banExpires?: Date | null
  canRunPrivileged?: boolean | null
  maxWorkers?: number | null
  createdAt: Date
  updatedAt: Date
}

export interface AuthApiKeyDoc {
  _id: string
  configId: string
  name: string | null
  start: string | null
  prefix: string | null
  key: string
  referenceId: string
  enabled: boolean
  expiresAt: Date | null
  lastRequest: Date | null
  createdAt: Date
  updatedAt: Date
}
