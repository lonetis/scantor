import { createPublicKey, createSign, createVerify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createKeyring, KEY_LABELS, nodeTokenHash, parseWorkerToken, safeEqual } from '../../server/utils/keys'
import { decryptSecret, encryptSecret } from '../../server/utils/secrets'
import { readRepoFile, repoFileExists } from '../helpers/repo'

// Shared HKDF vectors (docs/architecture.md §9, docs/auth.md §3, security.md CFG-4), also read by Go internal/keys.
// The file is written by the Go side; the vector tests are skipped while it does not exist.

const VECTORS_FILE = 'tests/corpora/keys-vectors.json'
const hasVectors = repoFileExists(VECTORS_FILE)

interface Vectors {
  salt: string
  hkdf: { secret: string; label: string; hex: string }[]
  betterAuthSecret: { secret: string; value: string }[]
  registryPushPassword: { secret: string; value: string }[]
  registryHttpSecret: { secret: string; value: string }[]
  mongoQueryPassword: { secret: string; value: string }[]
  builtinNodeToken: { secret: string; value: string; tokenHash: string }[]
  nodeTokenHash: { token: string; hash: string }[]
  workerToken: { secret: string; workerId: string; scanId: string; role: string; nodeId: string; value: string }[]
  amqpPassword: { secret: string; scanId: string; value: string }[]
  editorCookie: { secret: string; userId: string; editorStartedAtMs: number; expiresAtMs: number; value: string }[]
  toolsCookieSignature: { secret: string; signingInput: string; signature: string }[]
  registrySigningKey: { secret: string; d: string; x: string; y: string; kid: string }[]
  encryption: { secret: string; label: 'credentials' | 'config-secrets'; aad: string; iv: string; plaintext: string; value: string }[]
}

const vectors: Vectors | null = hasVectors ? (JSON.parse(readRepoFile(VECTORS_FILE)) as Vectors) : null

describe.skipIf(!hasVectors)('keys against tests/corpora/keys-vectors.json', () => {
  const v = vectors!

  it('uses the shared salt', () => {
    expect(v.salt).toBe('scantor-v1')
  })

  it('derives every HKDF vector', () => {
    for (const vector of v.hkdf) {
      expect(KEY_LABELS).toContain(vector.label)
      expect(createKeyring(vector.secret).deriveHex(vector.label as (typeof KEY_LABELS)[number]), vector.label).toBe(vector.hex)
    }
  })

  it('covers every label', () => {
    expect(new Set(v.hkdf.map((vector) => vector.label))).toEqual(new Set(KEY_LABELS))
  })

  it('derives the encoded secrets', () => {
    for (const vector of v.betterAuthSecret) expect(createKeyring(vector.secret).betterAuthSecret()).toBe(vector.value)
    for (const vector of v.registryPushPassword) expect(createKeyring(vector.secret).registryPushPassword()).toBe(vector.value)
    for (const vector of v.registryHttpSecret) expect(createKeyring(vector.secret).registryHttpSecret()).toBe(vector.value)
    for (const vector of v.mongoQueryPassword) expect(createKeyring(vector.secret).mongoQueryPassword()).toBe(vector.value)
  })

  it('derives the built-in node token and hashes node tokens', () => {
    for (const vector of v.builtinNodeToken) {
      const token = createKeyring(vector.secret).builtinNodeToken()
      expect(token).toBe(vector.value)
      expect(nodeTokenHash(token)).toBe(vector.tokenHash)
    }
    for (const vector of v.nodeTokenHash) expect(nodeTokenHash(vector.token)).toBe(vector.hash)
  })

  it('mints worker tokens', () => {
    for (const vector of v.workerToken) {
      const token = createKeyring(vector.secret).workerToken(vector.workerId, vector.scanId, vector.role, vector.nodeId)
      expect(token).toBe(vector.value)
      expect(parseWorkerToken(token)).toEqual({ workerId: vector.workerId, mac: token.split('.')[1] })
    }
  })

  it('derives per-scan AMQP passwords', () => {
    for (const vector of v.amqpPassword) expect(createKeyring(vector.secret).amqpPassword(vector.scanId)).toBe(vector.value)
  })

  it('signs editor cookies and tools cookies', () => {
    for (const vector of v.editorCookie) {
      expect(createKeyring(vector.secret).editorCookie(vector.userId, vector.editorStartedAtMs, vector.expiresAtMs)).toBe(vector.value)
    }
    for (const vector of v.toolsCookieSignature) {
      expect(createKeyring(vector.secret).toolsCookieSignature(vector.signingInput)).toBe(vector.signature)
    }
  })

  it('derives the registry signing key and its kid', () => {
    for (const vector of v.registrySigningKey) {
      const key = createKeyring(vector.secret).registrySigningKey()
      expect(key.publicJwk).toEqual({ kty: 'EC', crv: 'P-256', x: vector.x, y: vector.y })
      expect(key.kid).toBe(vector.kid)
      expect(key.privateKey.export({ format: 'jwk' }).d).toBe(vector.d)
    }
  })

  it('encrypts exactly like the vectors and decrypts them', () => {
    for (const vector of v.encryption) {
      const keys = createKeyring(vector.secret)
      expect(encryptSecret(vector.plaintext, vector.label, vector.aad, keys, Buffer.from(vector.iv, 'base64url'))).toBe(vector.value)
      expect(decryptSecret(vector.value, vector.label, vector.aad, keys)).toBe(vector.plaintext)
    }
  })
})

describe('keyring', () => {
  const keys = createKeyring('correct horse battery staple')

  it('derives 32-byte keys that differ per label and per secret', () => {
    const derived = KEY_LABELS.map((label) => keys.deriveHex(label))
    expect(new Set(derived).size).toBe(KEY_LABELS.length)
    for (const hex of derived) expect(hex).toMatch(/^[0-9a-f]{64}$/)
    expect(createKeyring('another secret').deriveHex('amqp')).not.toBe(keys.deriveHex('amqp'))
  })

  it('refuses an empty secret', () => {
    expect(() => createKeyring('')).toThrow()
  })

  it('formats tokens as specified', () => {
    expect(keys.builtinNodeToken()).toMatch(/^snt_[A-Za-z0-9_-]{43}$/)
    expect(keys.workerToken('9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', 's', 'runner', 'n')).toMatch(/^swt_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/)
    expect(keys.amqpPassword('scan')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('binds the worker token MAC to scan, role and node', () => {
    const workerId = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
    const base = keys.workerTokenMac(workerId, 'scan', 'runner', 'node')
    expect(keys.workerTokenMac(workerId, 'scan', 'scheduler', 'node')).not.toBe(base)
    expect(keys.workerTokenMac(workerId, 'other', 'runner', 'node')).not.toBe(base)
    expect(keys.workerTokenMac(workerId, 'scan', 'runner', 'other')).not.toBe(base)
  })

  it('produces a usable ES256 signing key', () => {
    const key = keys.registrySigningKey()
    const signature = createSign('SHA256').update('payload').sign(key.privateKey)
    const verifier = createVerify('SHA256').update('payload')
    expect(verifier.verify(createPublicKey({ key: key.publicJwk, format: 'jwk' }), signature)).toBe(true)
    expect(key.kid).toMatch(/^scantor-[0-9a-f]{16}$/)
  })

  it('rejects malformed worker tokens', () => {
    expect(parseWorkerToken('swt_not-a-uuid.mac')).toBeNull()
    expect(parseWorkerToken('snt_whatever')).toBeNull()
  })

  it('compares secrets in constant time regardless of length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('', 'x')).toBe(false)
  })
})
