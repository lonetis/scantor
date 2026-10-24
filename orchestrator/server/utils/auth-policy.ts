import { isIP } from 'node:net'
import type { Config } from './config'

// Pure authentication policy derived from the configuration (docs/auth.md §2.5, §2.7, §4, docs/mcp.md §3.4, §3.8).
// server/utils/auth.ts builds better-auth from it; the middleware and the MCP endpoint use the same functions.

export const MCP_SCOPES = ['scantor:read', 'scantor:write', 'scantor:admin'] as const
export const OAUTH_SCOPES = ['openid', 'profile', 'email', 'offline_access', ...MCP_SCOPES]
export const MCP_CHALLENGE_SCOPES = ['offline_access', ...MCP_SCOPES]

/** better-auth endpoints disabled over HTTP (exact paths; server-side `auth.api.*` calls still work). */
export const DISABLED_PATHS = [
  '/sign-up/email',
  '/token',
  '/api-key/create',
  '/api-key/update',
  '/api-key/delete',
  '/api-key/get',
  '/api-key/list',
  '/admin/ban-user',
  '/admin/create-user',
  '/admin/get-user',
  '/admin/has-permission',
  '/admin/impersonate-user',
  '/admin/list-user-sessions',
  '/admin/list-users',
  '/admin/remove-user',
  '/admin/revoke-user-session',
  '/admin/revoke-user-sessions',
  '/admin/set-role',
  '/admin/set-user-password',
  '/admin/stop-impersonating',
  '/admin/unban-user',
  '/admin/update-user',
  '/delete-user',
  '/delete-user/callback',
  '/request-password-reset',
  '/reset-password',
  '/send-verification-email',
  '/verify-email',
  '/sign-in/social',
  '/link-social',
  '/unlink-account',
  '/get-access-token',
  '/refresh-token',
  '/account-info',
]

/** better-auth rate limits (docs/auth.md §2.7), on in every environment. */
export const RATE_LIMIT = {
  enabled: true,
  storage: 'memory' as const,
  window: 60,
  max: 300,
  customRules: {
    '/sign-in/email': { window: 60, max: 10 },
    '/passkey/verify-authentication': { window: 60, max: 20 },
    '/change-password': { window: 60, max: 5 },
    '/change-email': { window: 60, max: 5 },
    '/oauth2/register': { window: 60, max: 10 },
  },
}

/**
 * The better-auth rate limits with every maximum multiplied by SCANTOR_AUTH_RATE_LIMIT_SCALE. Production keeps 1;
 * the dockerized test stack raises it because the whole suite reaches the orchestrator from one client IP.
 */
export function rateLimitConfig(scale: number): typeof RATE_LIMIT {
  const customRules = Object.fromEntries(
    Object.entries(RATE_LIMIT.customRules).map(([path, rule]) => [path, { window: rule.window, max: rule.max * scale }]),
  ) as typeof RATE_LIMIT.customRules
  return { ...RATE_LIMIT, max: RATE_LIMIT.max * scale, customRules }
}

/**
 * The origins trusted for CSRF and better-auth (docs/auth.md §4.2): the public origin plus, when its host is
 * `localhost`, the `127.0.0.1` and `[::1]` aliases with the same scheme and port. Never the editor origin.
 */
export function trustedOrigins(config: Pick<Config, 'publicUrl'>): string[] {
  const url = new URL(config.publicUrl)
  const origins = [url.origin]
  if (url.hostname === 'localhost') {
    const port = url.port ? `:${url.port}` : ''
    origins.push(`${url.protocol}//127.0.0.1${port}`, `${url.protocol}//[::1]${port}`)
  }
  return origins
}

export interface PasskeyConfig {
  enabled: boolean
  rpID?: string
  origin?: string
}

/**
 * Passkeys need a secure context and a domain RP ID (docs/auth.md §4.4): enabled for https domain names and for
 * http on `localhost` / `*.localhost`; disabled for any other http host and for IP literals.
 */
export function resolvePasskeyConfig(config: Pick<Config, 'publicUrl' | 'passkeyRpId'>): PasskeyConfig {
  const url = new URL(config.publicUrl)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) !== 0) return { enabled: false }
  const local = host === 'localhost' || host.endsWith('.localhost')
  if (url.protocol !== 'https:' && !local) return { enabled: false }
  return { enabled: true, rpID: config.passkeyRpId ?? host, origin: url.origin }
}

export interface McpConfig {
  /** `/mcp` is served */
  enabled: boolean
  /** the OAuth authorization server (mcp, jwt, cimd plugins and discovery) is available */
  oauth: boolean
  /** `${SCANTOR_PUBLIC_URL}/mcp` */
  resource: string
  disabledReason?: string
}

/** docs/mcp.md §3.8. */
/**
 * The loopback hosts @better-auth/mcp accepts for an http resource URL: exactly `localhost`, `[::1]` and
 * 127.0.0.0/8. Narrower than the startup guard's rule, which also counts `*.localhost`; with such a host the plugin
 * throws at initialisation, so MCP then stays on API keys only instead of failing the boot.
 */
export function isMcpLoopbackHost(hostname: string): boolean {
  const octets = hostname.split('.')
  const ipv4Loopback = octets.length === 4 && octets[0] === '127' && octets.every((octet) => /^\d+$/.test(octet) && Number(octet) <= 255)
  return hostname === 'localhost' || hostname === '[::1]' || ipv4Loopback
}

export function resolveMcpConfig(config: Pick<Config, 'publicUrl' | 'mcpEnabled'>): McpConfig {
  const resource = `${config.publicUrl}/mcp`
  if (!config.mcpEnabled) return { enabled: false, oauth: false, resource, disabledReason: 'SCANTOR_MCP_ENABLED=false' }
  const url = new URL(config.publicUrl)
  if (url.protocol !== 'https:' && !isMcpLoopbackHost(url.hostname)) {
    return {
      enabled: true,
      oauth: false,
      resource,
      disabledReason: `MCP OAuth needs an https SCANTOR_PUBLIC_URL (or a loopback host); /mcp accepts API keys only`,
    }
  }
  return { enabled: true, oauth: true, resource }
}

const FORBIDDEN_PRIVATE_SCHEMES = new Set(['http:', 'https:', 'javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:', 'ftp:', 'ws:', 'wss:'])

/**
 * The MCP redirect URI policy (docs/mcp.md §3.4): an absolute URL without fragment or userinfo that is (1) an http
 * loopback URL, (2) an https URL of an operator-listed origin, or (3) a private-use scheme. An https loopback URL is
 * refused even when listed: loopback redirects use http (RFC 8252 §7.3, §8.3), and better-auth's oauth-provider refuses
 * https loopback redirect URIs for every client type, so the policy rejects them with its own error first.
 */
export function isAllowedMcpRedirect(uri: string, allowedOrigins: readonly string[]): boolean {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return false
  }
  if (url.hash || uri.includes('#') || url.username || url.password) return false
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    const host = url.hostname
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return url.protocol === 'http:'
    return url.protocol === 'https:' && allowedOrigins.includes(url.origin)
  }
  if (!/^[a-z][a-z0-9+.-]*:$/.test(url.protocol)) return false
  return !FORBIDDEN_PRIVATE_SCHEMES.has(url.protocol)
}

/** The MCP access level of a set of granted OAuth scopes (docs/mcp.md §3.2); null when no scantor scope. */
export function mcpLevelForScopes(scopes: readonly string[], role: 'admin' | 'user'): 'read' | 'write' | 'admin' | null {
  const granted = new Set(scopes)
  if (granted.has('scantor:admin') && role === 'admin') return 'admin'
  if (granted.has('scantor:write') || granted.has('scantor:admin')) return 'write'
  if (granted.has('scantor:read')) return 'read'
  return null
}
