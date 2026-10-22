import { send, setResponseHeader, setResponseStatus, type H3Event } from 'h3'
import type { NitroErrorHandler } from 'nitropack/types'
import { normalizeError } from './errors'
import { useLogger } from './logger'

// Nitro error handler, prepended to Nuxt's in nuxt.config.ts: every error of `/api/*`, `/mcp` and
// `/.well-known/*` leaves the dashboard listener as the envelope of docs/api.md §1.7. Unexpected errors are logged
// with their stack and answered as 500 `internal` with `details.requestId`, never with internal messages. Errors
// of SPA pages are left to Nuxt's handler (the handler returns without responding).

const log = useLogger('api')

/** Paths whose errors use the scantor envelope. */
export function usesErrorEnvelope(path: string): boolean {
  return path === '/api' || path.startsWith('/api/') || path === '/mcp' || path.startsWith('/.well-known/')
}

function requestIdOf(event: H3Event): string | undefined {
  const id = event.context.requestId
  return typeof id === 'string' ? id : undefined
}

const errorHandler: NitroErrorHandler = (error, event) => {
  if (event.handled) return
  const path = event.path.split('?')[0] ?? '/'
  if (!usesErrorEnvelope(path)) return
  const requestId = requestIdOf(event)
  const normalized = normalizeError(error, requestId)
  // The access log line of middleware/00.request.ts reports the code of every rejection (docs/auth.md §5.5).
  event.context.errorCode = normalized.body.error.code
  if (normalized.unexpected) {
    log.error('unexpected error', {
      requestId,
      method: event.method,
      path,
      err: error.cause instanceof Error ? error.cause : error,
    })
  }
  setResponseStatus(event, normalized.status)
  setResponseHeader(event, 'Content-Type', 'application/json; charset=utf-8')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  for (const [name, value] of Object.entries(normalized.headers ?? {})) setResponseHeader(event, name, value)
  return send(event, JSON.stringify(normalized.body))
}

export default errorHandler
