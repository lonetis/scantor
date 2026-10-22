import type { ScantorErrorDoc, TestRunAnalysisDoc, TimingsDoc } from '../../types/documents'
import { maskSecrets } from '../../utils/secrets'

// Local-mode output events of the runtime (docs/runtime.md §15.3) and their mapping onto `testRunAnalyses`
// documents (docs/data-model.md §4.4). Event times are ISO strings; documents store Dates.

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

const ERROR_TYPES = new Set(['taskError', 'fatal', 'retry', 'timeout', 'crash', 'validation', 'platform', 'cancelled'])
const ERROR_PHASES = new Set(['bootstrap', 'schedule', 'run', 'validate', 'upload', 'publish', 'platform', 'ingest'])

export function toErrorDoc(error: LocalErrorEvent | null | undefined, fallbackAt: Date): ScantorErrorDoc | null {
  if (!error) return null
  return {
    type: (ERROR_TYPES.has(error.type) ? error.type : 'platform') as ScantorErrorDoc['type'],
    message: String(error.message ?? '').slice(0, 4096),
    retryable: error.retryable === true,
    phase: (error.phase && ERROR_PHASES.has(error.phase) ? error.phase : 'run') as ScantorErrorDoc['phase'],
    attempt: typeof error.attempt === 'number' ? error.attempt : 0,
    ...(error.stack ? { stack: error.stack.slice(0, 16_384) } : {}),
    ...(error.details ? { details: error.details } : {}),
    at: toDate(error.at) ?? fallbackAt,
  }
}

export interface AnalysisContext {
  testRunId: string
  userId: string
  expiresAt: Date
  secretPaths: { analysisConfig: string[]; result: string[] }
  now: Date
}

/** Builds the `testRunAnalyses` document of a `result` event, masking secrets of the config and result. */
export function analysisFromResult(event: Extract<LocalEvent, { type: 'result' }>, ctx: AnalysisContext): TestRunAnalysisDoc {
  const at = toDate(event.at) ?? ctx.now
  const timings: TimingsDoc = {
    scheduledAt: toDate(event.timings?.scheduledAt),
    startedAt: toDate(event.timings?.startedAt),
    finishedAt: toDate(event.timings?.finishedAt),
    durationMs: typeof event.timings?.durationMs === 'number' ? event.timings.durationMs : null,
  }
  return {
    _id: `${ctx.testRunId}-${event.seq}`,
    testRunId: ctx.testRunId,
    userId: ctx.userId,
    seq: event.seq,
    status: event.status === 'succeeded' ? 'succeeded' : 'failed',
    attempt: event.attempt,
    ...(event.config ? { config: maskSecrets(event.config, ctx.secretPaths.analysisConfig) } : {}),
    result: event.status === 'succeeded' && event.result ? maskSecrets(event.result, ctx.secretPaths.result) : null,
    error: toErrorDoc(event.error, at),
    attempts: (event.attempts ?? []).slice(-10).map((attempt) => ({
      attempt: attempt.attempt,
      startedAt: toDate(attempt.startedAt),
      finishedAt: toDate(attempt.finishedAt),
      durationMs: typeof attempt.durationMs === 'number' ? attempt.durationMs : null,
      error: toErrorDoc(attempt.error, at),
      logTail: attempt.logTail ?? '',
    })),
    files: (event.files ?? []).map((file) => ({ id: file.id, name: file.name, size: file.size, sha256: file.sha256, contentType: file.contentType })),
    logTail: event.logTail ?? '',
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
