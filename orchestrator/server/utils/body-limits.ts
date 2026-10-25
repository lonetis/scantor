import type { Config } from './config'

// Request body caps (docs/api.md §1.5, security.md RES-1): every JSON body is capped at SCANTOR_MAX_REQUEST_BYTES;
// machine and protocol routes have fixed caps; streaming uploads have their own caps and count bytes while streaming.
// middleware/02.body-limit.ts enforces them on `/api/*`, `/mcp` and the root `/.well-known/*` documents.

export const RUNTIME_BODY_LIMIT = 1024 ** 2
export const NODE_REPORT_BODY_LIMIT = 2 * 1024 ** 2
/** better-auth, the registry token realm, `/mcp` and the root discovery documents: small bodies, many from anonymous clients */
export const PROTOCOL_BODY_LIMIT = 1024 ** 2

type LimitConfig = Pick<Config, 'maxRequestBytes' | 'taskMaxPackBytes' | 'maxUploadBytes'>

function isAuthPath(path: string): boolean {
  return path === '/api/auth' || path.startsWith('/api/auth/')
}

/**
 * The body cap of a request, or null for paths the body-limit middleware leaves alone (the UI and its assets, which
 * never read a body).
 */
export function bodyLimitFor(method: string, path: string, config: LimitConfig): number | null {
  const upper = method.toUpperCase()
  if (path === '/mcp' || path.startsWith('/.well-known/')) return PROTOCOL_BODY_LIMIT
  if (!path.startsWith('/api/')) return null
  if (upper === 'POST' && path === '/api/tasks/upload') return config.taskMaxPackBytes
  if (upper === 'POST' && path === '/api/uploads') return config.maxUploadBytes
  if (isAuthPath(path) || path === '/api/registry/token') return PROTOCOL_BODY_LIMIT
  if (path.startsWith('/api/runtime/')) return RUNTIME_BODY_LIMIT
  if (path === '/api/node/status' || /^\/api\/node\/workers\/[^/]+\/logs$/.test(path)) return NODE_REPORT_BODY_LIMIT
  return config.maxRequestBytes
}

/** The routes that stream their body under their own cap (ByteCap) instead of having it buffered by the middleware. */
export function isStreamingBodyRoute(method: string, path: string): boolean {
  return method.toUpperCase() === 'POST' && (path === '/api/tasks/upload' || path === '/api/uploads')
}
