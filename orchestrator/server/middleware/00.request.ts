import { randomUUID } from 'node:crypto'
import { defineEventHandler, getRequestHeader, setResponseHeader, setResponseStatus } from 'h3'
import { CLIENT_IP_HEADER, computeClientIp, normalizeHost } from '../utils/client-ip'
import { useConfig } from '../utils/config'
import { useLogger } from '../utils/logger'
import type { Principal } from '../utils/principal'
import { proxyTrust } from '../utils/trusted-proxy'
import { classifyRequest, isTunnelHost } from '../utils/tunnel'

// First middleware (docs/auth.md §1, §4.3): request id, client IP header, 421 Misdirected Request for the editor
// host on the dashboard listener and for a mismatched tunnel request (the tunnel URL's host from another peer, or
// cloudflared with another host; utils/tunnel.ts), and the access log line of every API, MCP and discovery request.

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/
const log = useLogger('http')

// A refused tunnel mismatch is logged at most once per kind in this interval: a misrouted tunnel repeats it per request.
const MISMATCH_LOG_INTERVAL_MS = 60_000
const lastMismatchLog = new Map<string, number>()

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

/**
 * Warns about a tunnel mismatch, at most once a minute per kind, so operators can diagnose a misrouted tunnel (a Host
 * override in its route, an unresolved cloudflared): the 421 returns before the access log line is registered.
 */
function logMismatch(host: string | undefined, peer: string | undefined, path: string, requestId: string): void {
  const { tunnelUrl } = useConfig()
  const kind = tunnelUrl !== null && isTunnelHost(host, tunnelUrl) ? 'tunnel host from another peer' : 'another host from cloudflared'
  const now = Date.now()
  if (now - (lastMismatchLog.get(kind) ?? Number.NEGATIVE_INFINITY) < MISMATCH_LOG_INTERVAL_MS) return
  lastMismatchLog.set(kind, now)
  log.warn('misdirected tunnel request refused with 421: the tunnel route must target http://orchestrator:3000 with the host of the tunnel URL', {
    kind,
    host: host?.slice(0, 256),
    peer,
    path: path.slice(0, 256),
    requestId,
  })
}

export default defineEventHandler((event) => {
  const started = performance.now()
  const incoming = getRequestHeader(event, 'x-request-id')
  const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID()
  event.context.requestId = requestId
  setResponseHeader(event, 'X-Request-Id', requestId)

  // Clients can never inject the client IP header: it is replaced on every request.
  const headers = event.node.req.headers
  const clientIp = computeClientIp(event.node.req.socket.remoteAddress, headers['x-forwarded-for'], proxyTrust())
  headers[CLIENT_IP_HEADER] = clientIp
  event.context.clientIp = clientIp

  if (isEditorHost(getRequestHeader(event, 'host'))) {
    setResponseStatus(event, 421, 'Misdirected Request')
    setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
    return 'Misdirected Request: the editor origin is served by its own listener.\n'
  }

  const path = event.path.split('?')[0] ?? '/'
  const origin = classifyRequest(event)
  if (origin === 'mismatch') {
    logMismatch(getRequestHeader(event, 'host'), event.node.req.socket.remoteAddress, path, requestId)
    setResponseStatus(event, 421, 'Misdirected Request')
    setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
    return 'Misdirected Request: the tunnel URL is served only through the Cloudflare Tunnel, which serves nothing else.\n'
  }

  if (logged(path)) {
    event.node.res.once('finish', () => {
      const principal = event.context.principal as Principal | null | undefined
      log.info('request', {
        requestId,
        method: event.method,
        path,
        origin,
        status: event.node.res.statusCode,
        durationMs: Math.round(performance.now() - started),
        clientIp,
        principal: principal?.kind,
        userId: principal?.kind === 'user' ? principal.user.id : principal?.kind === 'scriptRun' ? principal.scriptRun.userId : undefined,
        operationId: (event.context.operation as { operationId?: string } | undefined)?.operationId,
        code: typeof event.context.errorCode === 'string' ? event.context.errorCode : undefined,
      })
    })
  }
})
