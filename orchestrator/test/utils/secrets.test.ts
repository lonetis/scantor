import { describe, expect, it } from 'vitest'
import { createKeyring } from '../../server/utils/keys'
import {
  configSecretAad,
  decryptSecret,
  encryptSecret,
  expandPointer,
  extractSecrets,
  formatPointer,
  MASK,
  maskSecrets,
  parsePointer,
  restoreSecrets,
  SecretDecryptionError,
} from '../../server/utils/secrets'

const keys = createKeyring('correct horse battery staple')
const otherKeys = createKeyring('another secret entirely')

describe('AES-256-GCM secrets (enc:v1)', () => {
  it('round-trips and uses a fresh IV per encryption', () => {
    const first = encryptSecret('token ✓', 'credentials', 'credentials:id:secretEnc', keys)
    const second = encryptSecret('token ✓', 'credentials', 'credentials:id:secretEnc', keys)
    expect(first).toMatch(/^enc:v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]+$/)
    expect(first).not.toBe(second)
    expect(decryptSecret(first, 'credentials', 'credentials:id:secretEnc', keys)).toBe('token ✓')
  })

  it('binds ciphertexts to the AAD, the key label and SCANTOR_SECRET', () => {
    const value = encryptSecret('secret', 'config-secrets', 'scans:a:/taskConfig/apiKey', keys)
    expect(() => decryptSecret(value, 'config-secrets', 'scans:b:/taskConfig/apiKey', keys)).toThrow(SecretDecryptionError)
    expect(() => decryptSecret(value, 'credentials', 'scans:a:/taskConfig/apiKey', keys)).toThrow(SecretDecryptionError)
    expect(() => decryptSecret(value, 'config-secrets', 'scans:a:/taskConfig/apiKey', otherKeys)).toThrow(SecretDecryptionError)
  })

  it('rejects malformed values', () => {
    expect(() => decryptSecret('plaintext', 'credentials', 'x', keys)).toThrow(SecretDecryptionError)
    expect(() => decryptSecret('enc:v1:abc', 'credentials', 'x', keys)).toThrow(SecretDecryptionError)
    expect(() => decryptSecret('enc:v1:AAAA:BBBB', 'credentials', 'x', keys)).toThrow(SecretDecryptionError)
  })
})

describe('JSON pointers', () => {
  it('parses and formats RFC 6901 pointers', () => {
    expect(parsePointer('')).toEqual([])
    expect(parsePointer('/a~1b/c~0d/0')).toEqual(['a/b', 'c~d', '0'])
    expect(formatPointer(['a/b', 'c~d', '0'])).toBe('/a~1b/c~0d/0')
    expect(() => parsePointer('a')).toThrow()
  })

  it('expands * over properties and array indexes', () => {
    const value = { headers: [{ token: 'a' }, { token: 'b' }], map: { x: { k: 1 }, y: { k: 2 } } }
    expect(expandPointer(value, '/headers/*/token')).toEqual(['/headers/0/token', '/headers/1/token'])
    expect(expandPointer(value, '/map/*/k')).toEqual(['/map/x/k', '/map/y/k'])
    expect(expandPointer(value, '/missing/*')).toEqual([])
  })
})

describe('masking writeOnly values', () => {
  it('masks every secret path in a copy', () => {
    const result = { apiKey: 'k', nested: { list: [{ password: 'p1' }, { password: 'p2' }] }, keep: 'v' }
    const masked = maskSecrets(result, ['/apiKey', '/nested/list/*/password', '/absent'])
    expect(masked).toEqual({ apiKey: MASK, nested: { list: [{ password: MASK }, { password: MASK }] }, keep: 'v' })
    expect(result.apiKey).toBe('k')
  })

  it('masks a whole secret value', () => {
    expect(maskSecrets({ a: 1 }, [''])).toBe(MASK)
  })

  it('extracts encrypted secrets and restores the plaintext config', () => {
    const config = { apiKey: 'top-secret', tokens: ['t1', 't2'], greeting: 'Hi', nested: { secret: { value: 1 } } }
    const aadFor = (pointer: string) => configSecretAad('scans', 'scan-1', 'taskConfig', pointer)
    const { masked, encrypted } = extractSecrets(config, ['/apiKey', '/tokens/*', '/nested/secret'], aadFor, keys)
    expect(masked).toEqual({ apiKey: MASK, tokens: [MASK, MASK], greeting: 'Hi', nested: { secret: MASK } })
    expect(Object.keys(encrypted).sort()).toEqual(['/apiKey', '/nested/secret', '/tokens/0', '/tokens/1'])
    expect(JSON.stringify(encrypted)).not.toContain('top-secret')
    expect(restoreSecrets(masked, encrypted, aadFor, keys)).toEqual(config)
    expect(aadFor('/apiKey')).toBe('scans:scan-1:/taskConfig/apiKey')
  })
})
