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
  ScriptOutputState,
  ScriptRunErrorType,
  ScriptRunLogStream,
  ScriptRunState,
  ScriptSourceKind,
  Severity,
  TaskSourceKind,
  TestRunAnalysisStatus,
  TestRunState,
  UploadKind,
  WorkerRole,
  WorkerState,
} from '#shared/utils/enums'
import type { NotificationTrigger } from '#shared/utils/notifications'

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
    /** schedulers: the publish counters of the latest state poll (missing before the first one) */
    scheduler?: { published: number; confirmed: number; nacked: number; backpressure: boolean } | null
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
  scriptId?: string
  scriptRunId?: string
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

export type LockName = 'reconciler' | 'gc' | 'bootSweep' | 'migrations' | 'registryGc' | 'scriptsGc'

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

// ── scripts, scriptRuns, scriptRunLogs (docs/scripts.md) ───────────────────

/** The JSON Schemas a script run reported for the script's code of one pack (`scriptRuntimeDescribe`). */
export interface ScriptDescribeDoc {
  packSha256: string
  configSchema: Record<string, unknown> | null
  resultSchema: Record<string, unknown> | null
  at: Date
}

export interface ScriptRunPointerDoc {
  id: string
  state: ScriptRunState
  createdAt: Date
  finishedAt: Date | null
}

export interface ScriptDoc {
  _id: string
  userId: string
  name: string
  language: string
  description: string | null
  source: { kind: ScriptSourceKind }
  workspace: {
    packSha256: string | null
    fileCount: number
    bytes: number
    checkedAt: Date | null
    lastSyncSha256: string | null
  }
  describe: ScriptDescribeDoc | null
  latestRun: ScriptRunPointerDoc | null
  deletingAt?: Date | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Settings of a script run. Until the build merged them (explicit > manifest defaults > SCANTOR_SCRIPT_RUN_TIMEOUT),
 * `timeoutMs` and the resources hold the explicit request only; null = not given.
 */
export interface ScriptRunSettingsDoc {
  timeoutMs: number | null
  resources: { cpus: number | null; memoryMiB: number | null }
  /** at most this many analyses per stream (a sample run); null = all */
  limit: number | null
}

export interface ScriptRunErrorDoc {
  type: ScriptRunErrorType
  message: string
  stack?: string
}

export interface ScriptRunOutputDoc {
  id: string
  name: string
  /** internal: `script-runs/<runId>/outputs/<outputId>/<safeName>` */
  key: string
  contentType: string
  state: ScriptOutputState
  /** internal: the S3 multipart upload while `pending` */
  uploadId: string | null
  /** internal: bytes reserved by part presigns while `pending` (storage quota) */
  reservedBytes: number
  size: number | null
  sha256: string | null
  createdAt: Date
  storedAt: Date | null
}

export interface ScriptRunLogStateDoc {
  /** stored lines, including those later dropped by the retention */
  lines: number
  bytes: number
  /** the first retained line number (the retention keeps the head chunks and the tail; docs/scripts.md) */
  firstLine: number
  /** lines dropped by the retention or the ingestion rate limit */
  droppedLines: number
  /** the chunk the next line goes into (the open chunk: stored with fewer than 500 lines, rewritten while it fills) */
  nextChunk: number
  /** resume position of the log follower after an adoption: the last stored line's timestamp */
  cursor: { ts: string; countAtTs: number } | null
}

export interface ScriptRunDoc {
  _id: string
  /** always the script's owner */
  userId: string
  scriptId: string
  scriptName: string
  /** 1–20 scans of the owner, in request order */
  scanIds: string[]
  state: ScriptRunState
  input: { config: Record<string, unknown>; settings: ScriptRunSettingsDoc }
  /** internal: the secret values, sealed (HKDF label `config-secrets`, AAD `scriptRuns:<id>:secrets`) */
  secrets: { names: string[]; enc: string } | null
  source: {
    /** internal: `script-runs/<id>/source.tar.gz` */
    key: string
    packSha256: string
    packBytes: number
    fileCount: number
  }
  restartedFrom: { id: string; resume: boolean } | null
  image: { ref: string; id: string; cached: boolean } | null
  entry: string | null
  container: { id: string; name: string; createdAt: Date } | null
  /**
   * A cancel of a `running` run, until its job stopped the container (60 s SIGTERM grace, the run token still works)
   * and wrote `cancelled`; the representation already reports `cancelled` and the request's `error`.
   */
  cancelRequest?: { at: Date; reason: string | null } | null
  errors: BuildErrorDoc[]
  error: ScriptRunErrorDoc | null
  exitCode: number | null
  progress: { done: number; total: number | null; message: string | null; updatedAt: Date } | null
  /** `bytes`: the serialized size of `state` (at most 1 MiB) */
  checkpoint: { state: unknown; savedAt: Date; bytes: number } | null
  result: unknown
  outputs: ScriptRunOutputDoc[]
  log: ScriptRunLogStateDoc
  jobId: string
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  updatedAt: Date
  /** finishedAt + SCANTOR_SCRIPT_RUN_RETENTION_DAYS; null while active or when runs are kept forever */
  expiresAt: Date | null
}

export interface ScriptRunLogLineDoc {
  at: Date
  stream: ScriptRunLogStream
  /** at most 16 KiB, redacted */
  text: string
}

export interface ScriptRunLogChunkDoc {
  /** `<scriptRunId>-<chunk>` */
  _id: string
  scriptRunId: string
  chunk: number
  firstLine: number
  lines: ScriptRunLogLineDoc[]
  bytes: number
  /** the chunk holds the retention marker line (set only then) */
  retentionMarker?: true
}

// ── notificationSettings (§4.17) ───────────────────────────────────────────

export interface NotificationDeliveryDoc {
  at: Date
  ok: boolean
  status: number | null
  message: string | null
}

export interface NtfyChannelDoc {
  enabled: boolean
  topic: string | null
  /** internal; the access token, encrypted (HKDF label `credentials`, AAD `notificationSettings:<userId>:/ntfy/token`) */
  tokenEnc: string | null
  triggers: NotificationTrigger[]
  lastDelivery: NotificationDeliveryDoc | null
}

export interface NotificationSettingsDoc {
  /** the user id */
  _id: string
  ntfy: NtfyChannelDoc | null
  createdAt: Date
  updatedAt: Date
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
