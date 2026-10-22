import type { Filter } from 'mongodb'
import type { RevisionState } from '#shared/utils/enums'
import type { Page } from '#shared/types/common'
import type { RevisionSummary } from '#shared/types/revisions'
import type { RevisionDoc, TaskDoc } from '../../types/documents'
import { useCollections } from '../../utils/mongo'
import { decodeCursor, encodeCursor, pageLimit } from '../../utils/pagination'
import { DOWNLOAD_URL_TTL_SECONDS, contentDisposition, presignGet } from '../../utils/s3'
import { toRevisionSummary } from './mappers'

// Revisions of a task (docs/api.md §4.10): the list sorted by number (newest first) with a number cursor, and the
// presigned download of a revision's stored snapshot. Publishing lives in ./publish, building in ./build, the build
// log in ./build-log.

interface NumberCursor {
  /** number of the last returned revision */
  n: number
}

function isNumberCursor(value: unknown): value is NumberCursor {
  const candidate = value as NumberCursor | null
  return typeof candidate === 'object' && candidate !== null && Number.isSafeInteger(candidate.n) && candidate.n > 0
}

export async function listRevisions(task: TaskDoc, query: { state?: RevisionState; limit?: number; cursor?: string }): Promise<Page<RevisionSummary>> {
  const limit = pageLimit(query.limit)
  const clauses: Filter<RevisionDoc>[] = [{ taskId: task._id }]
  if (query.state) clauses.push({ state: query.state })
  if (query.cursor) clauses.push({ number: { $lt: decodeCursor(query.cursor, isNumberCursor).n } })
  const docs = await useCollections()
    .revisions.find({ $and: clauses })
    .sort({ number: -1 })
    .limit(limit + 1)
    .toArray()
  const hasMore = docs.length > limit
  const page = hasMore ? docs.slice(0, limit) : docs
  const last = page.at(-1)
  return { items: page.map(toRevisionSummary), nextCursor: hasMore && last ? encodeCursor({ n: last.number } satisfies NumberCursor) : null }
}

/** Reloads a revision (for `wait`); falls back to the given document when it disappeared meanwhile. */
export async function reloadRevision(revision: RevisionDoc): Promise<RevisionDoc> {
  return (await useCollections().revisions.findOne({ _id: revision._id })) ?? revision
}

/** downloadRevisionSource: a presigned GET (10 minutes, public S3 URL) of the stored snapshot. */
export async function revisionSourceDownload(revision: RevisionDoc): Promise<{ url: string; expiresAt: Date }> {
  return presignGet({
    key: revision.snapshotKey,
    expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
    profile: 'public',
    responseContentType: 'application/gzip',
    responseContentDisposition: contentDisposition('attachment', `${revision.taskName}-${revision.number}.tar.gz`),
  })
}
