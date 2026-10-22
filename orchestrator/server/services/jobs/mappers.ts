import type { JobRef } from '#shared/types/common'
import type { Job } from '#shared/types/jobs'
import type { JobDoc } from '../../types/documents'
import { isoDate, isoDateOrNull } from '../../utils/serialize'

// Job representations (docs/api.md §2 `Job`, `JobRef`).

export function toJobRef(doc: Pick<JobDoc, '_id' | 'kind' | 'state'>): JobRef {
  return { id: doc._id, kind: doc.kind, state: doc.state }
}

export function toApiJob(doc: JobDoc): Job {
  return {
    id: doc._id,
    kind: doc.kind,
    subject: doc.subject,
    state: doc.state,
    progress: { done: doc.progress.done, total: doc.progress.total ?? null },
    attempts: doc.attempts,
    error: doc.error,
    createdAt: isoDate(doc.createdAt),
    startedAt: isoDateOrNull(doc.startedAt),
    finishedAt: isoDateOrNull(doc.finishedAt),
  }
}
