import type { ErrorCode } from '#shared/utils/error-codes'
import { ApiError } from '../../utils/errors'
import { redactText } from '../../utils/redact'
import type { HelperErrorPayload, HelperOp, HelperResult, SnapshotSummary } from './types'

// The helper I/O protocol (docs/editor.md §9.3): stdout carries exactly one JSON document (the tar.gz for
// `snapshot`), stderr carries NDJSON events — `log` lines, the final `summary` of `snapshot`, and on failure a final
// `error` line. Exit codes: 0 success, 1 user error (the error line explains it), anything else internal.

export const STDOUT_CAP_BYTES = 8 * 1024 ** 2
export const STDERR_CAP_BYTES = 1024 ** 2

export interface HelperStderr {
  logs: { level: string; msg: string }[]
  summary: SnapshotSummary | null
  error: HelperErrorPayload | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parses the NDJSON stderr of a helper; lines that are not events are ignored. */
export function parseHelperStderr(stderr: string): HelperStderr {
  const result: HelperStderr = { logs: [], summary: null, error: null }
  for (const line of stderr.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event: unknown
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isRecord(event)) continue
    if (event.type === 'log' && typeof event.msg === 'string') {
      result.logs.push({ level: typeof event.level === 'string' ? event.level : 'info', msg: event.msg })
    } else if (event.type === 'summary' && typeof event.packSha256 === 'string') {
      result.summary = {
        packSha256: event.packSha256,
        packBytes: Number(event.packBytes ?? 0),
        fileCount: Number(event.fileCount ?? 0),
        bytes: Number(event.bytes ?? 0),
      }
    } else if (event.type === 'error' && isRecord(event.error) && typeof event.error.code === 'string') {
      const error = event.error
      result.error = {
        code: error.code as string,
        message: typeof error.message === 'string' ? error.message : String(error.code),
        path: typeof error.path === 'string' ? error.path : undefined,
        details: isRecord(error.details) ? error.details : undefined,
      }
    }
  }
  return result
}

/** The last `maxBytes` of stderr, for logs of internal failures. */
export function stderrTail(stderr: string, maxBytes = 4096): string {
  return stderr.length > maxBytes ? stderr.slice(-maxBytes) : stderr
}

/**
 * A helper failure (docs/editor.md §9.3). It is an ApiError, so a route that lets it propagate answers with the
 * mapped status and code; `helperCode` keeps the helper's own code for callers that branch on it.
 */
export class HelperError extends ApiError {
  constructor(
    readonly op: HelperOp,
    mapped: { code: ErrorCode; message: string; details?: Record<string, unknown> },
    readonly helperCode: string | null,
    readonly stderr: string,
  ) {
    super(mapped.code, mapped.message, mapped.details)
    this.name = 'HelperError'
  }
}

/** Removes secrets from a helper message: known secret values first, then the generic redaction rules. */
export function scrubMessage(message: string, secrets: readonly string[] = []): string {
  let result = message
  for (const secret of secrets) {
    if (secret.length >= 4) result = result.split(secret).join('***')
  }
  return redactText(result)
}

/** Maps the error payload of a helper (exit 1) onto the API error of the table in docs/editor.md §9.3. */
export function mapHelperError(
  op: HelperOp,
  error: HelperErrorPayload,
  secrets: readonly string[] = [],
): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
  const message = scrubMessage(error.message, secrets)
  const details = error.details ?? {}
  switch (error.code) {
    case 'invalidPath':
      return { code: 'invalidPath', message, details: { path: error.path ?? (typeof details.path === 'string' ? details.path : '') } }
    case 'invalidArgument':
      return { code: 'badRequest', message }
    case 'tooManyFiles':
    case 'tooLarge':
    case 'workspaceFull': {
      const limit = typeof details.limit === 'number' ? details.limit : undefined
      const actual = typeof details.actual === 'number' ? details.actual : undefined
      return {
        code: 'payloadTooLarge',
        message,
        details: { ...(limit === undefined ? {} : { limit }), ...(actual === undefined ? {} : { actual }) },
      }
    }
    case 'notFound':
      return { code: 'notFound', message }
    case 'exists':
      return { code: 'alreadyExists', message }
    case 'manifestInvalid':
      return {
        code: 'manifestInvalid',
        message,
        details: { errors: Array.isArray(details.errors) ? details.errors : [{ phase: 'static', file: 'scantor.yaml', message }] },
      }
    case 'workspaceDirty':
      return { code: 'workspaceDirty', message, details }
    case 'gitFailed':
      return { code: 'gitFailed', message, details: { message } }
    case 'gitDiverged':
      return { code: 'gitDiverged', message }
    default:
      return { code: 'internal', message: `workspace ${op} failed` }
  }
}

/**
 * Checks the outcome of a helper run. Exit 0 passes; exit 1 with an error line becomes the mapped API error;
 * anything else (exit 2, signals, OOM 137, an unparseable failure) is a 500 `internal`.
 */
export function checkHelperResult(op: HelperOp, result: HelperResult, secrets: readonly string[] = []): HelperStderr {
  const stderr = parseHelperStderr(result.stderr)
  if (result.exitCode === 0) return stderr
  if (result.exitCode === 1 && stderr.error) {
    throw new HelperError(op, mapHelperError(op, stderr.error, secrets), stderr.error.code, result.stderr)
  }
  throw new HelperError(op, { code: 'internal', message: `workspace ${op} failed` }, stderr.error?.code ?? null, result.stderr)
}

/** Parses the single JSON document a helper writes to stdout. */
export function parseHelperStdout<T>(op: HelperOp, result: HelperResult): T {
  const text = result.stdout.toString('utf8').trim()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HelperError(op, { code: 'internal', message: `workspace ${op} returned no result` }, null, result.stderr)
  }
}

/** True when an error is a helper failure with the given helper error code. */
export function isHelperCode(error: unknown, code: string): boolean {
  return error instanceof HelperError && error.helperCode === code
}
