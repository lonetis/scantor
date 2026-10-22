import { useAuth, useAuthContext } from '../../utils/auth'
import { mcpLevelForScopes } from '../../utils/auth-policy'
import { apiKeyConfigIdOf, bearerValue, DEFAULT_API_KEY_PATTERN, EDITOR_API_KEY_PATTERN, effectiveAdmin, toUserRole, type UserPrincipal } from '../../utils/principal'
import { isUserBanned, toCachedUser } from '../../utils/user-cache'
import { hasOAuthConsent } from '../../utils/users'

/** The verified claims of an MCP access token. */
export interface AccessTokenClaims {
  sub?: string
  scope?: unknown
  client_id?: unknown
  azp?: unknown
  [claim: string]: unknown
}

// Authentication of `/mcp` (docs/mcp.md §3): OAuth access tokens verified by requireMcpAuth (in server.ts) and
// re-checked per request (user exists, not banned, consent exists), or scantor API keys (level `write`, `admin` for
// an admin's `default` key). Both become user principals `via: 'mcp'`.

/** The API key of an `/mcp` request (`x-api-key` or `Authorization: Bearer sk_scantor_…`), if any. */
export function mcpApiKeyOf(headers: Headers): string | null {
  const header = headers.get('x-api-key')
  if (header) return header
  const bearer = bearerValue(headers.get('authorization'))
  return bearer && bearer.startsWith('sk_scantor_') ? bearer : null
}

/** Resolves an API key to an MCP principal, or null when invalid, expired or banned. */
export async function principalFromApiKey(key: string): Promise<UserPrincipal | null> {
  if (!DEFAULT_API_KEY_PATTERN.test(key) && !EDITOR_API_KEY_PATTERN.test(key)) return null
  const session = (await useAuth()
    .api.getSession({ headers: new Headers({ 'x-api-key': key }) })
    .catch(() => null)) as { session: { id: string }; user: Record<string, unknown> } | null
  if (!session || isUserBanned(toCachedUser(session.user))) return null
  const configId = apiKeyConfigIdOf(key)
  const role = toUserRole(session.user.role)
  const level = role === 'admin' && configId === 'default' ? 'admin' : 'write'
  return {
    kind: 'user',
    via: 'mcp',
    user: { id: String(session.user.id), email: String(session.user.email ?? ''), name: String(session.user.name ?? ''), role },
    isAdmin: effectiveAdmin(role, 'mcp', configId, level),
    apiKey: { id: String(session.session.id), configId },
    mcp: { clientId: null, level, operationId: '' },
  }
}

export function tokenClientId(claims: AccessTokenClaims): string {
  return String(claims.client_id ?? claims.azp ?? '')
}

export function tokenScopes(claims: AccessTokenClaims): string[] {
  return typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : []
}

/**
 * Per-request checks of an OAuth access token (docs/mcp.md §3.6): the user exists and is not banned, the client
 * still has a consent row, and the level follows from the scopes and the user's role.
 */
export async function principalFromToken(claims: AccessTokenClaims): Promise<UserPrincipal | null> {
  if (!claims.sub) return null
  const ctx = await useAuthContext()
  const user = (await ctx.internalAdapter.findUserById(claims.sub)) as Record<string, unknown> | null
  if (!user || isUserBanned(toCachedUser(user))) return null
  const clientId = tokenClientId(claims)
  if (!clientId || !(await hasOAuthConsent(String(user.id), clientId))) return null
  const role = toUserRole(user.role)
  const level = mcpLevelForScopes(tokenScopes(claims), role)
  if (!level) return null
  return {
    kind: 'user',
    via: 'mcp',
    user: { id: String(user.id), email: String(user.email ?? ''), name: String(user.name ?? ''), role },
    isAdmin: effectiveAdmin(role, 'mcp', undefined, level),
    mcp: { clientId, level, operationId: '' },
  }
}
