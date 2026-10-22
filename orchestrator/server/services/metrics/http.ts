import type { H3Event } from 'h3'
import { httpRequestDuration, httpRequests } from './catalogue'

// HTTP request metrics (docs/deployment.md §13.1): `scantor_http_requests_total{method, route, status}` and
// `scantor_http_request_duration_seconds{method, route}` for the API, MCP and discovery traffic. The route label
// is the matched operation's path template (set by the auth middleware), never the raw path, so label
// cardinality stays bounded.

const KNOWN_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

export function isMeasuredPath(path: string): boolean {
  return path.startsWith('/api/') || path === '/mcp' || path.startsWith('/.well-known/')
}

/** The route label of a request: the operation's path template, or a fixed label for unrouted traffic. */
export function routeLabel(path: string, pathTemplate: string | undefined): string {
  if (pathTemplate) return pathTemplate
  if (path === '/mcp') return '/mcp'
  if (path.startsWith('/api/auth/')) return '/api/auth/*'
  if (path.startsWith('/api/docs')) return '/api/docs'
  if (path.startsWith('/.well-known/')) return '/.well-known/*'
  return 'unmatched'
}

/** Nitro `request` hook: records the request once its response has finished or the connection closed. */
export function measureRequest(event: H3Event): void {
  const path = event.path.split('?')[0] ?? '/'
  if (!isMeasuredPath(path)) return
  const started = performance.now()
  let recorded = false
  event.node.res.once('close', () => {
    if (recorded) return
    recorded = true
    const operation = event.context.operation as { pathTemplate?: string } | undefined
    const method = KNOWN_METHODS.has(event.method) ? event.method : 'OTHER'
    const route = routeLabel(path, operation?.pathTemplate)
    httpRequests.inc({ method, route, status: String(event.node.res.statusCode) })
    httpRequestDuration.observe({ method, route }, (performance.now() - started) / 1000)
  })
}
