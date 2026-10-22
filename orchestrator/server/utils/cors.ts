import { type H3Event, setResponseHeader, setResponseStatus } from 'h3'

// Credential-less CORS (docs/auth.md §4.2 rule 3): only discovery, JWKS, the OAuth token and registration endpoints
// and /mcp allow any origin, never with credentials. No other dashboard route sends CORS headers.

export const OPEN_CORS_ALLOWED_HEADERS = 'authorization, content-type, mcp-protocol-version, mcp-session-id, x-api-key'
export const OPEN_CORS_EXPOSED_HEADERS = 'mcp-session-id, mcp-protocol-version, www-authenticate'

const OPEN_CORS_PATHS = new Set(['/api/auth/jwks', '/api/auth/oauth2/token', '/api/auth/oauth2/register', '/mcp'])

export function isOpenCorsPath(path: string): boolean {
  return OPEN_CORS_PATHS.has(path) || path.startsWith('/.well-known/')
}

export function applyOpenCors(event: H3Event): void {
  setResponseHeader(event, 'Access-Control-Allow-Origin', '*')
  setResponseHeader(event, 'Access-Control-Allow-Headers', OPEN_CORS_ALLOWED_HEADERS)
  setResponseHeader(event, 'Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  setResponseHeader(event, 'Access-Control-Expose-Headers', OPEN_CORS_EXPOSED_HEADERS)
  setResponseHeader(event, 'Access-Control-Max-Age', 600)
}

/** Answers a CORS preflight of an open-CORS path; returns true when the request was handled. */
export function handleOpenCorsPreflight(event: H3Event, path: string): boolean {
  if (event.method !== 'OPTIONS' || !isOpenCorsPath(path)) return false
  applyOpenCors(event)
  setResponseStatus(event, 204)
  event.node.res.end()
  return true
}
