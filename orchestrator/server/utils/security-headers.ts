import { setResponseHeaders, type H3Event } from 'h3'
import type { RequestOrigin } from '#shared/utils/enums'
import { SCALAR_BUNDLE_URL } from './api-docs'
import type { Config } from './config'

// Dashboard security headers (security.md HDR-1..HDR-3, docs/ui.md §13). The policy depends on runtime origins
// (editor and S3 public URLs) and HSTS on the scheme of SCANTOR_PUBLIC_URL, so both are built once per request origin
// from the configuration. Through the tunnel URL (utils/tunnel.ts) the dashboard frames no editor and shows no S3
// previews, both of which are served only on the public origins, and HSTS is always on (the tunnel URL is https).
// server/plugins/security-headers.ts applies them to every response in Nitro's `request` hook and adds a per-response
// nonce to the SPA shell; `scriptSources` admits the shell's inline scripts.

/** Pages that must never be framed and never cached. */
export const NO_FRAME_PAGES = ['/login', '/setup', '/oauth/consent']

export const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)'

export const HSTS = 'max-age=31536000'

export interface CspOptions {
  /** the origin of the editor iframe; null frames nothing */
  editorOrigin: string | null
  /** the origin of presigned file previews; null admits no S3 images */
  s3PublicOrigin: string | null
  /** extra script-src sources, for example `'nonce-…'` */
  scriptSources?: string[]
  frameAncestors?: string
  /** development: Vite's client needs eval and websocket connections */
  dev?: boolean
}

export function buildCsp(options: CspOptions): string {
  const script = ["'self'", ...(options.scriptSources ?? []), ...(options.dev ? ["'unsafe-eval'", "'unsafe-inline'"] : [])]
  const connect = ["'self'", ...(options.dev ? ['ws:', 'wss:'] : [])]
  const img = ["'self'", 'data:', 'blob:', ...(options.s3PublicOrigin ? [options.s3PublicOrigin] : [])]
  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${img.join(' ')}`,
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    `frame-src ${options.editorOrigin ?? "'none'"}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${options.frameAncestors ?? "'self'"}`,
  ].join('; ')
}

/**
 * CSP of the Scalar UI at /api/docs (utils/api-docs.ts): the one script it admits beyond 'self' is the exact URL of the
 * pinned bundle (the page also checks its integrity hash), never a whole CDN origin. The bundle carries its styles
 * and loads its Inter and mono fonts from fonts.scalar.com.
 */
export function buildDocsCsp(): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${SCALAR_BUNDLE_URL}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data: https://fonts.scalar.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
  ].join('; ')
}

export function cspOptionsFrom(config: Pick<Config, 'editorUrl' | 's3PublicUrl'>, dev: boolean, origin: RequestOrigin = 'public'): CspOptions {
  if (origin === 'tunnel') return { editorOrigin: null, s3PublicOrigin: null, dev }
  return { editorOrigin: new URL(config.editorUrl).origin, s3PublicOrigin: new URL(config.s3PublicUrl).origin, dev }
}

export function isNoFramePage(path: string): boolean {
  return NO_FRAME_PAGES.some((page) => path === page || path.startsWith(`${page}/`))
}

/** The header values of one request origin of the deployment. */
export interface SecurityPolicies {
  normal: string
  noFrame: string
  docs: string
  /** the origin is https: always through the tunnel, otherwise when SCANTOR_PUBLIC_URL is */
  hsts: boolean
  /** the CSP sources, for the shell's per-response nonce policy */
  csp: CspOptions
}

export function securityPoliciesFrom(
  config: Pick<Config, 'publicUrl' | 'editorUrl' | 's3PublicUrl'>,
  dev: boolean,
  origin: RequestOrigin = 'public',
): SecurityPolicies {
  const options = cspOptionsFrom(config, dev, origin)
  return {
    normal: buildCsp(options),
    noFrame: buildCsp({ ...options, frameAncestors: "'none'" }),
    docs: buildDocsCsp(),
    hsts: origin === 'tunnel' || config.publicUrl.startsWith('https://'),
    csp: options,
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
