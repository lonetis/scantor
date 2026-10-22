import type { Revision, RevisionSummary } from '#shared/types/revisions'
import type { RevisionDoc } from '../../types/documents'
import { isoDate, isoDateOrNull } from '../../utils/serialize'

// Revision representations (docs/api.md §2): `Revision` omits snapshotKey, buildLogKey and jobId and adds
// `ref` (`<taskName>@<number>`); `RevisionSummary` is the list row.

export const TERMINAL_REVISION_STATES = ['ready', 'failed'] as const

export function revisionRef(doc: Pick<RevisionDoc, 'taskName' | 'number'>): string {
  return `${doc.taskName}@${doc.number}`
}

export function isRevisionSettled(doc: Pick<RevisionDoc, 'state'>): boolean {
  return (TERMINAL_REVISION_STATES as readonly string[]).includes(doc.state)
}

export function toApiRevision(doc: RevisionDoc): Revision {
  return {
    id: doc._id,
    userId: doc.userId,
    taskId: doc.taskId,
    taskName: doc.taskName,
    number: doc.number,
    ref: revisionRef(doc),
    state: doc.state,
    message: doc.message ?? null,
    source: {
      kind: doc.source.kind,
      packSha256: doc.source.packSha256,
      packBytes: doc.source.packBytes,
      fileCount: doc.source.fileCount,
      ...(doc.source.git ? { git: { ...doc.source.git } } : {}),
    },
    manifest: doc.manifest ?? null,
    language: doc.language ?? null,
    baseImage: doc.baseImage ?? null,
    image: doc.image ?? null,
    description: doc.description ?? null,
    settingsDefaults: doc.settingsDefaults ?? null,
    privileged: doc.privileged,
    errors: doc.errors,
    createdAt: isoDate(doc.createdAt),
    startedAt: isoDateOrNull(doc.startedAt),
    finishedAt: isoDateOrNull(doc.finishedAt),
    updatedAt: isoDate(doc.updatedAt),
  }
}

export function toRevisionSummary(doc: RevisionDoc): RevisionSummary {
  return {
    id: doc._id,
    number: doc.number,
    ref: revisionRef(doc),
    state: doc.state,
    source: { kind: doc.source.kind, packSha256: doc.source.packSha256 },
    privileged: doc.privileged,
    errorsCount: doc.errors.length,
    createdAt: isoDate(doc.createdAt),
    finishedAt: isoDateOrNull(doc.finishedAt),
  }
}
