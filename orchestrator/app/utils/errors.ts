// Client-side representation of API errors (docs/api.md §1.7, docs/ui.md §8). Titles come from the shared
// error-code table.

import { errorTitleFor } from '../../shared/utils/error-codes'

/** The error code the client uses when no HTTP response arrived at all. */
export const NETWORK_ERROR_CODE = 'network'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown>
  readonly requestId: string | null

  constructor(init: { status: number, code: string, message: string, details?: Record<string, unknown>, requestId?: string | null }) {
    super(init.message)
    this.name = 'ApiError'
    this.status = init.status
    this.code = init.code
    this.details = init.details ?? {}
    this.requestId = init.requestId ?? null
  }

  get isNetworkError(): boolean {
    return this.code === NETWORK_ERROR_CODE
  }
}

/** Toast title for an error code; unknown codes fall back to a generic title. */
export function errorTitle(code: string): string {
  return code === NETWORK_ERROR_CODE ? 'Cannot reach the orchestrator' : errorTitleFor(code)
}

const STATUS_CODES: Record<number, string> = {
  400: 'badRequest',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'notFound',
  405: 'methodNotAllowed',
  409: 'invalidState',
  413: 'payloadTooLarge',
  415: 'unsupportedMediaType',
  429: 'tooManyRequests',
  500: 'internal',
  503: 'unavailable',
  504: 'queryTimeout',
}

/** The shape of an ofetch `FetchError` that this module reads (kept structural for testability). */
export interface FetchErrorLike {
  message?: string
  data?: unknown
  response?: { status: number, headers: { get(name: string): string | null } } | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/**
 * Converts a failed fetch into an `ApiError`: the scantor envelope `{error: {code, message, details}}` when
 * present, else the better-auth shape `{code, message}`, else a code derived from the HTTP status. No response
 * at all is a network error.
 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  const fetchError = (asRecord(error) ?? {}) as FetchErrorLike
  const response = fetchError.response
  if (!response) {
    return new ApiError({ status: 0, code: NETWORK_ERROR_CODE, message: 'The orchestrator did not answer the request.' })
  }
  const requestId = response.headers.get('x-request-id')
  const body = asRecord(fetchError.data)
  const envelope = asRecord(body?.error)
  if (envelope && typeof envelope.code === 'string') {
    return new ApiError({
      status: response.status,
      code: envelope.code,
      message: typeof envelope.message === 'string' ? envelope.message : errorTitle(envelope.code),
      details: asRecord(envelope.details) ?? {},
      requestId,
    })
  }
  const code = STATUS_CODES[response.status] ?? (response.status >= 500 ? 'internal' : 'badRequest')
  const message = typeof body?.message === 'string' && body.message ? body.message : errorTitle(code)
  return new ApiError({ status: response.status, code, message, requestId })
}

/** Turns `details.issues` of a `validationFailed`/`configInvalid` error into `{path, message}` entries. */
export function errorIssues(error: ApiError): { path: string, message: string }[] {
  const issues = error.details.issues
  if (!Array.isArray(issues)) return []
  return issues.flatMap((issue) => {
    const record = asRecord(issue)
    if (!record || typeof record.message !== 'string') return []
    return [{ path: typeof record.path === 'string' ? record.path : '', message: record.message }]
  })
}

/** Human message for inline error display. */
export function errorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (error instanceof ApiError) return error.message || errorTitle(error.code)
  if (error instanceof Error && error.message) return error.message
  return fallback
}
