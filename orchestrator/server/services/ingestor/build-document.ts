import type { Document } from 'mongodb'
import { isUuid } from '#shared/utils/slug'
import { analysisFileKey } from '../analyses/files'
import type { AnalysisMessage, AttemptMessage, FileRefMessage, ResultMessage, ScantorErrorMessage, TimingsMessage } from './messages'

/*
 * The guarded upserts of docs/queue.md §6.5 (docs/data-model.md §6.3, security.md ING-2). Every document is built
 * field by field from validated values: a message body is never spread into a document or used as an update, and
 * `result` and `config` are stored only as nested values. `_id` and `scanId` come from the credential-derived scan
 * id and are equality conditions of every filter, so an upsert inserts them from the filter. `userId` comes from
 * the scan document. File keys are recomputed with the presign route's function, never read from a message.
 *
 * When the document exists and the guard does not match, the upsert fails with E11000 for that operation: the
 * message is a duplicate or was superseded. Rules: a later success beats a failure in the same round; otherwise the
 * first terminal result wins; older rounds never overwrite newer ones.
 */

export const ATTEMPTS_KEPT = 10
export const ATTEMPT_LOG_TAIL_BYTES = 4 * 1024
export const MINIMAL_MESSAGE_BYTES = 1024

const SUCCEEDED_REPLACES = ['pending', 'retrying', 'failed', 'lost', 'cancelled']
const FAILED_REPLACES = ['pending', 'retrying', 'lost', 'cancelled']
const ATTEMPT_REPLACES = ['pending', 'retrying']

/** Identity and context of one write. */
export interface WriteTarget {
  scanId: string
  seq: number
  round: number
  attempt: number
  /** owner of the scan (from the scan document) */
  userId: string
  now: Date
}

export type WriteOutcome = 'succeeded' | 'failed' | 'retrying'

export interface AnalysisWrite {
  /** `<scanId>-<seq>` */
  id: string
  filter: Document
  update: Document
  /** what the write records when applied (hints, breaker, metrics) */
  outcome: WriteOutcome
  /** a minimal failed document of §6.5 (metric outcome `failedRecorded`) */
  minimal: boolean
}

export function analysisId(scanId: string, seq: number): string {
  return `${scanId}-${seq}`
}

function guardFilter(target: WriteTarget, statuses: string[], extra: Document = {}): Document {
  return {
    _id: analysisId(target.scanId, target.seq),
    scanId: target.scanId,
    $or: [{ round: { $lt: target.round } }, { round: target.round, status: { $in: statuses }, ...extra }],
  }
}

/** The last `maxBytes` bytes of a UTF-8 string, never splitting a character. */
export function tailBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  let start = buffer.length - maxBytes
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++
  return buffer.subarray(start).toString('utf8')
}

/** The first `maxBytes` bytes of a UTF-8 string, never splitting a character. */
export function headBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--
  return buffer.subarray(0, end).toString('utf8')
}

function errorDoc(error: ScantorErrorMessage): Document {
  const doc: Document = {
    type: error.type,
    message: error.message,
    retryable: error.retryable,
    phase: error.phase,
    attempt: error.attempt,
    at: new Date(error.at),
  }
  if (typeof error.stack === 'string') doc.stack = error.stack
  if (error.details && typeof error.details === 'object') doc.details = error.details
  return doc
}

function timingsDoc(timings: TimingsMessage): Document {
  return {
    scheduledAt: new Date(timings.scheduledAt),
    startedAt: new Date(timings.startedAt),
    finishedAt: new Date(timings.finishedAt),
    durationMs: timings.durationMs,
  }
}

function fileDocs(scanId: string, seq: number, executionId: string, files: FileRefMessage[]): Document[] {
  return files.map((file) => ({
    id: file.id,
    name: file.name,
    size: file.size,
    sha256: file.sha256,
    contentType: file.contentType,
    key: analysisFileKey(scanId, seq, executionId, file.id, file.name),
  }))
}

function attemptEntry(message: ResultMessage | AttemptMessage, error: Document | null): Document {
  return {
    attempt: message.attempt,
    round: message.round,
    executionId: message.executionId,
    workerId: message.workerId,
    nodeId: message.nodeId,
    startedAt: new Date(message.timings.startedAt),
    finishedAt: new Date(message.timings.finishedAt),
    durationMs: message.timings.durationMs,
    error,
    logTail: tailBytes(message.logTail, ATTEMPT_LOG_TAIL_BYTES),
  }
}

function pushAttempt(entry: Document): Document {
  return { attempts: { $each: [entry], $slice: -ATTEMPTS_KEPT } }
}

function setOnInsert(target: WriteTarget): Document {
  return { userId: target.userId, createdAt: target.now }
}

/** A succeeded result (validated against result.schema.json, `status: "succeeded"`). */
export function buildSucceededWrite(message: ResultMessage, target: WriteTarget): AnalysisWrite {
  return {
    id: analysisId(target.scanId, target.seq),
    filter: guardFilter(target, SUCCEEDED_REPLACES),
    update: {
      $set: {
        seq: target.seq,
        round: target.round,
        status: 'succeeded',
        attempt: target.attempt,
        config: message.config,
        result: message.result,
        files: fileDocs(target.scanId, target.seq, message.executionId, message.files),
        logTail: message.logTail,
        timings: timingsDoc(message.timings),
        workerId: message.workerId,
        nodeId: message.nodeId,
        executionId: message.executionId,
        updatedAt: target.now,
      },
      $unset: { error: '' },
      $setOnInsert: setOnInsert(target),
      $push: pushAttempt(attemptEntry(message, null)),
    },
    outcome: 'succeeded',
    minimal: false,
  }
}

/** A failed result (validated, `status: "failed"`). */
export function buildFailedWrite(message: ResultMessage, target: WriteTarget): AnalysisWrite {
  const error = errorDoc(message.error!)
  return {
    id: analysisId(target.scanId, target.seq),
    filter: guardFilter(target, FAILED_REPLACES),
    update: {
      $set: {
        seq: target.seq,
        round: target.round,
        status: 'failed',
        attempt: target.attempt,
        config: message.config,
        error,
        files: [],
        logTail: message.logTail,
        timings: timingsDoc(message.timings),
        workerId: message.workerId,
        nodeId: message.nodeId,
        executionId: message.executionId,
        updatedAt: target.now,
      },
      $unset: { result: '' },
      $setOnInsert: setOnInsert(target),
      $push: pushAttempt(attemptEntry(message, error)),
    },
    outcome: 'failed',
    minimal: false,
  }
}

/** An attempt event: the analysis becomes `retrying` unless it is final or a later attempt was recorded. */
export function buildAttemptWrite(message: AttemptMessage, target: WriteTarget): AnalysisWrite {
  const error = errorDoc(message.error)
  return {
    id: analysisId(target.scanId, target.seq),
    filter: guardFilter(target, ATTEMPT_REPLACES, { attempt: { $lt: target.attempt } }),
    update: {
      $set: {
        seq: target.seq,
        round: target.round,
        status: 'retrying',
        attempt: target.attempt,
        config: message.config,
        error,
        files: [],
        timings: timingsDoc(message.timings),
        workerId: message.workerId,
        nodeId: message.nodeId,
        executionId: message.executionId,
        updatedAt: target.now,
      },
      $unset: { result: '' },
      $setOnInsert: setOnInsert(target),
      $push: pushAttempt(attemptEntry(message, error)),
    },
    outcome: 'retrying',
    minimal: false,
  }
}

export interface MinimalFailure {
  /** the reason shown to the user (truncated to 1 KiB) */
  reason: string
  /** `platform` (default) or `validation` for results the platform refuses to store (security.md ING-4) */
  type?: 'platform' | 'validation'
  /** stored only when it is a uuid */
  executionId?: unknown
}

/**
 * The minimal failed document of docs/queue.md §6.5: used when a message cannot be stored as sent (schema or BSON
 * problems, per-operation write errors). It omits `config`, which may be the cause.
 */
export function buildMinimalFailedWrite(target: WriteTarget, failure: MinimalFailure): AnalysisWrite {
  const error = {
    type: failure.type ?? 'platform',
    phase: 'ingest',
    retryable: false,
    attempt: target.attempt,
    at: target.now,
    message: headBytes(failure.reason, MINIMAL_MESSAGE_BYTES),
  }
  const entry: Document = { attempt: target.attempt, round: target.round, error, logTail: '' }
  if (typeof failure.executionId === 'string' && isUuid(failure.executionId)) entry.executionId = failure.executionId.toLowerCase()
  return {
    id: analysisId(target.scanId, target.seq),
    filter: guardFilter(target, FAILED_REPLACES),
    update: {
      $set: { seq: target.seq, round: target.round, status: 'failed', attempt: target.attempt, files: [], updatedAt: target.now, error },
      $unset: { result: '', logTail: '' },
      $setOnInsert: setOnInsert(target),
      $push: pushAttempt(entry),
    },
    outcome: 'failed',
    minimal: true,
  }
}

/** The broker's death headers of a dead-lettered analysis (docs/queue.md §7). */
export interface DeathInfo {
  reason: string
  queue: string
  deliveryCount: number | null
  acquiredCount: number | null
}

/**
 * A dead-lettered analysis (docs/queue.md §7): `crash` when every worker that received it died (`delivery_limit`),
 * `platform` for any other dead-letter reason. Written with the failed-result guard, so it never overwrites a
 * real result of a duplicate execution.
 */
export function buildDeadLetterWrite(message: AnalysisMessage, target: WriteTarget, death: DeathInfo, deliveryLimit: number): AnalysisWrite {
  const details = {
    deathReason: death.reason,
    deathQueue: death.queue,
    deliveryCount: death.deliveryCount,
    acquiredCount: death.acquiredCount,
  }
  const crash = death.reason === 'delivery_limit'
  const error = {
    type: crash ? 'crash' : 'platform',
    phase: crash ? 'run' : 'platform',
    retryable: false,
    attempt: target.attempt,
    at: target.now,
    message: crash
      ? `every worker that received this analysis died while processing it (delivered ${death.deliveryCount ?? 'several'} times, delivery limit ${deliveryLimit})`
      : headBytes(`dead-lettered (${death.reason})`, MINIMAL_MESSAGE_BYTES),
    details,
  }
  return {
    id: analysisId(target.scanId, target.seq),
    filter: guardFilter(target, FAILED_REPLACES),
    update: {
      $set: {
        seq: target.seq,
        round: target.round,
        status: 'failed',
        attempt: target.attempt,
        config: message.config,
        error,
        files: [],
        logTail: '',
        timings: { scheduledAt: new Date(message.scheduledAt), startedAt: null, finishedAt: null, durationMs: null },
        updatedAt: target.now,
      },
      $unset: { result: '', workerId: '', nodeId: '', executionId: '' },
      $setOnInsert: setOnInsert(target),
      $push: pushAttempt({ attempt: target.attempt, round: target.round, error, logTail: '' }),
    },
    outcome: 'failed',
    minimal: false,
  }
}
