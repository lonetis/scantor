import type { Document } from 'mongodb'
import type { Analysis, Attempt } from '#shared/types/analyses'
import type { FileRef, ScantorError } from '#shared/types/common'
import type { AnalysisTimings } from '#shared/types/test-runs'
import type { AnalysisDoc, AttemptDoc, FileRefDoc, ScantorErrorDoc, TimingsDoc } from '../../types/documents'
import { isoDate, isoDateOrNull } from '../../utils/serialize'
import { maskAnalysis } from './masking'

// The `Analysis` representation (docs/api.md §2): `id` = `_id`, ISO timestamps, `files[].key` omitted, secrets of
// `config` and `result` masked. Projections (listAnalyses `fields`, queryAnalyses, exports) go through
// toApiDocument, which applies the same rules to partial documents.

export function toApiScantorError(error: ScantorErrorDoc): ScantorError {
  const result: ScantorError = {
    type: error.type,
    message: error.message,
    retryable: error.retryable,
    phase: error.phase,
    attempt: error.attempt,
    at: isoDate(error.at),
  }
  if (typeof error.stack === 'string') result.stack = error.stack
  if (error.details) result.details = error.details
  return result
}

export function toApiFileRef(file: FileRefDoc): FileRef {
  return { id: file.id, name: file.name, size: file.size, sha256: file.sha256, contentType: file.contentType }
}

function toApiTimings(timings: TimingsDoc): AnalysisTimings {
  return {
    scheduledAt: isoDateOrNull(timings.scheduledAt),
    startedAt: isoDateOrNull(timings.startedAt),
    finishedAt: isoDateOrNull(timings.finishedAt),
    durationMs: timings.durationMs ?? null,
  }
}

function toApiAttempt(attempt: AttemptDoc): Attempt {
  return {
    attempt: attempt.attempt,
    round: attempt.round,
    // Dead-lettered crashes and ingest failures without a valid execution id store none (docs/queue.md §6.5, §7).
    executionId: (attempt.executionId ?? null) as string,
    workerId: attempt.workerId ?? null,
    nodeId: attempt.nodeId ?? null,
    startedAt: isoDateOrNull(attempt.startedAt),
    finishedAt: isoDateOrNull(attempt.finishedAt),
    durationMs: attempt.durationMs ?? null,
    error: attempt.error ? toApiScantorError(attempt.error) : null,
    logTail: attempt.logTail ?? '',
  }
}

/** The full representation of one analysis, masked with `maskPatterns` (server/services/analyses/masking.ts). */
export function toApiAnalysis(doc: AnalysisDoc, maskPatterns: readonly string[]): Analysis {
  const analysis: Analysis = {
    id: doc._id,
    scanId: doc.scanId,
    userId: doc.userId,
    seq: doc.seq,
    round: doc.round,
    status: doc.status,
    attempt: doc.attempt,
    attempts: (doc.attempts ?? []).map(toApiAttempt),
    files: (doc.files ?? []).map(toApiFileRef),
    createdAt: isoDate(doc.createdAt),
    updatedAt: isoDate(doc.updatedAt),
  }
  if (doc.config !== undefined) analysis.config = doc.config
  if (doc.result !== undefined && doc.result !== null) analysis.result = doc.result
  if (doc.error) analysis.error = toApiScantorError(doc.error)
  if (typeof doc.logTail === 'string') analysis.logTail = doc.logTail
  if (doc.timings) analysis.timings = toApiTimings(doc.timings)
  if (doc.workerId) analysis.workerId = doc.workerId
  if (doc.nodeId) analysis.nodeId = doc.nodeId
  if (doc.executionId) analysis.executionId = doc.executionId
  return maskAnalysis(analysis, maskPatterns)
}

function stripFileKeys(files: unknown): unknown {
  if (!Array.isArray(files)) {
    if (files && typeof files === 'object' && 'key' in files) {
      const { key: _key, ...rest } = files as Record<string, unknown>
      return rest
    }
    return files
  }
  return files.map((file) => stripFileKeys(file))
}

/**
 * A (possibly partial) analysis document as returned by a projection or query: top-level `_id` becomes `id`,
 * internal `files[].key` values are removed and secrets masked. Dates are serialized as ISO strings by JSON.
 */
export function toApiDocument(doc: Document, maskPatterns: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(doc)) {
    if (key === '_id') result.id = value
    else if (key === 'files') result.files = stripFileKeys(value)
    else result[key] = value
  }
  return maskAnalysis(result, maskPatterns)
}
