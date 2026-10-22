// Enum value lists shared by server, UI and tests (docs/data-model.md, docs/api.md). Every list is the single
// source of its values; types are derived from the lists so that adding a value is a one-line change.

export const SCAN_STATES = ['creating', 'running', 'paused', 'completed', 'failed', 'cancelled', 'deleting', 'deleted'] as const
export type ScanState = (typeof SCAN_STATES)[number]
export const TERMINAL_SCAN_STATES = ['completed', 'failed', 'cancelled'] as const satisfies readonly ScanState[]
export const ACTIVE_SCAN_STATES = ['creating', 'running', 'paused'] as const satisfies readonly ScanState[]

export const SCHEDULING_STATES = ['pending', 'running', 'done', 'retrying', 'failed'] as const
export type SchedulingState = (typeof SCHEDULING_STATES)[number]

export const STATE_REASON_CODES = ['user', 'failureRate', 'schedulingFailed', 'completed', 'stalled', 'revisionUnavailable'] as const
export type StateReasonCode = (typeof STATE_REASON_CODES)[number]

export const ANALYSIS_STATUSES = ['pending', 'retrying', 'succeeded', 'failed', 'lost', 'cancelled'] as const
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number]
export const TERMINAL_ANALYSIS_STATUSES = ['succeeded', 'failed', 'lost', 'cancelled'] as const satisfies readonly AnalysisStatus[]

export const TEST_RUN_ANALYSIS_STATUSES = ['succeeded', 'failed'] as const
export type TestRunAnalysisStatus = (typeof TEST_RUN_ANALYSIS_STATUSES)[number]

export const REVISION_STATES = ['queued', 'building', 'ready', 'failed'] as const
export type RevisionState = (typeof REVISION_STATES)[number]

export const TEST_RUN_STATES = ['queued', 'building', 'running', 'completed', 'failed', 'cancelled'] as const
export type TestRunState = (typeof TEST_RUN_STATES)[number]
export const TERMINAL_TEST_RUN_STATES = ['completed', 'failed', 'cancelled'] as const satisfies readonly TestRunState[]

export const WORKER_STATES = ['pending', 'assigned', 'pulling', 'starting', 'running', 'backoff', 'draining', 'stopped', 'lost'] as const
export type WorkerState = (typeof WORKER_STATES)[number]
/** Active states count against node capacity and the user's maxWorkers; the worker token is valid only in them. */
export const ACTIVE_WORKER_STATES = ['assigned', 'pulling', 'starting', 'running', 'backoff', 'draining'] as const satisfies readonly WorkerState[]
export const TERMINAL_WORKER_STATES = ['stopped', 'lost'] as const satisfies readonly WorkerState[]

export const WORKER_ROLES = ['scheduler', 'runner'] as const
export type WorkerRole = (typeof WORKER_ROLES)[number]

export const NODE_STATES = ['pending', 'online', 'offline', 'revoked'] as const
export type NodeState = (typeof NODE_STATES)[number]

export const ENDPOINT_PROFILES = ['internal', 'public'] as const
export type EndpointProfile = (typeof ENDPOINT_PROFILES)[number]

export const DIND_MODES = ['disabled', 'sysbox', 'privileged'] as const
export type DindMode = (typeof DIND_MODES)[number]

export const JOB_KINDS = ['revisionBuild', 'testRun', 'scanDelete', 'scanRetryFailed', 'export', 'taskDelete', 'userPurge'] as const
export type JobKind = (typeof JOB_KINDS)[number]

export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const
export type JobState = (typeof JOB_STATES)[number]
export const TERMINAL_JOB_STATES = ['succeeded', 'failed', 'cancelled'] as const satisfies readonly JobState[]

export const JOB_SUBJECT_KINDS = ['revision', 'testRun', 'scan', 'export', 'task', 'user'] as const
export type JobSubjectKind = (typeof JOB_SUBJECT_KINDS)[number]

export const EXPORT_STATES = ['queued', 'running', 'ready', 'failed'] as const
export type ExportState = (typeof EXPORT_STATES)[number]

export const EXPORT_FORMATS = ['jsonl', 'csv'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

export const EDITOR_STATES = ['starting', 'running', 'stopping', 'stopped'] as const
export type EditorState = (typeof EDITOR_STATES)[number]

export const CONDITION_TYPES = [
  'workersPending',
  'crashLoop',
  'imagePullFailed',
  'workerErrors',
  'schedulerRestarting',
  'schedulingFailed',
  'topologyFailed',
  'brokerAlarm',
  'breakerTripped',
  'stalled',
  'clockSkew',
] as const
export type ConditionType = (typeof CONDITION_TYPES)[number]

export const SEVERITIES = ['info', 'warning', 'error'] as const
export type Severity = (typeof SEVERITIES)[number]

export const EVENT_LEVELS = ['info', 'warning', 'error'] as const
export type EventLevel = (typeof EVENT_LEVELS)[number]

export const PENDING_REASONS = [
  'noNodes',
  'archMismatch',
  'selectorMismatch',
  'insufficientCapacity',
  'userMaxWorkers',
  'dindUnavailable',
  'diskLow',
  'pullLimit',
] as const
export type PendingReason = (typeof PENDING_REASONS)[number]

export const SCANTOR_ERROR_TYPES = ['taskError', 'fatal', 'retry', 'timeout', 'crash', 'validation', 'platform', 'cancelled'] as const
export type ScantorErrorType = (typeof SCANTOR_ERROR_TYPES)[number]

export const SCANTOR_ERROR_PHASES = ['bootstrap', 'schedule', 'run', 'validate', 'upload', 'publish', 'platform', 'ingest'] as const
export type ScantorErrorPhase = (typeof SCANTOR_ERROR_PHASES)[number]

/** Task-pipeline phases; test runs additionally use `config` and `schedule`. */
export const BUILD_ERROR_PHASES = ['pack', 'static', 'build', 'describe', 'check', 'push', 'platform', 'config', 'schedule'] as const
export type BuildErrorPhase = (typeof BUILD_ERROR_PHASES)[number]

export const TASK_SOURCE_KINDS = ['scaffold', 'upload', 'git'] as const
export type TaskSourceKind = (typeof TASK_SOURCE_KINDS)[number]

export const REVISION_SOURCE_KINDS = ['workspace', 'upload', 'git'] as const
export type RevisionSourceKind = (typeof REVISION_SOURCE_KINDS)[number]

export const UPLOAD_KINDS = ['list'] as const
export type UploadKind = (typeof UPLOAD_KINDS)[number]

export const CREDENTIAL_KINDS = ['gitToken'] as const
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number]

export const USER_ROLES = ['admin', 'user'] as const
export type UserRole = (typeof USER_ROLES)[number]

export const API_KEY_CONFIG_IDS = ['default', 'editor'] as const
export type ApiKeyConfigId = (typeof API_KEY_CONFIG_IDS)[number]

/** `x-scantor-scope` values (docs/api.md §1.2). */
export const OPERATION_SCOPES = ['owner', 'admin', 'public', 'node', 'worker', 'setup', 'tools'] as const
export type OperationScope = (typeof OPERATION_SCOPES)[number]

/** MCP access levels, ordered from least to most privileged (docs/mcp.md §3.2). */
export const MCP_LEVELS = ['read', 'write', 'admin'] as const
export type McpLevel = (typeof MCP_LEVELS)[number]

export const TOOL_TARGETS = ['rabbitmq', 'mongo-express', 'rustfs', 'traefik'] as const
export type ToolTarget = (typeof TOOL_TARGETS)[number]

export const ORCHESTRATOR_COMPONENTS = ['api', 'ingestor', 'reconciler'] as const
export type OrchestratorComponent = (typeof ORCHESTRATOR_COMPONENTS)[number]

export const SCHEDULE_KINDS = ['template', 'custom'] as const
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number]

export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}
