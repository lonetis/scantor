import { safeEqual } from '../../utils/keys'

/*
 * The `scantor_editor` cookie (docs/editor.md §8.4, docs/auth.md §12):
 *
 *   v1.<userId>.<editorStartedAtMs>.<expiresAtMs>.<mac>
 *   mac = base64url(HMAC-SHA256(key("editor-cookie"), "v1.<userId>.<editorStartedAtMs>.<expiresAtMs>"))
 *
 * Host-only on the editor origin, `HttpOnly; Path=/; SameSite=Lax; Max-Age=43200`, plus `Secure` when the editor
 * URL is https. The MAC alone proves nothing about the editor: the caller also checks the user (exists, not banned)
 * and that the user's editor is starting or running with exactly this `startedAt` (server/services/editor/sessions.ts).
 */

export const EDITOR_COOKIE_NAME = 'scantor_editor'
export const EDITOR_COOKIE_TTL_MS = 12 * 60 * 60 * 1000

const COOKIE_PATTERN = /^v1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{1,15})\.(\d{1,15})\.[A-Za-z0-9_-]{43}$/

/** Produces the full cookie value for the claims (server/utils/keys.ts `Keyring.editorCookie`). */
export type EditorCookieSigner = (userId: string, editorStartedAtMs: number, expiresAtMs: number) => string

export interface EditorCookieClaims {
  userId: string
  editorStartedAtMs: number
  expiresAtMs: number
}

/**
 * Parses and verifies a cookie value: the shape, the MAC (constant-time, against a freshly signed value of the same
 * claims) and `expiresAtMs > now`. Returns null for anything else.
 */
export function verifyEditorCookie(value: string, sign: EditorCookieSigner, now = Date.now()): EditorCookieClaims | null {
  const match = COOKIE_PATTERN.exec(value)
  if (!match) return null
  const claims: EditorCookieClaims = { userId: match[1]!, editorStartedAtMs: Number(match[2]), expiresAtMs: Number(match[3]) }
  if (!safeEqual(value, sign(claims.userId, claims.editorStartedAtMs, claims.expiresAtMs))) return null
  if (claims.expiresAtMs <= now) return null
  return claims
}

/** The `Set-Cookie` value that stores `value` on the editor origin. */
export function editorCookieHeader(value: string, secure: boolean): string {
  const maxAge = Math.floor(EDITOR_COOKIE_TTL_MS / 1000)
  return `${EDITOR_COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}

/**
 * Every value of the cookie `name` in a `Cookie` request header, in header order. A browser can send several
 * cookies of one name (a host-only one and one tossed from a sibling host); callers try them in order.
 */
export function cookieValues(header: string | string[] | undefined, name: string): string[] {
  if (!header) return []
  const lines = Array.isArray(header) ? header : [header]
  const values: string[] = []
  for (const line of lines) {
    for (const pair of line.split(';')) {
      const separator = pair.indexOf('=')
      if (separator < 0) continue
      if (pair.slice(0, separator).trim() !== name) continue
      values.push(pair.slice(separator + 1).trim())
    }
  }
  return values
}
