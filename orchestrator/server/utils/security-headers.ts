import { setResponseHeaders, type H3Event } from 'h3'
import type { Config } from './config'

// Dashboard security headers (security.md HDR-1..HDR-3, docs/ui.md §13). The policy depends on runtime origins
// (editor and S3 public URLs) and HSTS on the scheme of SCANTOR_PUBLIC_URL, so both are built once from the
// configuration. server/plugins/security-headers.ts applies them to every response in Nitro's `request` hook and
// adds a per-response nonce to the SPA shell; `scriptSources` admits the shell's inline scripts.

/** Pages that must never be framed and never cached. */
export const NO_FRAME_PAGES = ['/login', '/setup', '/oauth/consent']

export const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)'

export const HSTS = 'max-age=31536000'

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

/** The header values of one deployment. */
export interface SecurityPolicies {
  normal: string
  noFrame: string
  docs: string
  /** SCANTOR_PUBLIC_URL is https */
  hsts: boolean
}

export function securityPoliciesFrom(config: Pick<Config, 'publicUrl' | 'editorUrl' | 's3PublicUrl'>, dev: boolean): SecurityPolicies {
  const options = cspOptionsFrom(config, dev)
  return {
    normal: buildCsp(options),
    noFrame: buildCsp({ ...options, frameAncestors: "'none'" }),
    docs: buildDocsCsp(),
    hsts: config.publicUrl.startsWith('https://'),
  }
}

/** The required headers of the response to `path` and the `frame-ancestors` source that its shell CSP keeps. */
export function securityHeadersFor(path: string, policies: SecurityPolicies): { headers: Record<string, string>; frameAncestors: string } {
  const noFrame = isNoFramePage(path)
  const headers: Record<string, string> = {
    'Content-Security-Policy': path === '/api/docs' ? policies.docs : noFrame ? policies.noFrame : policies.normal,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': PERMISSIONS_POLICY,
  }
  if (policies.hsts) headers['Strict-Transport-Security'] = HSTS
  if (noFrame || path.startsWith('/api/')) headers['Cache-Control'] = 'no-store'
  return { headers, frameAncestors: noFrame ? "'none'" : "'self'" }
}

/**
 * Sets the required headers before any handler runs, so static assets, the SPA shell, `/api` answers and errors all
 * carry them. The shell's nonce policy (render:html) reads `event.context.cspFrameAncestors`.
 */
export function applySecurityHeaders(event: H3Event, policies: SecurityPolicies): void {
  const { headers, frameAncestors } = securityHeadersFor(event.path.split('?')[0] ?? '/', policies)
  setResponseHeaders(event, headers)
  event.context.cspFrameAncestors = frameAncestors
}
