import { randomUUID } from 'node:crypto'
import type { TaskSourceKind } from '#shared/utils/enums'
import type { GitSourceDoc, RevisionPointerDoc, RevisionDoc, TaskDoc } from '../../types/documents'
import { apiError } from '../../utils/errors'
import { useCollections } from '../../utils/mongo'
import type { WorkspaceSummary } from '../helpers/types'

// Persistence of `tasks` (docs/data-model.md §4.1): creation with the unique (userId, name) index, the workspace
// cache every helper summary refreshes, and the revision pointers.

export interface NewTaskInput {
  userId: string
  name: string
  language: string
  description?: string | null
  source: { kind: TaskSourceKind; template?: string; git?: GitSourceDoc }
}

export function newTaskDoc(input: NewTaskInput, now = new Date()): TaskDoc {
  return {
    _id: randomUUID(),
    userId: input.userId,
    name: input.name,
    language: input.language,
    description: input.description ?? null,
    source: input.source,
    workspace: { packSha256: null, fileCount: 0, bytes: 0, checkedAt: null, lastSyncSha256: null },
    revisionSeq: 0,
    latestRevision: null,
    latestReadyRevision: null,
    privileged: false,
    deletingAt: null,
    createdAt: now,
    updatedAt: now,
  }
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000
}

/** Inserts a task; a taken name (also of a task being deleted) is 409 alreadyExists. */
export async function insertTask(doc: TaskDoc): Promise<TaskDoc> {
  try {
    await useCollections().tasks.insertOne(doc)
    return doc
  } catch (error) {
    if (isDuplicateKey(error)) throw apiError('alreadyExists', `a task named ${doc.name} already exists`)
    throw error
  }
}

/** The caller's task by name, including tasks being deleted (callers decide how to treat those). */
export async function findTaskByName(userId: string, name: string): Promise<TaskDoc | null> {
  return useCollections().tasks.findOne({ userId, name })
}

export async function loadTask(taskId: string): Promise<TaskDoc | null> {
  return useCollections().tasks.findOne({ _id: taskId })
}

/**
 * Copies a helper summary into the workspace cache (null = the task folder does not exist). Upload, git import and
 * git pull also set `lastSyncSha256`; editor and file-route writes never do.
 */
export async function applyWorkspaceSummary(
  taskId: string,
  summary: WorkspaceSummary | null,
  options: { lastSyncSha256?: string | null; extra?: Record<string, unknown> } = {},
): Promise<TaskDoc | null> {
  const now = new Date()
  const set: Record<string, unknown> = {
    'workspace.packSha256': summary?.packSha256 ?? null,
    'workspace.fileCount': summary?.fileCount ?? 0,
    'workspace.bytes': summary?.bytes ?? 0,
    'workspace.checkedAt': now,
    updatedAt: now,
    ...options.extra,
  }
  if (options.lastSyncSha256 !== undefined) set['workspace.lastSyncSha256'] = options.lastSyncSha256
  return useCollections().tasks.findOneAndUpdate({ _id: taskId }, { $set: set }, { returnDocument: 'after' })
}

export function revisionPointer(revision: Pick<RevisionDoc, '_id' | 'number' | 'state' | 'source' | 'createdAt'>): RevisionPointerDoc {
  return { id: revision._id, number: revision.number, state: revision.state, packSha256: revision.source.packSha256, createdAt: revision.createdAt }
}

/** Allocates the next revision number atomically (`$inc` on `revisionSeq`); numbers are never reused. */
export async function allocateRevisionNumber(taskId: string): Promise<number> {
  const task = await useCollections().tasks.findOneAndUpdate(
    { _id: taskId, deletingAt: null },
    { $inc: { revisionSeq: 1 }, $set: { updatedAt: new Date() } },
    { returnDocument: 'after', projection: { revisionSeq: 1 } },
  )
  if (!task) throw apiError('notFound', 'task not found')
  return task.revisionSeq
}

/** Points `latestRevision` at a revision unless a higher-numbered one is already there. */
export async function setLatestRevision(taskId: string, revision: RevisionDoc): Promise<void> {
  await useCollections().tasks.updateOne(
    { _id: taskId, $or: [{ latestRevision: null }, { 'latestRevision.number': { $lte: revision.number } }] },
    { $set: { latestRevision: revisionPointer(revision), updatedAt: new Date() } },
  )
}

/**
 * Records the final state of a revision on its task: the `latestRevision` pointer's state, and for a ready revision
 * `latestReadyRevision`, `privileged`, and the language and description of the manifest of every successful publish.
 */
export async function recordRevisionOutcome(revision: RevisionDoc): Promise<void> {
  const { tasks } = useCollections()
  const now = new Date()
  await tasks.updateOne(
    { _id: revision.taskId, 'latestRevision.id': revision._id },
    { $set: { 'latestRevision.state': revision.state, updatedAt: now } },
  )
  if (revision.state !== 'ready') return
  const manifest = revision.manifest ?? {}
  const set: Record<string, unknown> = {
    latestReadyRevision: revisionPointer(revision),
    privileged: revision.settingsDefaults?.privileged ?? revision.privileged,
    updatedAt: now,
  }
  if (typeof revision.language === 'string') set.language = revision.language
  if (typeof manifest.description === 'string') set.description = manifest.description
  else set.description = null
  await tasks.updateOne(
    { _id: revision.taskId, $or: [{ latestReadyRevision: null }, { 'latestReadyRevision.number': { $lte: revision.number } }] },
    { $set: set },
  )
}
