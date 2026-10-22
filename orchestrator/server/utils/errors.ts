import { H3Error } from 'h3'
import { ERROR_CODES, type ErrorCode, isErrorCode } from '#shared/utils/error-codes'
import type { ErrorBody, ValidationIssue } from '#shared/types/common'

// The error model of docs/api.md §1.7. Handlers throw `apiError(code, message, details?)`; the HTTP status comes
// from the shared error-code table and the body is the envelope `{error: {code, message, details?}}`, rendered by
// server/utils/error-handler.ts. Nothing else throws HTTP errors.

export class ApiError extends H3Error<{ code: ErrorCode; details?: Record<string, unknown> }> {
  readonly code: ErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.details = details
    this.statusCode = ERROR_CODES[code].status
    this.statusMessage = code
    this.data = details === undefined ? { code } : { code, details }
  }
}

export function apiError(code: ErrorCode, message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(code, message, details)
}

export function validationError(issues: ValidationIssue[], message = 'request validation failed'): ApiError {
  return apiError('validationFailed', message, { issues })
}

export function notFound(what = 'resource'): ApiError {
  return apiError('notFound', `${what} not found`)
}

/** 409 invalidState with the current and allowed states (docs/data-model.md §6). */
export function invalidState(resource: string, state: string, allowed: readonly string[], action?: string): ApiError {
  const requirement = allowed.length > 0 ? `; ${action ?? 'this operation'} requires ${allowed.join(' or ')}` : ''
  return apiError('invalidState', `${resource} is ${state}${requirement}`, { state, allowed: [...allowed] })
}

const STATUS_FALLBACK_CODES: Record<number, ErrorCode> = {
  400: 'badRequest',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'notFound',
  405: 'methodNotAllowed',
  409: 'invalidState',
  413: 'payloadTooLarge',
  415: 'unsupportedMediaType',
  422: 'validationFailed',
  429: 'tooManyRequests',
  503: 'unavailable',
  504: 'unavailable',
}

export interface NormalizedError {
  status: number
  body: ErrorBody
  /** true when the error is unexpected and must be logged with its stack */
  unexpected: boolean
  headers?: Record<string, string>
}

/**
 * Maps any thrown value onto the envelope. ApiErrors keep their code; other HTTP errors (h3 body parsing,
 * Nitro routing) map by status; everything else is a 500 `internal` whose message never leaks internals.
 */
export function normalizeError(error: unknown, requestId?: string): NormalizedError {
  const candidate = error instanceof H3Error && error.cause instanceof ApiError ? error.cause : error
  if (candidate instanceof ApiError) {
    const details =
      candidate.statusCode === 500 && requestId ? { ...candidate.details, requestId } : candidate.details
    return {
      status: candidate.statusCode,
      body: { error: { code: candidate.code, message: candidate.message, ...(details === undefined ? {} : { details }) } },
      unexpected: candidate.statusCode >= 500 && candidate.code === 'internal',
    }
  }
  if (error instanceof H3Error && !error.unhandled && error.statusCode < 500) {
    const dataCode = (error.data as { code?: unknown } | undefined)?.code
    const code: ErrorCode = isErrorCode(dataCode) ? dataCode : (STATUS_FALLBACK_CODES[error.statusCode] ?? 'badRequest')
    return {
      status: ERROR_CODES[code].status === error.statusCode ? error.statusCode : ERROR_CODES[code].status,
      body: { error: { code, message: error.statusMessage || error.message || code } },
      unexpected: false,
    }
  }
  if (error instanceof H3Error && !error.unhandled && error.statusCode === 503) {
    return { status: 503, body: { error: { code: 'unavailable', message: error.message || 'service unavailable' } }, unexpected: false }
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'internal',
        message: 'unexpected server error',
        ...(requestId ? { details: { requestId } } : {}),
      },
    },
    unexpected: true,
  }
}
