import { describe, expect, it } from 'vitest'
import { apiKeyConfigIdOf, bearerValue, classifyUserCredential, effectiveAdmin, looksLikeApiKey } from '../../server/utils/principal'

// Credential recognition and the effective role (docs/auth.md §5.2, §5.6).

const DEFAULT_KEY = `sk_scantor_${'a'.repeat(64)}`
const EDITOR_KEY = `sk_scantor_editor_${'B'.repeat(64)}`

describe('classifyUserCredential', () => {
  it('prefers the internal capability, then the API key, then the session cookie', () => {
    expect(classifyUserCredential({ internalAuth: 'sic_x', apiKey: DEFAULT_KEY, cookie: 'scantor.session_token=s' })).toEqual({
      kind: 'internal',
      token: 'sic_x',
    })
    expect(classifyUserCredential({ apiKey: DEFAULT_KEY, cookie: 'scantor.session_token=s' })).toEqual({ kind: 'apiKey', key: DEFAULT_KEY })
    expect(classifyUserCredential({ authorization: `Bearer ${EDITOR_KEY}`, cookie: 'scantor.session_token=s' })).toEqual({
      kind: 'apiKey',
      key: EDITOR_KEY,
    })
    expect(classifyUserCredential({ cookie: 'other=1; __Secure-scantor.session_token=s' })).toEqual({
      kind: 'session',
      cookie: 'other=1; __Secure-scantor.session_token=s',
    })
  })

  it('never falls back to the cookie when an explicit credential is invalid', () => {
    expect(classifyUserCredential({ authorization: 'Bearer eyJhbGciOiJFUzI1NiJ9.x.y', cookie: 'scantor.session_token=s' })).toEqual({ kind: 'invalid' })
    expect(classifyUserCredential({ authorization: 'Basic dXNlcjpwYXNz', cookie: 'scantor.session_token=s' })).toEqual({ kind: 'invalid' })
  })

  it('ignores unrelated cookies', () => {
    expect(classifyUserCredential({ cookie: 'scantor_tools=x; theme=dark' })).toEqual({ kind: 'none' })
    expect(classifyUserCredential({})).toEqual({ kind: 'none' })
  })
})

describe('API key shapes', () => {
  it('derives the configuration from the key prefix', () => {
    expect(apiKeyConfigIdOf(DEFAULT_KEY)).toBe('default')
    expect(apiKeyConfigIdOf(EDITOR_KEY)).toBe('editor')
    expect(looksLikeApiKey(EDITOR_KEY)).toBe(true)
    expect(looksLikeApiKey('snt_abc')).toBe(false)
  })

  it('parses bearer values', () => {
    expect(bearerValue('Bearer abc')).toBe('abc')
    expect(bearerValue('bearer   abc  ')).toBe('abc')
    expect(bearerValue('Basic abc')).toBeNull()
    expect(bearerValue(undefined)).toBeNull()
  })
})

describe('effectiveAdmin', () => {
  it.each([
    ['user', 'session', undefined, undefined, false],
    ['admin', 'session', undefined, undefined, true],
    ['admin', 'apiKey', 'default', undefined, true],
    ['admin', 'apiKey', 'editor', undefined, false],
    ['admin', 'mcp', undefined, 'write', false],
    ['admin', 'mcp', undefined, 'admin', true],
    ['admin', 'mcp', 'editor', 'admin', true],
    ['user', 'mcp', undefined, 'admin', false],
  ] as const)('%s via %s (%s, %s) → %s', (role, via, configId, level, expected) => {
    expect(effectiveAdmin(role, via, configId, level)).toBe(expected)
  })
})
