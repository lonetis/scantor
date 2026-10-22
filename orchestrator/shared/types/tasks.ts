import type { RevisionState, TaskSourceKind } from '../utils/enums'
import type { IsoDate } from './common'
import type { Revision } from './revisions'

// Task representations (docs/api.md §2, §4.6–§4.8; docs/data-model.md §4.1).

export interface GitSource {
  url: string
  ref: string
  path: string
  credentialId?: string | null
  commit: string
  packSha256: string
  pulledAt: IsoDate
}

export interface TaskSource {
  kind: TaskSourceKind
  template?: string
  git?: GitSource
}

/** Cached workspace status; `dirty` = workspace pack hash differs from `latestRevision.packSha256`. */
export interface TaskWorkspace {
  packSha256: string | null
  fileCount: number
  bytes: number
  dirty: boolean
  lastSyncSha256: string | null
  checkedAt: IsoDate | null
}

export interface RevisionPointer {
  id: string
  number: number
  state: RevisionState
  packSha256: string
  createdAt: IsoDate
}

export interface Task {
  id: string
  userId: string
  name: string
  language: string
  description?: string | null
  source: TaskSource
  workspace: TaskWorkspace
  revisionCount: number
  latestRevision: RevisionPointer | null
  latestReadyRevision: RevisionPointer | null
  privileged: boolean
  createdAt: IsoDate
  updatedAt: IsoDate
}

/** `getTaskWorkspace`: computed fresh by a workspace helper. */
export interface TaskWorkspaceStatus {
  packSha256: string
  fileCount: number
  bytes: number
  dirty: boolean
  latestRevisionPackSha256: string | null
  lastSyncSha256: string | null
  checkedAt: IsoDate
}

export interface TaskFileEntry {
  path: string
  type: 'file' | 'dir' | 'symlink'
  size: number
  mode: number
}

export interface TaskFileList {
  entries: TaskFileEntry[]
  truncated: boolean
}

export interface TaskFileContent {
  path: string
  size: number
  sha256: string
  encoding: 'utf8' | 'base64'
  content: string
  truncated: boolean
}

export interface WorkspaceChange {
  packSha256: string
  dirty: boolean
}

export interface WriteTaskFilesResult {
  written: string[]
  workspace: WorkspaceChange
}

export interface DeleteTaskFileResult {
  deleted: string[]
  workspace: WorkspaceChange
}

export interface UploadTaskResult {
  task: Task
  revision: Revision | null
  created: boolean
}

export interface GitImportCandidate {
  path: string
  name: string
  language: string
  exists: boolean
}

export interface ImportGitResult {
  imported: Task[]
  candidates: GitImportCandidate[]
}

export interface PullGitResult {
  task: Task
  previousCommit: string
  commit: string
  changed: boolean
}
