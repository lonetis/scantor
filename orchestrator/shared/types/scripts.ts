import type { ScriptRunErrorType, ScriptRunLogStream, ScriptRunState, ScriptSourceKind } from '../utils/enums'
import type { BuildError, IsoDate, JobAccepted } from './common'
import type { TaskFileContent, TaskFileList } from './tasks'

// Script and script-run representations (docs/api.md, tags `scripts`, `script-files`, `script-runs`; docs/scripts.md,
// docs/data-model.md). Internal fields of the documents (S3 keys, sealed secrets, upload ids, the log bookkeeping,
// container and image ids) never appear here.

// ── scripts ─────────────────────────────────────────────────────────────────

export interface ScriptSource {
  kind: ScriptSourceKind
}

/** Cached workspace status of the script folder (scripts have no revisions, so nothing is "dirty"). */
export interface ScriptWorkspace {
  packSha256: string | null
  fileCount: number
  bytes: number
  checkedAt: IsoDate | null
}

/**
 * The JSON Schemas the script's code reported for the pack `packSha256` (its config model and result model). The
 * run form uses the config schema while it matches the folder (`describe.packSha256 === workspace.packSha256`).
 */
export interface ScriptDescribe {
  packSha256: string
  configSchema: Record<string, unknown> | null
  resultSchema: Record<string, unknown> | null
  at: IsoDate
}

export interface ScriptRunPointer {
  id: string
  state: ScriptRunState
  createdAt: IsoDate
  finishedAt: IsoDate | null
}

export interface ScriptRunProgress {
  done: number
  total: number | null
  message: string | null
  updatedAt: IsoDate
}

export interface ScriptRunSummary extends ScriptRunPointer {
  progress: ScriptRunProgress | null
}

export interface Script {
  id: string
  userId: string
  name: string
  language: string
  description: string | null
  source: ScriptSource
  workspace: ScriptWorkspace
  describe: ScriptDescribe | null
  latestRun: ScriptRunPointer | null
  /** The newest runs (at most 10), newest first; present on getScript and createScript. */
  recentRuns?: ScriptRunSummary[]
  createdAt: IsoDate
  updatedAt: IsoDate
}

export interface UploadScriptResult {
  script: Script
  created: boolean
}

/** `deleteScript`: 202 with the `scriptDelete` job. */
export type DeleteScriptResult = JobAccepted

// ── script files ────────────────────────────────────────────────────────────

export type ScriptFileList = TaskFileList
export type ScriptFileContent = TaskFileContent

export interface ScriptWorkspaceChange {
  packSha256: string
}

export interface WriteScriptFilesResult {
  written: string[]
  workspace: ScriptWorkspaceChange
}

export interface DeleteScriptFileResult {
  deleted: string[]
  workspace: ScriptWorkspaceChange
}

// ── script runs ─────────────────────────────────────────────────────────────

/** The effective settings once the run was built; before that, the explicit values (null = not given). */
export interface ScriptRunSettings {
  timeoutMs: number | null
  resources: { cpus: number | null; memoryMiB: number | null }
  /** analyses per stream of a sample run; null = all */
  limit: number | null
}

export interface ScriptRunInput {
  config: Record<string, unknown>
  settings: ScriptRunSettings
}

export interface ScriptRunScan {
  id: string
  name: string | null
}

export interface ScriptRunSource {
  packSha256: string
  packBytes: number
  fileCount: number
}

export interface ScriptRunError {
  type: ScriptRunErrorType
  message: string
  stack?: string
}

/** A stored output file of a run (pending uploads are not listed). */
export interface ScriptRunOutput {
  id: string
  name: string
  size: number
  sha256: string
  contentType: string
  createdAt: IsoDate
}

export interface ScriptRunLogLine {
  /** numbered from 1 in the order the lines were stored */
  line: number
  at: IsoDate
  stream: ScriptRunLogStream
  text: string
}

export interface ScriptRunLogState {
  lines: number
  firstLine: number
  droppedLines: number
}

export interface ScriptRun {
  id: string
  userId: string
  scriptId: string
  scriptName: string
  scans: ScriptRunScan[]
  state: ScriptRunState
  input: ScriptRunInput
  /** the names of the secrets the run received (never their values) */
  secrets: string[]
  source: ScriptRunSource
  restartedFrom: { id: string; resume: boolean } | null
  image: { ref: string; cached: boolean } | null
  errors: BuildError[]
  error: ScriptRunError | null
  exitCode: number | null
  progress: ScriptRunProgress | null
  checkpoint: { savedAt: IsoDate; bytes: number } | null
  result: unknown
  outputs: ScriptRunOutput[]
  log: ScriptRunLogState
  /** The last lines of the log (at most 50 lines, 16 KiB); present on getScriptRun and the other single-run responses. */
  logTail?: ScriptRunLogLine[]
  createdAt: IsoDate
  startedAt: IsoDate | null
  finishedAt: IsoDate | null
  updatedAt: IsoDate
  expiresAt: IsoDate | null
}

/** `getScriptRunLogs`: one page of the log after `afterLine`. */
export interface ScriptRunLogsPage {
  lines: ScriptRunLogLine[]
  /** the first retained line (lines dropped by the retention are gone) */
  firstLine: number
  /** pass as `afterLine` to continue */
  nextLine: number
  /** true when the run is terminal and no line follows */
  complete: boolean
}

/** `details` of `confirmationRequired` from startScriptRun and restartScriptRun without `settings.limit`. */
export interface ScriptRunConfirmationDetails {
  scans: { id: string; name: string | null; analyses: number }[]
  packSha256: string
}
