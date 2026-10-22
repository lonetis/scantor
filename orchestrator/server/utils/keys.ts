import { createECDH, createHash, createHmac, createPrivateKey, hkdfSync, type KeyObject, timingSafeEqual } from 'node:crypto'
import { useConfig } from './config'

// Key derivation from SCANTOR_SECRET (docs/architecture.md §9, docs/auth.md §3), the TypeScript twin of Go
// internal/keys; both are pinned by tests/corpora/keys-vectors.json:
//
//   key(label) = HKDF-SHA256(ikm = UTF-8(secret), salt = UTF-8("scantor-v1"), info = UTF-8(label), L = 32)
//
// Derived values are secrets: never log them.

export const KEY_SALT = 'scantor-v1'
export const KEY_LENGTH = 32

export const KEY_LABELS = [
  'better-auth',
  'registry-signing',
  'registry-push',
  'registry-http',
  'worker-token',
  'amqp',
  'credentials',
  'config-secrets',
  'tools-cookie',
  'editor-cookie',
  'builtin-node',
  'mongo-query',
] as const
export type KeyLabel = (typeof KEY_LABELS)[number]

export const NODE_TOKEN_PREFIX = 'snt_'
export const WORKER_TOKEN_PREFIX = 'swt_'
export const NODE_TOKEN_PATTERN = /^snt_[A-Za-z0-9_-]{43}$/
export const WORKER_TOKEN_PATTERN = /^swt_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/

// Order of the P-256 group. BigInt() instead of `n` literals: Nitro's development build targets ES2019.
const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')
const ONE = BigInt(1)

export function b64url(data: Buffer | Uint8Array): string {
  return Buffer.from(data).toString('base64url')
}

export function hmacSha256(key: Buffer, message: string): Buffer {
  return createHmac('sha256', key).update(message, 'utf8').digest()
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Constant-time comparison of two strings of possibly different lengths (hashes both first). */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest()
  const right = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(left, right)
}

export interface RegistrySigningKey {
  privateKey: KeyObject
  /** public JWK (kty, crv, x, y) */
  publicJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }
  /** `scantor-` + first 16 hex chars of SHA-256 of the uncompressed public point */
  kid: string
}

export interface Keyring {
  derive(label: KeyLabel): Buffer
  deriveHex(label: KeyLabel): string
  deriveB64url(label: KeyLabel): string
  /** better-auth `secret`: hex(key("better-auth")) */
  betterAuthSecret(): string
  /** password of the registry `orchestrator` credential: base64url(key("registry-push")) */
  registryPushPassword(): string
  /** REGISTRY_HTTP_SECRET: hex(key("registry-http")) */
  registryHttpSecret(): string
  /** password of the read-only MongoDB user scantor_query: base64url(key("mongo-query")) */
  mongoQueryPassword(): string
  /** built-in node token: "snt_" + base64url(key("builtin-node")) */
  builtinNodeToken(): string
  /** per-scan RabbitMQ password: base64url(HMAC-SHA256(key("amqp"), scanId)) */
  amqpPassword(scanId: string): string
  /** worker token MAC over workerId, scanId, role and nodeId */
  workerTokenMac(workerId: string, scanId: string, role: string, nodeId: string): string
  /** "swt_<workerId>.<mac>" */
  workerToken(workerId: string, scanId: string, role: string, nodeId: string): string
  /** `scantor_editor` cookie value `v1.<userId>.<editorStartedAtMs>.<expiresAtMs>.<mac>` */
  editorCookie(userId: string, editorStartedAtMs: number, expiresAtMs: number): string
  /** HS256 signature (base64url) of a `scantor_tools` JWT signing input */
  toolsCookieSignature(signingInput: string): string
  /** ES256 registry token signing key */
  registrySigningKey(): RegistrySigningKey
}

function bigIntToBuffer(value: bigint, length: number): Buffer {
  const hex = value.toString(16).padStart(length * 2, '0')
  return Buffer.from(hex, 'hex')
}

/** Creates the keyring of one secret. Keys are derived lazily and cached. */
export function createKeyring(secret: string): Keyring {
  if (secret === '') throw new Error('SCANTOR_SECRET is empty')
  const cache = new Map<KeyLabel, Buffer>()
  let signing: RegistrySigningKey | null = null

  const derive = (label: KeyLabel): Buffer => {
    let key = cache.get(label)
    if (!key) {
      key = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from(KEY_SALT, 'utf8'), Buffer.from(label, 'utf8'), KEY_LENGTH))
      cache.set(label, key)
    }
    return key
  }
  const deriveHex = (label: KeyLabel) => derive(label).toString('hex')
  const deriveB64url = (label: KeyLabel) => b64url(derive(label))
  const workerTokenMac = (workerId: string, scanId: string, role: string, nodeId: string) =>
    b64url(hmacSha256(derive('worker-token'), `${workerId}\n${scanId}\n${role}\n${nodeId}`))

  return {
    derive,
    deriveHex,
    deriveB64url,
    betterAuthSecret: () => deriveHex('better-auth'),
    registryPushPassword: () => deriveB64url('registry-push'),
    registryHttpSecret: () => deriveHex('registry-http'),
    mongoQueryPassword: () => deriveB64url('mongo-query'),
    builtinNodeToken: () => `${NODE_TOKEN_PREFIX}${deriveB64url('builtin-node')}`,
    amqpPassword: (scanId) => b64url(hmacSha256(derive('amqp'), scanId)),
    workerTokenMac,
    workerToken: (workerId, scanId, role, nodeId) =>
      `${WORKER_TOKEN_PREFIX}${workerId}.${workerTokenMac(workerId, scanId, role, nodeId)}`,
    editorCookie: (userId, editorStartedAtMs, expiresAtMs) => {
      const payload = `v1.${userId}.${editorStartedAtMs}.${expiresAtMs}`
      return `${payload}.${b64url(hmacSha256(derive('editor-cookie'), payload))}`
    },
    toolsCookieSignature: (signingInput) => b64url(hmacSha256(derive('tools-cookie'), signingInput)),
    registrySigningKey: () => {
      if (signing) return signing
      // d = (k mod (n − 1)) + 1 maps the HKDF output onto [1, n − 1] (same as Go internal/keys).
      const k = BigInt(`0x${deriveHex('registry-signing')}`)
      const d = bigIntToBuffer((k % (P256_ORDER - ONE)) + ONE, 32)
      const ecdh = createECDH('prime256v1')
      ecdh.setPrivateKey(d)
      const point = ecdh.getPublicKey()
      const x = b64url(point.subarray(1, 33))
      const y = b64url(point.subarray(33, 65))
      const privateKey = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: b64url(d), x, y }, format: 'jwk' })
      signing = {
        privateKey,
        publicJwk: { kty: 'EC', crv: 'P-256', x, y },
        kid: `scantor-${sha256Hex(point).slice(0, 16)}`,
      }
      return signing
    },
  }
}

/** Lowercase hex SHA-256 of a full node token, the stored form (`nodes.tokenHash`). */
export function nodeTokenHash(token: string): string {
  return sha256Hex(token)
}

/** Splits a worker token into its worker id and MAC, or null when malformed. */
export function parseWorkerToken(token: string): { workerId: string; mac: string } | null {
  const match = WORKER_TOKEN_PATTERN.exec(token)
  return match ? { workerId: match[1]!, mac: match[2]! } : null
}

let keyring: Keyring | null = null

/** The keyring of this process, derived from SCANTOR_SECRET once. */
export function useKeys(): Keyring {
  keyring ??= createKeyring(useConfig().secret)
  return keyring
}
