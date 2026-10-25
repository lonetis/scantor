import type { Readable, Writable } from 'node:stream'

// Workspace helper operations (docs/editor.md §9.4) and the shapes of their stdout documents.

export const HELPER_OPS = [
  'init',
  'purge',
  'list',
  'read',
  'write-files',
  'delete-files',
  'scaffold',
  'extract',
  'git-clone',
  'git-pull',
  'commit',
  'discard',
  'snapshot',
] as const
export type HelperOp = (typeof HELPER_OPS)[number]

/** Operations that hold the user's exclusive lock; every other operation holds it shared (docs/editor.md §9.8). */
export const EXCLUSIVE_OPS: ReadonlySet<HelperOp> = new Set(['write-files', 'delete-files', 'commit', 'scaffold', 'init', 'purge'])

/** Operations that run as root on the whole volumes and create or remove one user's directories. */
export const VOLUME_ADMIN_OPS: ReadonlySet<HelperOp> = new Set(['init', 'purge'])

/** Operations that run on `scantor-egress` instead of network `none`. */
export const GIT_OPS: ReadonlySet<HelperOp> = new Set(['git-clone', 'git-pull'])

export type HelperNetwork = 'none' | 'egress'

/** Which volume a helper mounts: the user's workspace subpath, nothing (`--archive`), or both whole volumes. */
export type HelperMount = 'user' | 'none' | 'volumes'

export interface HelperRunOptions {
  userId: string
  /** arguments after `scantor workspace <op>` */
  args?: string[]
  /** operation input (closed at once when absent) */
  stdin?: Readable | Buffer
  network?: HelperNetwork
  /** extra container environment (git credentials, SCANTOR_CA_CERT); never logged */
  env?: Record<string, string>
  /** gives up waiting for a slot and kills a running helper when it aborts (rejecting with its reason) */
  signal?: AbortSignal
}

export interface HelperResult {
  stdout: Buffer
  stderr: string
  exitCode: number
}

/** Where stdout goes for operations that stream their output (`snapshot` without `--hash-only`). */
export interface HelperStreamOptions {
  stdout: Writable
}

/** `{packSha256, fileCount, bytes}` of a task folder, computed by the same pack code as `scantor task pack`. */
export interface WorkspaceSummary {
  packSha256: string
  fileCount: number
  bytes: number
}

/** The final stderr event of `snapshot`. */
export interface SnapshotSummary extends WorkspaceSummary {
  packBytes: number
}

export interface HelperErrorPayload {
  code: string
  message: string
  path?: string
  details?: Record<string, unknown>
}

export interface FileEntry {
  path: string
  type: 'file' | 'dir' | 'symlink'
  size: number
  mode: number
}

export interface ListOutput {
  entries: FileEntry[]
  truncated: boolean
}

export interface ReadOutput {
  path: string
  size: number
  sha256: string
  encoding: 'utf8' | 'base64'
  content: string
  truncated: boolean
}

export interface WriteFilesOutput {
  written: string[]
  workspace: WorkspaceSummary
}

export interface DeleteFilesOutput {
  deleted: string[]
  workspace: WorkspaceSummary | null
}

export interface ExtractOutput {
  staging: string
  manifest: Record<string, unknown> & { name: string; language: string; description?: string }
  summary: WorkspaceSummary
}

/** A BuildError-shaped validation error reported for a candidate manifest. */
export interface CandidateError {
  phase?: string
  file?: string
  line?: number
  column?: number
  message: string
}

export interface GitCandidate {
  path: string
  name: string
  language: string
  valid: boolean
  errors: CandidateError[]
  /** the first problem that is not about the manifest (an archive rule or cap), as a helper error; null otherwise */
  rejection: HelperErrorPayload | null
  summary: WorkspaceSummary | null
}

export interface GitCloneOutput {
  commit: string
  candidates: GitCandidate[]
}

export interface GitPullOutput {
  commit: string
  previousCommit: string
  fastForward: boolean
  changed: boolean
  candidate: GitCandidate
  current: WorkspaceSummary | null
}

export interface CommitOutput {
  task: string
  changed: boolean
  previousPackSha256: string | null
  workspace: WorkspaceSummary
}

/** `--expect` of `commit`: the current workspace hash the caller decided on, `absent` or `any`. */
export type CommitExpectation = string
