import type { ApiKeyConfigId, EndpointProfile, McpLevel, UserRole, WorkerRole } from '#shared/utils/enums'

// Typed principals (docs/auth.md §5.1). The global middleware (server/middleware/10.auth.ts) stores exactly one
// of them in `event.context.principal`; nothing else in `event.context` carries identity. Route handlers read it
// only through the helpers of server/utils/authz.ts.

export interface UserRef {
  id: string
  email: string
  name: string
  role: UserRole
}

export interface UserPrincipal {
  kind: 'user'
  via: 'session' | 'apiKey' | 'mcp'
  user: UserRef
  /** effective admin power for this request (docs/auth.md §5.6) */
  isAdmin: boolean
  /** via session */
  sessionId?: string
  /** session creation time (passkey freshness guard) */
  sessionCreatedAt?: Date
  /** via apiKey (also inside mcp via an API key) */
  apiKey?: { id: string; configId: ApiKeyConfigId }
  /** via mcp */
  mcp?: { clientId: string | null; level: McpLevel; operationId: string }
}

export interface NodePrincipal {
  kind: 'node'
  node: { id: string; name: string; builtIn: boolean; endpointProfile: EndpointProfile; pool: string }
}

export interface WorkerPrincipal {
  kind: 'worker'
  worker: { id: string; scanId: string; userId: string; role: WorkerRole; nodeId: string; epoch: number }
}

/** The registry `orchestrator` credential; token route only (nodes use NodePrincipal there). */
export interface RegistryPrincipal {
  kind: 'registry'
  subject: 'orchestrator'
}

export interface ToolsPrincipal {
  kind: 'tools'
  user: UserRef
}

export interface SetupPrincipal {
  kind: 'setup'
}

export type Principal = UserPrincipal | NodePrincipal | WorkerPrincipal | RegistryPrincipal | ToolsPrincipal | SetupPrincipal

// ── credentials ─────────────────────────────────────────────────────────────

export const DEFAULT_API_KEY_PREFIX = 'sk_scantor_'
export const EDITOR_API_KEY_PREFIX = 'sk_scantor_editor_'
export const DEFAULT_API_KEY_PATTERN = /^sk_scantor_[A-Za-z]{64}$/
export const EDITOR_API_KEY_PATTERN = /^sk_scantor_editor_[A-Za-z]{64}$/
export const INTERNAL_CAPABILITY_PATTERN = /^sic_[A-Za-z0-9_-]{43}$/
export const SESSION_COOKIE_NAMES = ['scantor.session_token', '__Secure-scantor.session_token']

/** The value of `Authorization: Bearer <value>`, or null. */
export function bearerValue(authorization: string | undefined | null): string | null {
  if (!authorization) return null
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization)
  return match ? match[1]! : null
}

/** True for any value shaped like a scantor API key (`sk_scantor_…`), valid or not. */
export function looksLikeApiKey(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(DEFAULT_API_KEY_PREFIX)
}

/** `editor` iff the key has the editor prefix shape, else `default`. */
export function apiKeyConfigIdOf(key: string): ApiKeyConfigId {
  return EDITOR_API_KEY_PATTERN.test(key) ? 'editor' : 'default'
}

export type UserCredential =
  | { kind: 'internal'; token: string }
  | { kind: 'apiKey'; key: string }
  | { kind: 'session'; cookie: string }
  /** an explicit credential that can never be valid on user routes (for example an OAuth bearer) */
  | { kind: 'invalid' }
  | { kind: 'none' }

export interface CredentialHeaders {
  internalAuth?: string | null
  apiKey?: string | null
  authorization?: string | null
  cookie?: string | null
}

function hasSessionCookie(cookie: string): boolean {
  return cookie.split(';').some((part) => SESSION_COOKIE_NAMES.includes(part.split('=')[0]!.trim()))
}

/**
 * Classifies the credential of a user route by precedence (docs/auth.md §5.2): internal capability, then API key,
 * then session cookie. An explicit credential alone decides; a Bearer value that is not an API key is invalid.
 */
export function classifyUserCredential(headers: CredentialHeaders): UserCredential {
  if (headers.internalAuth) return { kind: 'internal', token: headers.internalAuth }
  if (headers.apiKey) return { kind: 'apiKey', key: headers.apiKey }
  if (headers.authorization) {
    const bearer = bearerValue(headers.authorization)
    if (bearer && looksLikeApiKey(bearer)) return { kind: 'apiKey', key: bearer }
    return { kind: 'invalid' }
  }
  if (headers.cookie && hasSessionCookie(headers.cookie)) return { kind: 'session', cookie: headers.cookie }
  return { kind: 'none' }
}

/**
 * Effective admin power (docs/auth.md §5.6): an admin, except through an `editor` API key or an MCP grant below
 * the `admin` level.
 */
export function effectiveAdmin(
  role: UserRole,
  via: UserPrincipal['via'],
  apiKeyConfigId?: ApiKeyConfigId,
  mcpLevel?: McpLevel,
): boolean {
  if (role !== 'admin') return false
  if (via === 'apiKey' && apiKeyConfigId === 'editor') return false
  if (via === 'mcp' && mcpLevel !== 'admin') return false
  return true
}

export function toUserRole(role: unknown): UserRole {
  return role === 'admin' ? 'admin' : 'user'
}
