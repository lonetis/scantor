import type { IncomingHttpHeaders, OutgoingHttpHeaders, ServerResponse } from 'node:http'

/*
 * Header rules of the editor origin (docs/editor.md §8.6–§8.8, security.md ED-2, HDR-4).
 *
 * Requests forwarded to code-server lose every credential and forwarding header: nothing the browser sends for the
 * dashboard (session cookie, API keys, tools cookie) and nothing a client could use to spoof its origin reaches the
 * user's container. `host` and `origin` stay unchanged, because code-server compares them for WebSocket upgrades.
 * Responses lose `Set-Cookie` (only `/_auth` may set cookies on the editor origin) and hop-by-hop headers, and gain
 * the editor origin's security headers.
 */

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']

const STRIPPED_REQUEST_HEADERS = new Set([
  'cookie',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'forwarded',
  'x-real-ip',
  ...HOP_BY_HOP,
])
const STRIPPED_REQUEST_PREFIXES = ['x-scantor-', 'x-forwarded-']

const STRIPPED_RESPONSE_HEADERS = new Set(['set-cookie', ...HOP_BY_HOP])

function strippedRequestHeader(name: string): boolean {
  return STRIPPED_REQUEST_HEADERS.has(name) || STRIPPED_REQUEST_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/**
 * The headers of a request forwarded to code-server. For a WebSocket upgrade the `connection: Upgrade` and
 * `upgrade` headers are restored after the hop-by-hop removal (`sec-websocket-*`, `origin` and `host` pass anyway).
 */
export function filterRequestHeaders(headers: IncomingHttpHeaders, options: { upgrade: boolean }): OutgoingHttpHeaders {
  const filtered: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || strippedRequestHeader(name)) continue
    filtered[name] = value
  }
  if (options.upgrade) {
    filtered.connection = 'Upgrade'
    filtered.upgrade = headers.upgrade ?? 'websocket'
  }
  return filtered
}

/** Response headers by lowercase name; a list value is sent as several header lines. */
export type HeaderRecord = Record<string, string | string[]>

/** The headers of a code-server response before the editor origin's security headers are added. */
export function filterResponseHeaders(headers: IncomingHttpHeaders): HeaderRecord {
  const filtered: HeaderRecord = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || STRIPPED_RESPONSE_HEADERS.has(name)) continue
    filtered[name] = value
  }
  return filtered
}

/** Sends the status line and `headers` (each list value as separate header lines). */
export function writeHeadWith(res: ServerResponse, status: number, headers: HeaderRecord, statusMessage?: string): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  res.writeHead(status, statusMessage)
}

export type EditorResponseKind = 'proxy' | 'auth' | 'page'

export interface SecurityHeaderOptions {
  /** origin of SCANTOR_PUBLIC_URL, the only foreign origin allowed to frame the editor */
  dashboardOrigin: string
  /** SCANTOR_EDITOR_URL is https */
  https: boolean
}

/** `frame-ancestors` of the editor origin: the dashboard, and the editor origin itself. */
export function editorFrameAncestors(dashboardOrigin: string): string {
  // 'self' is required: code-server frames its own origin (web worker extension host, webviews), and frame-ancestors
  // checks every ancestor, so with the dashboard alone those nested frames are blocked, embedded and in a new tab.
  return `frame-ancestors 'self' ${dashboardOrigin}`
}

/**
 * The headers every editor-listener response gets (docs/editor.md §8.8). `/_auth` uses `no-referrer`, so the code in
 * its URL never leaks; `/_auth` and the listener's own pages are never cached.
 */
export function editorSecurityHeaders(options: SecurityHeaderOptions, kind: EditorResponseKind): Record<string, string> {
  const headers: Record<string, string> = {
    'content-security-policy': editorFrameAncestors(options.dashboardOrigin),
    'x-content-type-options': 'nosniff',
    'referrer-policy': kind === 'auth' ? 'no-referrer' : 'same-origin',
  }
  if (options.https) headers['strict-transport-security'] = 'max-age=31536000'
  if (kind !== 'proxy') headers['cache-control'] = 'no-store'
  return headers
}

/**
 * Adds the security headers to a proxied response. The `frame-ancestors` policy is an **additional**
 * `Content-Security-Policy` header: code-server's own policy is kept and browsers enforce both. The other security
 * headers replace whatever code-server sent.
 */
export function withSecurityHeaders(headers: HeaderRecord, security: Record<string, string>): HeaderRecord {
  const merged: HeaderRecord = { ...headers }
  for (const [name, value] of Object.entries(security)) {
    const existing = merged[name]
    merged[name] = name === 'content-security-policy' && existing !== undefined ? [...[existing].flat(), value] : value
  }
  return merged
}

/**
 * The request head written to code-server for a WebSocket upgrade: the original request line (code-server is served
 * at the root, so method and path stay unchanged) and the filtered headers, each value on its own line.
 */
export function serializeUpgradeRequest(method: string, url: string, headers: OutgoingHttpHeaders): string {
  const lines = [`${method} ${url} HTTP/1.1`]
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${String(item)}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}
