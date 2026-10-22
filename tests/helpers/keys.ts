import { createHmac, hkdfSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from './env'

// Key derivations of docs/architecture.md §9 from the test stack's SCANTOR_SECRET, for white-box tests: the
// per-scan RabbitMQ password, worker tokens (with the worker documents of listScanWorkers), the read-only MongoDB
// user, the registry push credential and the tools and editor cookies. A TypeScript twin of Go internal/keys and
// orchestrator/server/utils/keys.ts; `verifyVectors()` checks it against tests/corpora/keys-vectors.json, which pins
// all three implementations.
//
//   key(label) = HKDF-SHA256(ikm = UTF-8(secret), salt = UTF-8("scantor-v1"), info = UTF-8(label), L = 32)

export const KEY_SALT = 'scantor-v1'

export type KeyLabel =
  | 'better-auth'
  | 'registry-signing'
  | 'registry-push'
  | 'registry-http'
  | 'worker-token'
  | 'amqp'
  | 'credentials'
  | 'config-secrets'
  | 'tools-cookie'
  | 'editor-cookie'
  | 'builtin-node'
  | 'mongo-query'

const b64url = (data: Buffer) => data.toString('base64url')
const hmac = (key: Buffer, message: string) => createHmac('sha256', key).update(message, 'utf8').digest()

export class Keys {
  constructor(private readonly secret: string) {
    if (secret === '') throw new Error('the secret is empty')
  }

  derive(label: KeyLabel): Buffer {
    return Buffer.from(hkdfSync('sha256', Buffer.from(this.secret, 'utf8'), Buffer.from(KEY_SALT, 'utf8'), Buffer.from(label, 'utf8'), 32))
  }

  /** password of the registry `orchestrator` credential */
  registryPushPassword(): string {
    return b64url(this.derive('registry-push'))
  }

  /** password of the read-only MongoDB user scantor_query */
  mongoQueryPassword(): string {
    return b64url(this.derive('mongo-query'))
  }

  /** the built-in node's token */
  builtinNodeToken(): string {
    return `snt_${b64url(this.derive('builtin-node'))}`
  }

  /** the RabbitMQ password of the scan user `scan-<scanId>` */
  amqpPassword(scanId: string): string {
    return b64url(hmac(this.derive('amqp'), scanId))
  }

  /** a worker token `swt_<workerId>.<mac>` (role scheduler|runner, the node the worker is placed on) */
  workerToken(worker: { workerId: string; scanId: string; role: string; nodeId: string }): string {
    const mac = b64url(hmac(this.derive('worker-token'), `${worker.workerId}\n${worker.scanId}\n${worker.role}\n${worker.nodeId}`))
    return `swt_${worker.workerId}.${mac}`
  }

  /** a `scantor_editor` cookie value */
  editorCookie(userId: string, editorStartedAtMs: number, expiresAtMs: number): string {
    const payload = `v1.${userId}.${editorStartedAtMs}.${expiresAtMs}`
    return `${payload}.${b64url(hmac(this.derive('editor-cookie'), payload))}`
  }

  /** a `scantor_tools` cookie: an HS256 JWT over the claims (iss scantor, aud tools, sub, role, iat, exp, jti) */
  toolsCookie(claims: Record<string, unknown>): string {
    const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
    const signingInput = `${header}.${b64url(Buffer.from(JSON.stringify(claims)))}`
    return `${signingInput}.${this.toolsCookieSignature(signingInput)}`
  }

  toolsCookieSignature(signingInput: string): string {
    return b64url(hmac(this.derive('tools-cookie'), signingInput))
  }
}

/** The keys of the running test stack. */
export function stackKeys(): Keys {
  return new Keys(env.secret)
}

interface Vectors {
  salt: string
  hkdf: { secret: string; label: KeyLabel; hex: string }[]
  registryPushPassword: { secret: string; value: string }[]
  mongoQueryPassword: { secret: string; value: string }[]
  builtinNodeToken: { secret: string; value: string }[]
  amqpPassword: { secret: string; scanId: string; value: string }[]
  workerToken: { secret: string; workerId: string; scanId: string; role: string; nodeId: string; value: string }[]
  editorCookie: { secret: string; userId: string; editorStartedAtMs: number; expiresAtMs: number; value: string }[]
  toolsCookieSignature: { secret: string; signingInput: string; signature: string }[]
}

/** Checks every derivation against tests/corpora/keys-vectors.json; returns the mismatches. */
export function verifyVectors(file = join(env.paths.tests, 'corpora', 'keys-vectors.json')): string[] {
  const vectors = JSON.parse(readFileSync(file, 'utf8')) as Vectors
  const problems: string[] = []
  const check = (what: string, actual: string, expected: string) => {
    if (actual !== expected) problems.push(`${what}: ${actual} != ${expected}`)
  }
  if (vectors.salt !== KEY_SALT) problems.push(`salt ${vectors.salt} != ${KEY_SALT}`)
  for (const v of vectors.hkdf) check(`hkdf ${v.label}`, new Keys(v.secret).derive(v.label).toString('hex'), v.hex)
  for (const v of vectors.registryPushPassword) check('registryPushPassword', new Keys(v.secret).registryPushPassword(), v.value)
  for (const v of vectors.mongoQueryPassword) check('mongoQueryPassword', new Keys(v.secret).mongoQueryPassword(), v.value)
  for (const v of vectors.builtinNodeToken) check('builtinNodeToken', new Keys(v.secret).builtinNodeToken(), v.value)
  for (const v of vectors.amqpPassword) check(`amqpPassword ${v.scanId}`, new Keys(v.secret).amqpPassword(v.scanId), v.value)
  for (const v of vectors.workerToken) check(`workerToken ${v.workerId}`, new Keys(v.secret).workerToken(v), v.value)
  for (const v of vectors.editorCookie)
    check(`editorCookie ${v.userId}`, new Keys(v.secret).editorCookie(v.userId, v.editorStartedAtMs, v.expiresAtMs), v.value)
  for (const v of vectors.toolsCookieSignature) check('toolsCookieSignature', new Keys(v.secret).toolsCookieSignature(v.signingInput), v.signature)
  return problems
}
