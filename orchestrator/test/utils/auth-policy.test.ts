import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { admin } from 'better-auth/plugins'
import { describe, expect, it } from 'vitest'
import {
  anyMcpOAuth,
  AUTH_BASE_PATH,
  authHttpAllowlist,
  configuredOrigins,
  dataAuthOrigin,
  isAllowedMcpRedirect,
  isAuthHttpEndpoint,
  isAuthRootDiscoveryEndpoint,
  isRpIdFor,
  mcpLevelForScopes,
  mcpOAuthResources,
  RATE_LIMIT,
  rateLimitConfig,
  resolveMcpConfig,
  resolvePasskeyConfig,
  trustedOrigins,
} from '../../server/utils/auth-policy'

// Authentication policy derived from the configuration (docs/auth.md §2.5, §2.7, §4; docs/mcp.md §3.2, §3.4, §3.8).

const TUNNEL = 'https://tunnel.example.org'

describe('configuredOrigins and dataAuthOrigin', () => {
  it('serves the public URL, plus the tunnel URL when set', () => {
    expect(configuredOrigins({ tunnelUrl: null })).toEqual(['public'])
    expect(configuredOrigins({ tunnelUrl: TUNNEL })).toEqual(['public', 'tunnel'])
  })

  it('does the database work on the tunnel instance when there is one, whose plugins are a superset', () => {
    expect(dataAuthOrigin({ tunnelUrl: null })).toBe('public')
    expect(dataAuthOrigin({ tunnelUrl: TUNNEL })).toBe('tunnel')
  })
})

describe('trustedOrigins', () => {
  it('is the public origin, plus loopback aliases for localhost', () => {
    expect(trustedOrigins({ publicUrl: 'https://scantor.example.com', tunnelUrl: null })).toEqual(['https://scantor.example.com'])
    expect(trustedOrigins({ publicUrl: 'http://localhost:3000', tunnelUrl: null })).toEqual([
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
    ])
    expect(trustedOrigins({ publicUrl: 'https://localhost', tunnelUrl: null })).toEqual(['https://localhost', 'https://127.0.0.1', 'https://[::1]'])
  })

  it('trusts only its own origin per origin, never both (docs/auth.md §4.2)', () => {
    const config = { publicUrl: 'http://localhost:3000', tunnelUrl: 'https://tunnel.example.org:8443' }
    expect(trustedOrigins(config, 'tunnel')).toEqual(['https://tunnel.example.org:8443'])
    expect(trustedOrigins(config, 'public')).toEqual(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])
    expect(trustedOrigins(config)).toEqual(trustedOrigins(config, 'public'))
    expect(trustedOrigins(config, 'public')).not.toContain('https://tunnel.example.org:8443')
  })

  it('has no tunnel origin without SCANTOR_TUNNEL_URL', () => {
    expect(() => trustedOrigins({ publicUrl: 'https://scantor.example.com', tunnelUrl: null }, 'tunnel')).toThrow('SCANTOR_TUNNEL_URL')
  })
})

describe('isRpIdFor', () => {
  it.each([
    ['scantor.example.com', 'scantor.example.com', true],
    ['example.com', 'scantor.example.com', true],
    ['example.com', 'a.b.example.com', true],
    ['localhost', 'localhost', true],
    ['com', 'scantor.example.com', false],
    ['other.com', 'scantor.example.com', false],
    ['ample.com', 'scantor.example.com', false],
    ['scantor.example.com', 'example.com', false],
    ['example.com', 'example.com.evil.org', false],
  ])('%s for %s → %s', (rpId, host, expected) => {
    expect(isRpIdFor(rpId, host)).toBe(expected)
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
    expect(resolvePasskeyConfig({ publicUrl, tunnelUrl: null, passkeyRpId })).toEqual(expected)
  })

  it.each([
    // a shared RP ID where it is a registrable suffix of the tunnel host: passkeys work on both origins
    ['https://tunnel.example.com', 'example.com', { enabled: true, rpID: 'example.com', origin: 'https://tunnel.example.com' }],
    // otherwise the tunnel host: passkeys registered on one origin do not work on the other
    ['https://tunnel.example.org', 'example.com', { enabled: true, rpID: 'tunnel.example.org', origin: 'https://tunnel.example.org' }],
    ['https://tunnel.example.org:8443', null, { enabled: true, rpID: 'tunnel.example.org', origin: 'https://tunnel.example.org:8443' }],
    [
      'https://scantor.example.com.evil.org',
      'example.com',
      { enabled: true, rpID: 'scantor.example.com.evil.org', origin: 'https://scantor.example.com.evil.org' },
    ],
  ])('the tunnel origin %s (rpID %s)', (tunnelUrl, passkeyRpId, expected) => {
    const config = { publicUrl: 'https://scantor.example.com', tunnelUrl, passkeyRpId }
    expect(resolvePasskeyConfig(config, 'tunnel')).toEqual(expected)
    // The public origin is unchanged by the tunnel.
    expect(resolvePasskeyConfig(config, 'public')).toEqual(resolvePasskeyConfig({ ...config, tunnelUrl: null }))
  })

  it('enables passkeys on an https tunnel even when the public URL cannot have them', () => {
    const config = { publicUrl: 'http://10.0.0.5:3000', tunnelUrl: TUNNEL, passkeyRpId: null }
    expect(resolvePasskeyConfig(config)).toEqual({ enabled: false })
    expect(resolvePasskeyConfig(config, 'tunnel')).toEqual({ enabled: true, rpID: 'tunnel.example.org', origin: TUNNEL })
  })
})

describe('resolveMcpConfig', () => {
  it('turns MCP off entirely', () => {
    expect(resolveMcpConfig({ publicUrl: 'https://x.example.com', tunnelUrl: null, mcpEnabled: false })).toMatchObject({ enabled: false, oauth: false })
  })

  it('offers OAuth on https and loopback http only', () => {
    expect(resolveMcpConfig({ publicUrl: 'https://x.example.com', tunnelUrl: null, mcpEnabled: true })).toEqual({
      enabled: true,
      oauth: true,
      resource: 'https://x.example.com/mcp',
    })
    expect(resolveMcpConfig({ publicUrl: 'http://localhost:3000', tunnelUrl: null, mcpEnabled: true }).oauth).toBe(true)
    expect(resolveMcpConfig({ publicUrl: 'http://10.0.0.5:3000', tunnelUrl: null, mcpEnabled: true })).toMatchObject({ enabled: true, oauth: false })
    // @better-auth/mcp rejects http *.localhost resource URLs, so OAuth stays off there instead of failing the boot.
    expect(resolveMcpConfig({ publicUrl: 'http://scantor.localhost:3000', tunnelUrl: null, mcpEnabled: true })).toMatchObject({ enabled: true, oauth: false })
    expect(resolveMcpConfig({ publicUrl: 'http://127.0.0.1:3000', tunnelUrl: null, mcpEnabled: true }).oauth).toBe(true)
  })

  it('names the resource and the variable of each origin', () => {
    const config = { publicUrl: 'http://10.0.0.5:3000', tunnelUrl: TUNNEL, mcpEnabled: true }
    expect(resolveMcpConfig(config, 'tunnel')).toEqual({ enabled: true, oauth: true, resource: `${TUNNEL}/mcp` })
    expect(resolveMcpConfig(config, 'public')).toEqual({
      enabled: true,
      oauth: false,
      resource: 'http://10.0.0.5:3000/mcp',
      disabledReason: 'MCP OAuth needs an https SCANTOR_PUBLIC_URL (or a loopback host); /mcp accepts API keys only',
    })
    // config.ts admits only https tunnel URLs; the policy still names the tunnel's variable for any other one.
    expect(resolveMcpConfig({ ...config, tunnelUrl: 'http://tunnel.example.org' }, 'tunnel').disabledReason).toBe(
      'MCP OAuth needs an https SCANTOR_TUNNEL_URL (or a loopback host); /mcp accepts API keys only',
    )
    expect(resolveMcpConfig({ ...config, mcpEnabled: false }, 'tunnel')).toEqual({
      enabled: false,
      oauth: false,
      resource: `${TUNNEL}/mcp`,
      disabledReason: 'SCANTOR_MCP_ENABLED=false',
    })
    expect(() => resolveMcpConfig({ ...config, tunnelUrl: null }, 'tunnel')).toThrow('SCANTOR_TUNNEL_URL')
  })
})

describe('anyMcpOAuth', () => {
  it.each([
    ['an https public URL', { publicUrl: 'https://scantor.example.com', tunnelUrl: null, mcpEnabled: true }, true],
    ['an http public URL alone', { publicUrl: 'http://10.0.0.5:3000', tunnelUrl: null, mcpEnabled: true }, false],
    ['an http public URL with an https tunnel URL', { publicUrl: 'http://10.0.0.5:3000', tunnelUrl: TUNNEL, mcpEnabled: true }, true],
    ['MCP turned off', { publicUrl: 'https://scantor.example.com', tunnelUrl: TUNNEL, mcpEnabled: false }, false],
  ])('%s → %s', (_name, config, expected) => {
    expect(anyMcpOAuth(config)).toBe(expected)
  })
})

describe('mcpOAuthResources', () => {
  it.each([
    ['an https public URL', { publicUrl: 'https://scantor.example.com', tunnelUrl: null, mcpEnabled: true }, ['https://scantor.example.com/mcp']],
    [
      'an https public URL and a tunnel URL',
      { publicUrl: 'https://scantor.example.com', tunnelUrl: TUNNEL, mcpEnabled: true },
      ['https://scantor.example.com/mcp', `${TUNNEL}/mcp`],
    ],
    ['an http public URL with an https tunnel URL', { publicUrl: 'http://10.0.0.5:3000', tunnelUrl: TUNNEL, mcpEnabled: true }, [`${TUNNEL}/mcp`]],
    ['MCP turned off', { publicUrl: 'https://scantor.example.com', tunnelUrl: TUNNEL, mcpEnabled: false }, []],
  ])('%s → %j', (_name, config, expected) => {
    expect(mcpOAuthResources(config)).toEqual(expected)
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

describe('isAuthRootDiscoveryEndpoint', () => {
  it('admits only the three discovery documents with GET or HEAD', () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server/api/auth', '/.well-known/openid-configuration/api/auth']) {
      expect(isAuthRootDiscoveryEndpoint('GET', path), path).toBe(true)
      expect(isAuthRootDiscoveryEndpoint('HEAD', path), path).toBe(true)
      expect(isAuthRootDiscoveryEndpoint('POST', path), path).toBe(false)
    }
    // Paths the root route must never forward, among them the ones a dot-segment spelling resolves to.
    for (const path of ['/api/auth/passkey/generate-register-options', '/api/auth/oauth2/authorize', '/api/auth/get-session', '/.well-known/x', '/']) {
      expect(isAuthRootDiscoveryEndpoint('GET', path), path).toBe(false)
    }
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
