import type { Config } from './config'

// Request body caps (docs/api.md §1.5, security.md RES-1): every JSON body is capped at SCANTOR_MAX_REQUEST_BYTES;
// machine routes have fixed caps; streaming uploads have their own caps and count bytes while streaming.

export const RUNTIME_BODY_LIMIT = 1024 ** 2
export const NODE_REPORT_BODY_LIMIT = 2 * 1024 ** 2

/** The body cap of a request, or null when the route streams and enforces its own cap. */
export function bodyLimitFor(method: string, path: string, config: Pick<Config, 'maxRequestBytes' | 'taskMaxPackBytes' | 'maxUploadBytes'>): number {
  const upper = method.toUpperCase()
  if (upper === 'POST' && path === '/api/tasks/upload') return config.taskMaxPackBytes
  if (upper === 'POST' && path === '/api/uploads') return config.maxUploadBytes
  if (path.startsWith('/api/runtime/')) return RUNTIME_BODY_LIMIT
  if (path === '/api/node/status' || /^\/api\/node\/workers\/[^/]+\/logs$/.test(path)) return NODE_REPORT_BODY_LIMIT
  return config.maxRequestBytes
}
