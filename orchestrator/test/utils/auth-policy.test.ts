import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { admin } from 'better-auth/plugins'
import { describe, expect, it } from 'vitest'
import {
  AUTH_BASE_PATH,
  authHttpAllowlist,
  isAllowedMcpRedirect,
  isAuthHttpEndpoint,
  mcpLevelForScopes,
  RATE_LIMIT,
  rateLimitConfig,
  resolveMcpConfig,
  resolvePasskeyConfig,
  trustedOrigins,
} from '../../server/utils/auth-policy'

// Authentication policy derived from the configuration (docs/auth.md §2.5, §2.7, §4; docs/mcp.md §3.2, §3.4, §3.8).

describe('trustedOrigins', () => {
  it('is the public origin, plus loopback aliases for localhost', () => {
    expect(trustedOrigins({ publicUrl: 'https://scantor.example.com' })).toEqual(['https://scantor.example.com'])
    expect(trustedOrigins({ publicUrl: 'http://localhost:3000' })).toEqual(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])
    expect(trustedOrigins({ publicUrl: 'https://localhost' })).toEqual(['https://localhost', 'https://127.0.0.1', 'https://[::1]'])
  })
})

describe('resolvePasskeyConfig', () => {
  it.each([
    ['https://scantor.example.com', null, { enabled: true, rpID: 'scantor.example.com', origin: 'https://scantor.example.com' }],
    ['https://scantor.example.com:8443', 'example.com', { enabled: true, rpID: 'example.com', origin: 'https://scantor.example.com:8443' }],
    ['http://localhost:3000', null, { enabled: true, rpID: 'localhost', origin: 'http://localhost:3000' }],
    ['http://scantor.localhost', null, { enabled: true, rpID: 'scantor.localhost', origin: 'http://scantor.localhost' }],
    ['http://scantor.example.com', null, { enabled: false }],
    ['https://10.0.0.5', null, { enabled: false }],
    ['http://127.0.0.1:3000', null, { enabled: false }],
    ['http://[::1]:3000', null, { enabled: false }],
  ])('%s (rpID %s)', (publicUrl, passkeyRpId, expected) => {
    expect(resolvePasskeyConfig({ publicUrl, passkeyRpId })).toEqual(expected)
  })
})

describe('resolveMcpConfig', () => {
  it('turns MCP off entirely', () => {
    expect(resolveMcpConfig({ publicUrl: 'https://x.example.com', mcpEnabled: false })).toMatchObject({ enabled: false, oauth: false })
  })

  it('offers OAuth on https and loopback http only', () => {
    expect(resolveMcpConfig({ publicUrl: 'https://x.example.com', mcpEnabled: true })).toEqual({
      enabled: true,
      oauth: true,
      resource: 'https://x.example.com/mcp',
    })
    expect(resolveMcpConfig({ publicUrl: 'http://localhost:3000', mcpEnabled: true }).oauth).toBe(true)
    expect(resolveMcpConfig({ publicUrl: 'http://10.0.0.5:3000', mcpEnabled: true })).toMatchObject({ enabled: true, oauth: false })
    // @better-auth/mcp rejects http *.localhost resource URLs, so OAuth stays off there instead of failing the boot.
    expect(resolveMcpConfig({ publicUrl: 'http://scantor.localhost:3000', mcpEnabled: true })).toMatchObject({ enabled: true, oauth: false })
    expect(resolveMcpConfig({ publicUrl: 'http://127.0.0.1:3000', mcpEnabled: true }).oauth).toBe(true)
  })
})

describe('isAllowedMcpRedirect', () => {
  const allowed = ['https://connectors.example.com', 'https://localhost:8443']
  it.each([
    'http://localhost:53682/callback',
    'http://127.0.0.1/cb',
    'http://[::1]:9999/x',
    'https://connectors.example.com/oauth/callback',
    'cursor://anysphere.cursor-retrieval/oauth',
    'vscode://callback',
    'com.example.app:/oauth2redirect',
  ])('allows %s', (uri) => {
    expect(isAllowedMcpRedirect(uri, allowed)).toBe(true)
  })

  it.each([
    'https://evil.example.com/cb',
    // loopback redirects use http (RFC 8252 §8.3); better-auth refuses https loopback for every client type
    'https://localhost:8443/cb',
    'https://127.0.0.1:8443/cb',
    'https://[::1]:9999/x',
    'http://connectors.example.com/cb',
    'https://connectors.example.com.evil.com/cb',
    'http://localhost:3000/cb#frag',
    'http://user:pw@localhost/cb',
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///etc/passwd',
    'ws://localhost/cb',
    'about:blank',
    'not a url',
    'http://localhost.evil.com/cb',
  ])('rejects %s', (uri) => {
    expect(isAllowedMcpRedirect(uri, allowed)).toBe(false)
  })
})

describe('mcpLevelForScopes', () => {
  it.each([
    [['scantor:read'], 'admin', 'read'],
    [['scantor:read', 'scantor:write'], 'user', 'write'],
    [['scantor:admin'], 'user', 'write'],
    [['scantor:admin'], 'admin', 'admin'],
    [['openid', 'offline_access'], 'admin', null],
  ] as const)('%j for a %s → %s', (scopes, role, level) => {
    expect(mcpLevelForScopes(scopes, role)).toBe(level)
  })
})

describe('isAuthHttpEndpoint', () => {
  it.each([
    ['POST', '/api/auth/sign-in/email'],
    ['GET', '/api/auth/get-session'],
    ['POST', '/api/auth/get-session'],
    ['GET', '/api/auth/list-sessions'],
    ['POST', '/api/auth/revoke-sessions'],
    ['GET', '/api/auth/passkey/generate-authenticate-options'],
    ['POST', '/api/auth/passkey/delete-passkey'],
    ['GET', '/api/auth/oauth2/authorize'],
    ['POST', '/api/auth/oauth2/register'],
    ['POST', '/api/auth/oauth2/public-client-prelogin'],
    ['GET', '/api/auth/jwks'],
    ['GET', '/api/auth/error'],
    ['GET', '/api/auth/.well-known/openid-configuration'],
    ['HEAD', '/api/auth/.well-known/oauth-authorization-server'],
    ['GET', '/.well-known/oauth-protected-resource/mcp'],
    ['GET', '/.well-known/oauth-authorization-server/api/auth'],
    ['GET', '/.well-known/openid-configuration/api/auth'],
  ])('allows the documented %s %s', (method, path) => {
    expect(isAuthHttpEndpoint(method, path)).toBe(true)
  })

  it.each([
    // the endpoints the security suite found reachable with a session (AUTH-008)
    ['GET', '/api/auth/list-accounts'],
    ['POST', '/api/auth/revoke-other-sessions'],
    ['POST', '/api/auth/update-session'],
    ['POST', '/api/auth/verify-password'],
    ['GET', '/api/auth/ok'],
    ['GET', '/api/auth/oauth2/get-clients'],
    ['GET', '/api/auth/oauth2/get-client'],
    ['POST', '/api/auth/oauth2/create-client'],
    ['POST', '/api/auth/oauth2/update-client'],
    ['POST', '/api/auth/oauth2/delete-client'],
    ['POST', '/api/auth/oauth2/client/rotate-secret'],
    ['POST', '/api/auth/oauth2/client/rotate-keys'],
    ['GET', '/api/auth/oauth2/get-consents'],
    ['POST', '/api/auth/oauth2/delete-consent'],
    ['POST', '/api/auth/oauth2/end-session/confirm'],
    // what DISABLED_PATHS used to list, and parameterised routes it could not express
    ['POST', '/api/auth/sign-up/email'],
    ['GET', '/api/auth/token'],
    ['POST', '/api/auth/api-key/create'],
    ['GET', '/api/auth/admin/list-users'],
    ['POST', '/api/auth/delete-user'],
    ['POST', '/api/auth/sign-in/social'],
    ['GET', '/api/auth/reset-password/some-token'],
    ['GET', '/api/auth/callback/github'],
    // other methods and spellings of allowed endpoints
    ['GET', '/api/auth/sign-in/email'],
    ['DELETE', '/api/auth/get-session'],
    ['POST', '/api/auth/oauth2/authorize'],
    ['GET', '/api/auth/get-session/'],
    ['GET', '/api/auth/get%2Dsession'],
    ['GET', '/api/auth/GET-SESSION'],
    ['GET', '/api/auth//get-session'],
    ['GET', '/api/auth'],
    ['GET', '/api/auth/'],
    ['GET', '/api/auth/constructor'],
    ['GET', '/api/auth/__proto__'],
    ['POST', '/.well-known/openid-configuration/api/auth'],
    ['GET', '/.well-known/oauth-protected-resource'],
    ['GET', '/somewhere-else'],
  ])('denies %s %s', (method, path) => {
    expect(isAuthHttpEndpoint(method, path)).toBe(false)
  })
})

describe('authHttpAllowlist', () => {
  // A better-auth instance with the plugin, the admin plugin and an in-memory database: the allowlist acts on what
  // better-auth routes, while server-side auth.api calls bypass it.
  function auth() {
    return betterAuth({
      baseURL: 'http://localhost:3000',
      basePath: AUTH_BASE_PATH,
      secret: 'a-test-secret-that-is-long-enough-for-better-auth',
      database: memoryAdapter({}),
      telemetry: { enabled: false },
      emailAndPassword: { enabled: true, disableSignUp: true },
      plugins: [authHttpAllowlist(), admin()],
      logger: { disabled: true },
    })
  }

  it('answers 404 notFound for an endpoint outside the allowlist', async () => {
    for (const path of ['/api/auth/ok', '/api/auth/list-accounts', '/api/auth/admin/list-users', '/.well-known/x/../../api/auth/ok']) {
      const response = await auth().handler(new Request(`http://localhost:3000${path}`))
      expect(response.status, path).toBe(404)
      expect(await response.json(), path).toMatchObject({ error: { code: 'notFound' } })
      expect(response.headers.get('cache-control'), path).toBe('no-store')
    }
  })

  it('passes allowed endpoints through to better-auth', async () => {
    const response = await auth().handler(new Request('http://localhost:3000/api/auth/get-session'))
    expect(response.status).toBe(200)
    expect(await response.json()).toBeNull()
  })

  it('leaves server-side calls alone', async () => {
    await expect(auth().api.ok()).resolves.toEqual({ ok: true })
  })
})

describe('better-auth policy constants', () => {
  it('limits sign-in to 10 per minute per IP', () => {
    expect(RATE_LIMIT.enabled).toBe(true)
    expect(RATE_LIMIT.customRules['/sign-in/email']).toEqual({ window: 60, max: 10 })
    expect(rateLimitConfig(1)).toEqual(RATE_LIMIT)
    const scaled = rateLimitConfig(50)
    expect(scaled.max).toBe(RATE_LIMIT.max * 50)
    expect(scaled.customRules['/sign-in/email']).toEqual({ window: 60, max: 500 })
    expect(RATE_LIMIT.customRules['/sign-in/email'].max).toBe(10)
  })
})
