import type { Config } from './config'

// Dashboard security headers (security.md HDR-1..HDR-3, docs/ui.md §13). The policy depends on runtime origins
// (editor and S3 public URLs), so it is built once from the configuration. `scriptSources` admits the SPA shell's
// inline scripts; server/plugins/csp.ts adds a per-response nonce to the shell and its header.

/** Pages that must never be framed and never cached. */
export const NO_FRAME_PAGES = ['/login', '/setup', '/oauth/consent']

export const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)'

export interface CspOptions {
  editorOrigin: string
  s3PublicOrigin: string
  /** extra script-src sources, for example `'nonce-…'` */
  scriptSources?: string[]
  frameAncestors?: string
  /** development: Vite's client needs eval and websocket connections */
  dev?: boolean
}

export function buildCsp(options: CspOptions): string {
  const script = ["'self'", ...(options.scriptSources ?? []), ...(options.dev ? ["'unsafe-eval'", "'unsafe-inline'"] : [])]
  const connect = ["'self'", ...(options.dev ? ['ws:', 'wss:'] : [])]
  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${options.s3PublicOrigin}`,
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    `frame-src ${options.editorOrigin}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${options.frameAncestors ?? "'self'"}`,
  ].join('; ')
}

/**
 * CSP of the Scalar UI at /api/docs: its pinned bundle comes from a CDN (the documented exception) and loads its
 * Inter and mono fonts from fonts.scalar.com.
 */
export function buildDocsCsp(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net https://fonts.scalar.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
  ].join('; ')
}

export function cspOptionsFrom(config: Pick<Config, 'editorUrl' | 's3PublicUrl'>, dev: boolean): CspOptions {
  return { editorOrigin: new URL(config.editorUrl).origin, s3PublicOrigin: new URL(config.s3PublicUrl).origin, dev }
}

export function isNoFramePage(path: string): boolean {
  return NO_FRAME_PAGES.some((page) => path === page || path.startsWith(`${page}/`))
}
