import type { RevisionPointer, Task, TaskWorkspaceStatus } from '#shared/types/tasks'
import type { RevisionPointerDoc, TaskDoc } from '../../types/documents'
import { isoDate, isoDateOrNull } from '../../utils/serialize'
import type { WorkspaceSummary } from '../helpers/types'

// Task representations (docs/api.md §2 `Task`): `workspace.dirty` = workspace pack hash differs from
// `latestRevision.packSha256` (true without revisions); `revisionCount` = `revisionSeq`; `revisionSeq` and
// `deletingAt` are internal.

export function isWorkspaceDirty(task: Pick<TaskDoc, 'workspace' | 'latestRevision'>): boolean {
  if (!task.latestRevision) return true
  return task.workspace.packSha256 !== task.latestRevision.packSha256
}

/** `dirty` for a freshly computed summary (null = the task folder does not exist). */
export function isDirtyAgainst(packSha256: string | null, task: Pick<TaskDoc, 'latestRevision'>): boolean {
  return !task.latestRevision || packSha256 !== task.latestRevision.packSha256
}

function toPointer(pointer: RevisionPointerDoc | null): RevisionPointer | null {
  if (!pointer) return null
  return { id: pointer.id, number: pointer.number, state: pointer.state, packSha256: pointer.packSha256, createdAt: isoDate(pointer.createdAt) }
}

export function toApiTask(doc: TaskDoc): Task {
  const git = doc.source.git
  return {
    id: doc._id,
    userId: doc.userId,
    name: doc.name,
    language: doc.language,
    description: doc.description ?? null,
    source: {
      kind: doc.source.kind,
      ...(doc.source.template !== undefined ? { template: doc.source.template } : {}),
      ...(git
        ? {
            git: {
              url: git.url,
              ref: git.ref,
              path: git.path,
              credentialId: git.credentialId ?? null,
              commit: git.commit,
              packSha256: git.packSha256,
              pulledAt: isoDate(git.pulledAt),
            },
          }
        : {}),
    },
    workspace: {
      packSha256: doc.workspace.packSha256,
      fileCount: doc.workspace.fileCount,
      bytes: doc.workspace.bytes,
      dirty: isWorkspaceDirty(doc),
      lastSyncSha256: doc.workspace.lastSyncSha256,
      checkedAt: isoDateOrNull(doc.workspace.checkedAt),
    },
    revisionCount: doc.revisionSeq,
    latestRevision: toPointer(doc.latestRevision),
    latestReadyRevision: toPointer(doc.latestReadyRevision),
    privileged: doc.privileged,
    createdAt: isoDate(doc.createdAt),
    updatedAt: isoDate(doc.updatedAt),
  }
}

export function toWorkspaceStatus(task: TaskDoc, summary: WorkspaceSummary, checkedAt: Date): TaskWorkspaceStatus {
  return {
    packSha256: summary.packSha256,
    fileCount: summary.fileCount,
    bytes: summary.bytes,
    dirty: isDirtyAgainst(summary.packSha256, task),
    latestRevisionPackSha256: task.latestRevision?.packSha256 ?? null,
    lastSyncSha256: task.workspace.lastSyncSha256,
    checkedAt: isoDate(checkedAt),
  }
}
