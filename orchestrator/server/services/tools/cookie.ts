import { randomUUID } from 'node:crypto'
import { isUuid } from '#shared/utils/slug'
import { safeEqual } from '../../utils/keys'

/*
 * The admin-tools cookie `scantor_tools` (docs/auth.md §11): an HS256 JWT signed with key("tools-cookie"),
 *
 *   header {alg: "HS256", typ: "JWT"}
 *   claims {iss: "scantor", aud: "tools", sub: <userId>, role: "admin", iat, exp: iat + 28800, jti}
 *
 * set with `Domain=<SCANTOR_DOMAIN>` so Traefik's forwardAuth sees it on every tool host. Verification pins the
 * algorithm (the header must say HS256; `none` and every other algorithm are rejected), checks issuer and audience,
 * and allows 30 s of clock leeway on `exp`.
 */

export const TOOLS_COOKIE_NAME = 'scantor_tools'
export const TOOLS_COOKIE_TTL_S = 8 * 60 * 60
export const TOOLS_JWT_LEEWAY_S = 30
export const TOOLS_JWT_ISSUER = 'scantor'
export const TOOLS_JWT_AUDIENCE = 'tools'

/** HS256 signature (base64url) of a JWT signing input (server/utils/keys.ts `Keyring.toolsCookieSignature`). */
export type ToolsSigner = (signingInput: string) => string

export interface ToolsClaims {
  iss: string
  aud: string
  sub: string
  role: 'admin'
  iat: number
  exp: number
  jti: string
}

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeSegment(segment: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

/** Mints the JWT of a `scantor_tools` cookie for an admin. */
export function mintToolsJwt(
  userId: string,
  sign: ToolsSigner,
  options: { nowMs?: number; jti?: string } = {},
): { token: string; claims: ToolsClaims } {
  const iat = Math.floor((options.nowMs ?? Date.now()) / 1000)
  const claims: ToolsClaims = {
    iss: TOOLS_JWT_ISSUER,
    aud: TOOLS_JWT_AUDIENCE,
    sub: userId,
    role: 'admin',
    iat,
    exp: iat + TOOLS_COOKIE_TTL_S,
    jti: options.jti ?? randomUUID(),
  }
  const signingInput = `${encodeSegment({ alg: 'HS256', typ: 'JWT' })}.${encodeSegment(claims)}`
  return { token: `${signingInput}.${sign(signingInput)}`, claims }
}

/** Verifies a `scantor_tools` JWT; returns its claims or null. */
export function verifyToolsJwt(token: string, sign: ToolsSigner, nowMs = Date.now()): ToolsClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerSegment, claimsSegment, signature] = parts as [string, string, string]
  const header = decodeSegment(headerSegment) as { alg?: unknown; typ?: unknown } | null
  if (!header || typeof header !== 'object' || header.alg !== 'HS256') return null
  if (header.typ !== undefined && header.typ !== 'JWT') return null
  if (!safeEqual(signature, sign(`${headerSegment}.${claimsSegment}`))) return null

  const claims = decodeSegment(claimsSegment) as Partial<ToolsClaims> | null
  if (!claims || typeof claims !== 'object') return null
  if (claims.iss !== TOOLS_JWT_ISSUER || claims.aud !== TOOLS_JWT_AUDIENCE) return null
  if (typeof claims.sub !== 'string' || !isUuid(claims.sub)) return null
  if (typeof claims.exp !== 'number' || claims.exp + TOOLS_JWT_LEEWAY_S <= nowMs / 1000) return null
  if (claims.role !== 'admin') return null
  return claims as ToolsClaims
}

/** `Set-Cookie` of a fresh tools cookie (docs/auth.md §11 step 3). */
export function toolsCookieHeader(token: string, domain: string): string {
  return `${TOOLS_COOKIE_NAME}=${token}; Domain=${domain}; Path=/; Max-Age=${TOOLS_COOKIE_TTL_S}; Secure; HttpOnly; SameSite=Lax`
}
