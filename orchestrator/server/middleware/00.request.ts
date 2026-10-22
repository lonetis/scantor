import { randomUUID } from 'node:crypto'
import { defineEventHandler, getRequestHeader, setResponseHeader, setResponseStatus } from 'h3'
import { CLIENT_IP_HEADER, computeClientIp, normalizeHost } from '../utils/client-ip'
import { useConfig } from '../utils/config'
import { useLogger } from '../utils/logger'
import type { Principal } from '../utils/principal'

// First middleware (docs/auth.md §1, §4.3): request id, client IP header, 421 Misdirected Request for the editor
// host on the dashboard listener, and the access log line of every API, MCP and discovery request.

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/
const log = useLogger('http')

/** True when the Host header names the editor origin (compared with the editor URL's default port removed). */
function isEditorHost(host: string | undefined): boolean {
  if (!host) return false
  try {
    const url = new URL(useConfig().editorUrl)
    const protocol = url.protocol as 'http:' | 'https:'
    return normalizeHost(host, protocol) === normalizeHost(url.host, protocol)
  } catch {
    return false
  }
}

function logged(path: string): boolean {
  return path.startsWith('/api/') || path === '/mcp' || path.startsWith('/.well-known/')
}

export default defineEventHandler((event) => {
  const started = performance.now()
  const incoming = getRequestHeader(event, 'x-request-id')
  const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID()
  event.context.requestId = requestId
  setResponseHeader(event, 'X-Request-Id', requestId)

  // Clients can never inject the client IP header: it is replaced on every request.
  const headers = event.node.req.headers
  const clientIp = computeClientIp(event.node.req.socket.remoteAddress, headers['x-forwarded-for'], useConfig().trustProxy)
  headers[CLIENT_IP_HEADER] = clientIp
  event.context.clientIp = clientIp

  if (isEditorHost(getRequestHeader(event, 'host'))) {
    setResponseStatus(event, 421, 'Misdirected Request')
    setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
    return 'Misdirected Request: the editor origin is served by its own listener.\n'
  }

  const path = event.path.split('?')[0] ?? '/'
  if (logged(path)) {
    event.node.res.once('finish', () => {
      const principal = event.context.principal as Principal | null | undefined
      log.info('request', {
        requestId,
        method: event.method,
        path,
        status: event.node.res.statusCode,
        durationMs: Math.round(performance.now() - started),
        clientIp,
        principal: principal?.kind,
        userId: principal?.kind === 'user' ? principal.user.id : undefined,
        operationId: (event.context.operation as { operationId?: string } | undefined)?.operationId,
        code: typeof event.context.errorCode === 'string' ? event.context.errorCode : undefined,
      })
    })
  }
})
