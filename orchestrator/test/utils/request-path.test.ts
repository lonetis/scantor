import { describe, expect, it } from 'vitest'
import { isCanonicalPath, rawPathOf, resolvedPathname } from '../../server/utils/request-path'

// Canonical request paths (docs/auth.md §1, security.md AUTH-5): the raw path must equal the path a URL parser
// (h3's getRequestURL, better-auth) makes of it.

describe('rawPathOf', () => {
  it('drops the query string', () => {
    expect(rawPathOf('/api/scans?wait=5')).toBe('/api/scans')
    expect(rawPathOf('/')).toBe('/')
    expect(rawPathOf(undefined)).toBe('/')
    expect(rawPathOf('?x=1')).toBe('/')
  })
})

describe('resolvedPathname', () => {
  it('resolves what the router keeps', () => {
    expect(resolvedPathname('/.well-known/x/../../api/auth/get-session')).toBe('/api/auth/get-session')
    expect(resolvedPathname('/api/auth/passkey/./delete-passkey')).toBe('/api/auth/passkey/delete-passkey')
    expect(resolvedPathname('/api/auth/passkey/%2e/verify-registration')).toBe('/api/auth/passkey/verify-registration')
    expect(resolvedPathname('/.well-known/x/%2E%2e/%2e%2E/api/auth/oauth2/authorize')).toBe('/api/auth/oauth2/authorize')
    expect(resolvedPathname('/api\\auth\\get-session')).toBe('/api/auth/get-session')
    expect(resolvedPathname('//api/auth/get-session')).toBe('/api/auth/get-session')
  })
})

describe('isCanonicalPath', () => {
  it('accepts the paths clients send', () => {
    for (const path of [
      '/',
      '/api/auth/get-session',
      '/api/tasks/echo/revisions/3',
      '/.well-known/oauth-protected-resource/mcp',
      '/api/scans/0b6f2d1e-8f8e-4f4b-9a39-3f7f3c2b4c1d-17',
      '/_nuxt/entry.DsXa1.js',
      '/api/tasks/a%2Fb',
      '/api/users/',
      '/x/..y/.z/a.b',
    ]) {
      expect(isCanonicalPath(path), path).toBe(true)
    }
  })

  it('rejects every path a URL parser rewrites', () => {
    for (const path of [
      '/.well-known/x/../../api/auth/get-session',
      '/.well-known/x/../../api/auth/passkey/generate-register-options',
      '/.well-known/x/%2e%2e/%2e%2e/api/auth/oauth2/authorize',
      '/api/auth/x/../passkey/generate-register-options',
      '/api/auth/passkey/./delete-passkey',
      '/api/auth/passkey/%2e/verify-registration',
      '/api/auth/passkey/.%2e/passkey/delete-passkey',
      '/api/auth/passkey/%2e./passkey/delete-passkey',
      '/api/auth/..',
      '/api\\auth\\get-session',
      '//api/auth/get-session',
      '/api/scans#x',
      '/api/a b',
      '/api/{x}',
      'api/scans',
      'http://orchestrator:3000/api/scans',
      '*',
    ]) {
      expect(isCanonicalPath(path), path).toBe(false)
    }
  })
})
