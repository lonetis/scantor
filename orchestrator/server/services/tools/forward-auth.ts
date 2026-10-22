import { TOOL_TARGETS, type ToolTarget } from '#shared/utils/enums'
import type { CachedUser } from '../../utils/user-cache'
import { cookieValues } from '../editor/cookie'
import { TOOLS_COOKIE_NAME, type ToolsSigner, verifyToolsJwt } from './cookie'

/*
 * Traefik forwardAuth for the admin GUIs (docs/auth.md §11, docs/api.md §4.18, security.md GUI-1). Traefik calls
 * `GET /api/tools/forward-auth` with the original request's cookies, `Accept` and the `X-Forwarded-*` headers it
 * built itself (`trustForwardHeader: false`). The decision:
 *
 *   1. `X-Forwarded-Host` must be one of the four tool hosts (`<target>.<SCANTOR_DOMAIN>`), else 401: the cookie must
 *      never authorise another router that is pointed at this endpoint.
 *   2. a `scantor_tools` cookie verifies (HS256, iss, aud, exp with 30 s leeway),
 *   3. its user exists, is an admin and is not banned (user cache, ≤ 30 s),
 *   4. → 200 with `X-Scantor-User`.
 *   Otherwise a browser navigation (`Accept` contains text/html) is redirected to createToolsSession for the tool,
 *   which mints a fresh cookie for a signed-in admin; every other request gets 401.
 */

export type ForwardAuthDecision =
  | { kind: 'allow'; userId: string; target: ToolTarget }
  | { kind: 'redirect'; location: string; target: ToolTarget }
  | { kind: 'deny'; reason: string }

export interface ForwardAuthRequest {
  forwardedHost: string | undefined
  accept: string | undefined
  cookie: string | string[] | undefined
}

export interface ForwardAuthDeps {
  publicUrl: string
  domain: string | null
  sign: ToolsSigner
  getUser: (userId: string) => Promise<CachedUser | null>
  isBanned: (user: CachedUser) => boolean
  nowMs?: number
}

/** The tool target of a forwarded host (`rabbitmq.<domain>[:port]` → `rabbitmq`), or null. */
export function toolTargetOfHost(forwardedHost: string | undefined, domain: string | null): ToolTarget | null {
  if (!forwardedHost || !domain || forwardedHost.includes(',')) return null
  const hostname = forwardedHost.trim().toLowerCase().replace(/:\d{1,5}$/, '')
  const suffix = `.${domain.toLowerCase()}`
  if (!hostname.endsWith(suffix)) return null
  const label = hostname.slice(0, -suffix.length)
  return (TOOL_TARGETS as readonly string[]).includes(label) ? (label as ToolTarget) : null
}

/** `<SCANTOR_PUBLIC_URL>/api/tools/session?target=<target>`, where browsers get a fresh tools cookie. */
export function toolsSessionUrl(publicUrl: string, target: ToolTarget): string {
  return `${publicUrl}/api/tools/session?target=${encodeURIComponent(target)}`
}

function isBrowserNavigation(accept: string | undefined): boolean {
  return !!accept && accept.toLowerCase().includes('text/html')
}

export async function decideForwardAuth(request: ForwardAuthRequest, deps: ForwardAuthDeps): Promise<ForwardAuthDecision> {
  const target = toolTargetOfHost(request.forwardedHost, deps.domain)
  if (!target) return { kind: 'deny', reason: 'not a tool host' }

  const nowMs = deps.nowMs ?? Date.now()
  let reason = 'no tools cookie'
  for (const value of cookieValues(request.cookie, TOOLS_COOKIE_NAME)) {
    const claims = verifyToolsJwt(value, deps.sign, nowMs)
    if (!claims) {
      reason = 'invalid or expired tools cookie'
      continue
    }
    const user = await deps.getUser(claims.sub)
    if (!user || user.role !== 'admin' || deps.isBanned(user)) {
      reason = 'the cookie\'s user is not an active admin'
      continue
    }
    return { kind: 'allow', userId: user.id, target }
  }
  if (isBrowserNavigation(request.accept)) return { kind: 'redirect', location: toolsSessionUrl(deps.publicUrl, target), target }
  return { kind: 'deny', reason }
}
