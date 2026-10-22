import { randomUUID } from 'node:crypto'
import type { RevisionSourceKind } from '#shared/utils/enums'
import type { RevisionDoc, TaskDoc } from '../../types/documents'
import { cancelActiveJobs, createJob } from '../../utils/jobs'
import { useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { discardTmpSnapshot, promoteSnapshot, snapshotToTmp, type StoredSnapshot } from '../pipeline/snapshot'
import { allocateRevisionNumber, applyWorkspaceSummary, setLatestRevision } from '../tasks/store'

// Publishing (docs/tasks.md §10, docs/architecture.md §11.1 step 6): the request snapshots the workspace into S3
// synchronously, de-duplicates against queued/building/ready revisions with the same pack hash, stores the snapshot
// content-addressed per task, allocates the next number and inserts the revision `queued` with its `revisionBuild`
// job, which builds that stored snapshot, never the live workspace.

export const DEDUPLICATING_STATES = ['queued', 'building', 'ready'] as const

export interface PublishOptions {
  message?: string
  /** `uploadTask` publishes with kind `upload` (docs/tasks.md §10 provenance) */
  viaUpload?: boolean
}

export interface PublishOutcome {
  revision: RevisionDoc
  /** false when an existing revision with the same pack hash was returned */
  created: boolean
}

export function buildLogKey(revisionId: string): string {
  return `build-logs/${revisionId}.ndjson`
}

/** Provenance of a new revision (docs/tasks.md §10). */
export function revisionSource(task: Pick<TaskDoc, 'source'>, snapshot: Pick<StoredSnapshot, 'packSha256' | 'packBytes' | 'fileCount'>, viaUpload: boolean): RevisionDoc['source'] {
  const git = task.source.git
  let kind: RevisionSourceKind = 'workspace'
  if (viaUpload) kind = 'upload'
  else if (git && git.packSha256 === snapshot.packSha256) kind = 'git'
  return {
    kind,
    packSha256: snapshot.packSha256,
    packBytes: snapshot.packBytes,
    fileCount: snapshot.fileCount,
    ...(git ? { git: { url: git.url, ref: git.ref, path: git.path, commit: git.commit, dirty: snapshot.packSha256 !== git.packSha256 } } : {}),
  }
}

async function findDuplicate(taskId: string, packSha256: string): Promise<RevisionDoc | null> {
  return useCollections().revisions.findOne(
    { taskId, 'source.packSha256': packSha256, state: { $in: [...DEDUPLICATING_STATES] } },
    { sort: { number: -1 } },
  )
}

/** Publishes the current workspace of a task as a new revision (or returns the existing one for the same content). */
export async function publishRevision(task: TaskDoc, options: PublishOptions = {}): Promise<PublishOutcome> {
  const log = useLogger('revisions')
  const snapshot = await snapshotToTmp(task.userId, task.name)
  await applyWorkspaceSummary(task._id, snapshot)

  const duplicate = await findDuplicate(task._id, snapshot.packSha256)
  if (duplicate) {
    await discardTmpSnapshot(snapshot)
    return { revision: duplicate, created: false }
  }

  const snapshotKey = await promoteSnapshot(snapshot, task._id)
  const number = await allocateRevisionNumber(task._id)
  const revisionId = randomUUID()
  // The job exists before the revision so the document never lacks its jobId; the handler waits for the insert.
  const { job } = await createJob({
    kind: 'revisionBuild',
    userId: task.userId,
    subject: { kind: 'revision', id: revisionId },
    params: { revisionId },
  })
  const now = new Date()
  const revision: RevisionDoc = {
    _id: revisionId,
    userId: task.userId,
    taskId: task._id,
    taskName: task.name,
    number,
    state: 'queued',
    message: options.message ?? null,
    source: revisionSource(task, snapshot, options.viaUpload === true),
    snapshotKey,
    manifest: null,
    language: null,
    baseImage: null,
    image: null,
    description: null,
    settingsDefaults: null,
    privileged: false,
    buildLogKey: buildLogKey(revisionId),
    errors: [],
    jobId: job._id,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
  }
  try {
    await useCollections().revisions.insertOne(revision)
  } catch (error) {
    await cancelActiveJobs('revisionBuild', revisionId).catch((cancelError: unknown) =>
      log.error('cancelling the build job of a failed publish failed', { revisionId, err: cancelError }),
    )
    throw error
  }
  await setLatestRevision(task._id, revision)
  log.info('revision published', { taskId: task._id, revisionId, number, packSha256: snapshot.packSha256 })
  return { revision, created: true }
}
