import { describe, expect, it } from 'vitest'
import {
  DISABLED_PATHS,
  isAllowedMcpRedirect,
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

describe('better-auth policy constants', () => {
  it('disables the documented HTTP endpoints exactly', () => {
    for (const path of ['/sign-up/email', '/token', '/api-key/create', '/admin/list-users', '/delete-user', '/sign-in/social']) {
      expect(DISABLED_PATHS).toContain(path)
    }
    expect(DISABLED_PATHS.every((path) => !path.includes('*'))).toBe(true)
  })

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
