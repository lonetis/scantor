import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { type Keyring, useKeys } from './keys'

// Secrets at rest and masking (docs/data-model.md §1 "Encrypted values", security.md SEC-1, SEC-2, WS-7).
//
// Encrypted values have the format `enc:v1:<base64url(iv, 12 bytes)>:<base64url(ciphertext ‖ tag)>`, AES-256-GCM
// with an HKDF key and AAD `<collection>:<_id>:<field or JSON pointer>`. `writeOnly` config values are stored
// encrypted by JSON pointer and replaced by "***" in the config itself; secret paths may contain `*`, which
// matches any array index or property name.

export const MASK = '***'
const ENC_PREFIX = 'enc:v1:'
export type SecretKeyLabel = 'credentials' | 'config-secrets'

export class SecretDecryptionError extends Error {
  constructor(message = 'secret cannot be decrypted with the current SCANTOR_SECRET') {
    super(message)
    this.name = 'SecretDecryptionError'
  }
}

export function encryptSecret(plaintext: string, label: SecretKeyLabel, aad: string, keys: Keyring = useKeys(), iv = randomBytes(12)): string {
  const cipher = createCipheriv('aes-256-gcm', keys.derive(label), iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return `${ENC_PREFIX}${iv.toString('base64url')}:${ciphertext.toString('base64url')}`
}

export function decryptSecret(value: string, label: SecretKeyLabel, aad: string, keys: Keyring = useKeys()): string {
  if (!value.startsWith(ENC_PREFIX)) throw new SecretDecryptionError('not an encrypted value')
  const [ivPart, dataPart] = value.slice(ENC_PREFIX.length).split(':')
  if (!ivPart || !dataPart) throw new SecretDecryptionError('malformed encrypted value')
  const iv = Buffer.from(ivPart, 'base64url')
  const data = Buffer.from(dataPart, 'base64url')
  if (iv.length !== 12 || data.length < 16) throw new SecretDecryptionError('malformed encrypted value')
  try {
    const decipher = createDecipheriv('aes-256-gcm', keys.derive(label), iv)
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(data.subarray(data.length - 16))
    return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8')
  } catch {
    throw new SecretDecryptionError()
  }
}

/** AAD of a config secret: `<collection>:<_id>:/<configKind><pointer>` (a JSON pointer into the document). */
export function configSecretAad(collection: string, id: string, configKind: string, pointer: string): string {
  return `${collection}:${id}:/${configKind}${pointer}`
}

// ── JSON pointers (RFC 6901) with `*` wildcards ─────────────────────────────

export function parsePointer(pointer: string): string[] {
  if (pointer === '') return []
  if (!pointer.startsWith('/')) throw new Error(`invalid JSON pointer "${pointer}"`)
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
}

export function formatPointer(segments: readonly string[]): string {
  return segments.map((segment) => `/${segment.replaceAll('~', '~0').replaceAll('/', '~1')}`).join('')
}

/** Concrete pointers of `value` matched by a pattern whose `*` segments match any key or index. */
export function expandPointer(value: unknown, pattern: string): string[] {
  const results: string[] = []
  const walk = (node: unknown, rest: string[], path: string[]) => {
    if (rest.length === 0) {
      results.push(formatPointer(path))
      return
    }
    if (node === null || typeof node !== 'object') return
    const [head, ...tail] = rest as [string, ...string[]]
    const keys = head === '*' ? Object.keys(node) : Object.hasOwn(node, head) ? [head] : []
    for (const key of keys) walk((node as Record<string, unknown>)[key], tail, [...path, key])
  }
  walk(value, parsePointer(pattern), [])
  return results
}

function getAt(value: unknown, segments: string[]): unknown {
  let node = value
  for (const segment of segments) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, segment)) return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

function setAt(value: unknown, segments: string[], replacement: unknown): void {
  if (segments.length === 0) return
  let node = value
  for (const segment of segments.slice(0, -1)) {
    if (node === null || typeof node !== 'object') return
    node = (node as Record<string, unknown>)[segment]
  }
  if (node !== null && typeof node === 'object') (node as Record<string, unknown>)[segments.at(-1)!] = replacement
}

/** A deep copy of `value` with every value at a secret path replaced by "***" (results, analysis configs). */
export function maskSecrets<T>(value: T, patterns: readonly string[]): T {
  if (patterns.length === 0 || value === null || typeof value !== 'object') return value
  const copy = structuredClone(value)
  for (const pattern of patterns) {
    if (pattern === '') return MASK as T
    for (const pointer of expandPointer(copy, pattern)) setAt(copy, parsePointer(pointer), MASK)
  }
  return copy
}

export interface ExtractedSecrets {
  /** the config with secrets replaced by "***" */
  masked: Record<string, unknown>
  /** encrypted values by concrete JSON pointer */
  encrypted: Record<string, string>
}

/**
 * Splits an effective config into the masked config stored in the document and the encrypted secrets stored
 * beside it. `aadFor(pointer)` binds each ciphertext to its location.
 */
export function extractSecrets(
  config: Record<string, unknown>,
  patterns: readonly string[],
  aadFor: (pointer: string) => string,
  keys: Keyring = useKeys(),
): ExtractedSecrets {
  const masked = structuredClone(config)
  const encrypted: Record<string, string> = {}
  for (const pattern of patterns) {
    for (const pointer of expandPointer(config, pattern)) {
      if (pointer === '') continue
      const secret = getAt(config, parsePointer(pointer))
      if (secret === undefined) continue
      encrypted[pointer] = encryptSecret(JSON.stringify(secret), 'config-secrets', aadFor(pointer), keys)
      setAt(masked, parsePointer(pointer), MASK)
    }
  }
  return { masked, encrypted }
}

/** Rebuilds the plaintext config from the masked config and its encrypted secrets (bootstrap only). */
export function restoreSecrets(
  masked: Record<string, unknown>,
  encrypted: Record<string, string>,
  aadFor: (pointer: string) => string,
  keys: Keyring = useKeys(),
): Record<string, unknown> {
  const config = structuredClone(masked)
  for (const [pointer, value] of Object.entries(encrypted)) {
    setAt(config, parsePointer(pointer), JSON.parse(decryptSecret(value, 'config-secrets', aadFor(pointer), keys)))
  }
  return config
}
