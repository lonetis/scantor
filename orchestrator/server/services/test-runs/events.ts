import type { FileRefDoc, ScantorErrorDoc, TestRunAnalysisDoc, TimingsDoc } from '../../types/documents'
import { safeName } from '../../utils/s3'
import { maskSecrets } from '../../utils/secrets'

// Local-mode output events of the runtime (docs/runtime.md §15.3) and their mapping onto `testRunAnalyses`
// documents (docs/data-model.md §4.4). Event times are ISO strings; documents store Dates. The container's output is
// untrusted (security.md A2: task code can write to the runtime's stdout), so every field is checked or bounded
// before it is stored.

export interface LocalErrorEvent {
  type: string
  message: string
  retryable?: boolean
  phase?: string
  attempt?: number
  stack?: string
  details?: Record<string, unknown>
  at?: string
}

export interface LocalFile {
  id: string
  name: string
  size: number
  sha256: string
  contentType: string
  /** relative to outDir: files/<seq>/<fileId>/<safeName> */
  path: string
}

export interface LocalAttempt {
  attempt: number
  startedAt?: string | null
  finishedAt?: string | null
  durationMs?: number | null
  error?: LocalErrorEvent | null
  logTail?: string
}

export type LocalEvent =
  | { type: 'start'; at: string; [key: string]: unknown }
  | { type: 'resolved'; at: string; key: string; template: string; [key: string]: unknown }
  | { type: 'scheduled'; at: string; seq: number; config: unknown }
  | { type: 'log'; at: string; seq: number | null; attempt: number | null; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'attempt'; at: string; seq: number; attempt: number; error: LocalErrorEvent; nextAttemptAt: string }
  | {
      type: 'result'
      at: string
      seq: number
      status: 'succeeded' | 'failed'
      attempt: number
      config: Record<string, unknown> | null
      result: Record<string, unknown> | null
      error: LocalErrorEvent | null
      files: LocalFile[]
      logTail: string
      attempts: LocalAttempt[]
      timings: { scheduledAt?: string | null; startedAt?: string | null; finishedAt?: string | null; durationMs?: number | null }
    }
  | { type: 'error'; at: string; error: LocalErrorEvent }
  | { type: 'end'; at: string; reason: 'done' | 'limit' | 'scheduleFailed' | 'startFailed' | 'timeout' | 'interrupted'; summary: { analyses: number; succeeded: number; failed: number }; exitCode: number }

const LOCAL_EVENT_TYPES = new Set(['start', 'resolved', 'scheduled', 'log', 'attempt', 'result', 'error', 'end'])

export function parseLocalEvent(line: string): LocalEvent | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const type = (value as { type?: unknown }).type
  if (typeof type !== 'string' || !LOCAL_EVENT_TYPES.has(type)) return null
  if (type === 'result' && !Number.isSafeInteger((value as { seq?: unknown }).seq)) return null
  return value as LocalEvent
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Server-side bounds of a stored test-run analysis; the runtime keeps below them, task code may not. */
export const MAX_LOG_TAIL_BYTES = 64 * 1024
export const MAX_ATTEMPT_LOG_TAIL_BYTES = 4 * 1024
export const MAX_ERROR_DETAILS_BYTES = 16 * 1024

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The last `maxBytes` bytes of a string, never splitting a character; anything else becomes ''. */
function tailOf(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string') return ''
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.length <= maxBytes) return value
  let start = buffer.length - maxBytes
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++
  return buffer.subarray(start).toString('utf8')
}

const ERROR_TYPES = new Set(['taskError', 'fatal', 'retry', 'timeout', 'crash', 'validation', 'platform', 'cancelled'])
const ERROR_PHASES = new Set(['bootstrap', 'schedule', 'run', 'validate', 'upload', 'publish', 'platform', 'ingest'])

export function toErrorDoc(error: LocalErrorEvent | null | undefined, fallbackAt: Date): ScantorErrorDoc | null {
  if (!isPlainObject(error)) return null
  return {
    type: (ERROR_TYPES.has(error.type) ? error.type : 'platform') as ScantorErrorDoc['type'],
    message: String(error.message ?? '').slice(0, 4096),
    retryable: error.retryable === true,
    phase: (typeof error.phase === 'string' && ERROR_PHASES.has(error.phase) ? error.phase : 'run') as ScantorErrorDoc['phase'],
    attempt: typeof error.attempt === 'number' ? error.attempt : 0,
    ...(typeof error.stack === 'string' && error.stack ? { stack: error.stack.slice(0, 16_384) } : {}),
    ...(isPlainObject(error.details) && jsonBytes(error.details) <= MAX_ERROR_DETAILS_BYTES ? { details: error.details } : {}),
    at: toDate(typeof error.at === 'string' ? error.at : undefined) ?? fallbackAt,
  }
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const CONTENT_TYPE = /^[\w.+-]+\/[\w.+-]+(\s*;[\x20-\x7e]*)?$/

/** Whether a `result` for `seq` is kept: local mode numbers a run's analyses 0 … limit-1, and each is final once. */
export function resultSeqAccepted(seq: number, limit: number, stored: { has(seq: number): boolean }): boolean {
  return Number.isSafeInteger(seq) && seq >= 0 && seq < limit && !stored.has(seq)
}

/** A file of a `result` event that the job may upload, with the path of its copy below the container's outDir. */
export interface AcceptedFile {
  ref: FileRefDoc
  /** `files/<seq>/<id>/<safeName(name)>`, as the runtime writes it */
  path: string
}

/**
 * The files of a `result` event that are kept. As for presigned scan uploads (docs/api.md §8.3), the id must be a
 * uuid v4, unique within the analysis, and the name, size, hash and content type well-formed; the path must be
 * exactly the one the runtime writes, so the S3 key `test-runs/<id>/files/<seq>/<fileId>/<safeName>` stays inside
 * the run's prefix. Other files are dropped, and at most `maxFiles` are kept.
 */
export function acceptedFiles(event: Extract<LocalEvent, { type: 'result' }>, maxFiles: number): AcceptedFile[] {
  const accepted: AcceptedFile[] = []
  const ids = new Set<string>()
  for (const file of Array.isArray(event.files) ? (event.files as unknown[]) : []) {
    if (accepted.length >= maxFiles) break
    if (typeof file !== 'object' || file === null) continue
    const { id, name, size, sha256, contentType, path } = file as Partial<Record<keyof LocalFile, unknown>>
    if (typeof id !== 'string' || !UUID_V4.test(id) || ids.has(id)) continue
    if (typeof name !== 'string' || name.length === 0 || name.length > 255 || /[\0/\\]/.test(name)) continue
    if (!Number.isSafeInteger(size) || (size as number) < 0) continue
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) continue
    if (typeof contentType !== 'string' || contentType.length > 255 || !CONTENT_TYPE.test(contentType)) continue
    const expected = `files/${event.seq}/${id}/${safeName(name)}`
    if (path !== expected) continue
    ids.add(id)
    accepted.push({ ref: { id, name, size: size as number, sha256, contentType }, path: expected })
  }
  return accepted
}

export interface AnalysisContext {
  testRunId: string
  userId: string
  expiresAt: Date
  secretPaths: { analysisConfig: string[]; result: string[] }
  /** SCANTOR_MAX_FILES_PER_ANALYSIS */
  maxFiles: number
  /** SCANTOR_MAX_RESULT_BYTES: a larger result fails the analysis, as in the ingestor */
  maxResultBytes: number
  /** SCANTOR_MAX_ANALYSIS_CONFIG_BYTES: a larger config is not stored */
  maxConfigBytes: number
  now: Date
}

function toTimestamp(value: unknown): Date | null {
  return toDate(typeof value === 'string' ? value : undefined)
}

/**
 * Builds the `testRunAnalyses` document of a `result` event, masking secrets of the config and result. Every field is
 * bounded: the result by SCANTOR_MAX_RESULT_BYTES (else the analysis fails with a validation error), the config by
 * SCANTOR_MAX_ANALYSIS_CONFIG_BYTES (else it is left out), log tails, error details and the last 10 attempts by fixed
 * sizes, and the files by acceptedFiles.
 */
export function analysisFromResult(event: Extract<LocalEvent, { type: 'result' }>, ctx: AnalysisContext): TestRunAnalysisDoc {
  const at = toDate(event.at) ?? ctx.now
  const timings: TimingsDoc = {
    scheduledAt: toTimestamp(event.timings?.scheduledAt),
    startedAt: toTimestamp(event.timings?.startedAt),
    finishedAt: toTimestamp(event.timings?.finishedAt),
    durationMs: typeof event.timings?.durationMs === 'number' ? event.timings.durationMs : null,
  }
  const attempt = Number.isSafeInteger(event.attempt) ? event.attempt : 0
  let status: TestRunAnalysisDoc['status'] = event.status === 'succeeded' ? 'succeeded' : 'failed'
  let result: Record<string, unknown> | null = status === 'succeeded' && isPlainObject(event.result) ? event.result : null
  let error = toErrorDoc(event.error, at)
  const resultBytes = result ? jsonBytes(result) : 0
  if (result && resultBytes > ctx.maxResultBytes) {
    status = 'failed'
    result = null
    error = {
      type: 'validation',
      message: `the result is ${resultBytes} bytes, above SCANTOR_MAX_RESULT_BYTES (${ctx.maxResultBytes} bytes)`,
      retryable: false,
      phase: 'ingest',
      attempt,
      at,
    }
  }
  const config = isPlainObject(event.config) && jsonBytes(event.config) <= ctx.maxConfigBytes ? event.config : null
  const attempts = Array.isArray(event.attempts) ? event.attempts.slice(-10).filter(isPlainObject) : []
  return {
    _id: `${ctx.testRunId}-${event.seq}`,
    testRunId: ctx.testRunId,
    userId: ctx.userId,
    seq: event.seq,
    status,
    attempt,
    ...(config ? { config: maskSecrets(config, ctx.secretPaths.analysisConfig) } : {}),
    result: result ? maskSecrets(result, ctx.secretPaths.result) : null,
    error,
    attempts: (attempts as unknown as LocalAttempt[]).map((entry) => ({
      attempt: Number.isSafeInteger(entry.attempt) ? entry.attempt : 0,
      startedAt: toTimestamp(entry.startedAt),
      finishedAt: toTimestamp(entry.finishedAt),
      durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : null,
      error: toErrorDoc(entry.error, at),
      logTail: tailOf(entry.logTail, MAX_ATTEMPT_LOG_TAIL_BYTES),
    })),
    files: acceptedFiles(event, ctx.maxFiles).map((file) => file.ref),
    logTail: tailOf(event.logTail, MAX_LOG_TAIL_BYTES),
    timings,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    expiresAt: ctx.expiresAt,
  }
}

/** "taskConfig /greeting: must be string" from a configInvalid issue `{path: "/taskConfig/greeting"}`. */
export function configIssueMessage(issue: { path: string; message: string }): string {
  const match = /^\/([^/]+)(\/.*)?$/.exec(issue.path)
  if (!match) return issue.message
  return match[2] ? `${match[1]} ${match[2]}: ${issue.message}` : `${match[1]}: ${issue.message}`
}
