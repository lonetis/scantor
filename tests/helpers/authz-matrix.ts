import type { APIRequestContext } from '@playwright/test'
import { OWNED_PARAMS, PARAMS, REQUESTS, type Ids, type RequestSpec } from '../authz/requests'
import type { OpenApiIndex, OpenApiOperation } from './openapi'
import type { Seed } from './authz-seed'
import { env } from './env'
import { newApiContext } from './users'

// Mechanics of the generated authorization matrix (docs/testing.md §8.5, docs/security.md §7): the principals, the
// request built for an operation from authz/requests.ts, a raw sender that never follows redirects or validates
// schemas, and the classification of operations (reads first, destructive operations last).

/** The principals of docs/security.md §7. Sessions are cookies (storage states); keys and tokens are Bearer values. */
export type PrincipalName =
  | 'anonymous'
  | 'aSession'
  | 'aKey'
  | 'bSession'
  | 'bKey'
  | 'adminSession'
  | 'adminKey'
  | 'nodeToken'
  | 'workerToken'
  | 'setupToken'
  | 'invalidBearer'
  | 'invalidApiKey'

/** A syntactically valid setup token (`sst_` + 43 base64url characters); the stack has none (it has users). */
export const FAKE_SETUP_TOKEN = `sst_${'A'.repeat(43)}`
/** A well-formed `default` API key that does not exist. */
export const FAKE_API_KEY = `sk_scantor_${'a'.repeat(64)}`

export class Principals {
  private readonly contexts = new Map<PrincipalName, Promise<APIRequestContext>>()

  constructor(private readonly seed: Seed) {}

  get(name: PrincipalName): Promise<APIRequestContext> {
    let context = this.contexts.get(name)
    if (!context) {
      context = this.create(name)
      this.contexts.set(name, context)
    }
    return context
  }

  private create(name: PrincipalName): Promise<APIRequestContext> {
    const { seed } = this
    const bearer = (token: string) => newApiContext({ headers: { Authorization: `Bearer ${token}` } })
    switch (name) {
      case 'anonymous':
        return newApiContext()
      case 'aSession':
        return newApiContext({ storageState: seed.a.storageState })
      case 'aKey':
        return bearer(seed.a.key)
      case 'bSession':
        return newApiContext({ storageState: seed.b.storageState })
      case 'bKey':
        return bearer(seed.b.key)
      case 'adminSession':
        return newApiContext({ storageState: seed.admin.storageState })
      case 'adminKey':
        return bearer(seed.admin.key)
      case 'nodeToken':
        return bearer(seed.n1.token)
      case 'workerToken':
        return bearer(seed.a.workers[0]!.token)
      case 'setupToken':
        return newApiContext({ headers: { 'X-Scantor-Setup-Token': FAKE_SETUP_TOKEN } })
      case 'invalidBearer':
        return bearer('not-a-credential')
      case 'invalidApiKey':
        return bearer(FAKE_API_KEY)
    }
  }

  async dispose(): Promise<void> {
    for (const context of this.contexts.values()) await (await context).dispose()
    this.contexts.clear()
  }
}

/** A's seeded ids (the default target of every request). */
export function idsOfA(seed: Seed, overrides: Partial<Ids> = {}): Ids {
  const { a } = seed
  return {
    task: a.taskId,
    revision: a.revisionId,
    scanId: a.scanId,
    analysisId: a.analysisId,
    fileId: a.fileId,
    testRunId: a.testRunId,
    testRunFileId: a.testRunFileId,
    exportId: a.exportId,
    uploadId: a.uploadId,
    credentialId: a.credentialId,
    keyId: a.keyId,
    // A authorised no OAuth application; any client id of A's would be 404 to B the same way.
    clientId: 'authz-matrix-client',
    jobId: a.jobId,
    workerId: a.workers[0]!.id,
    userId: a.id,
    nodeId: seed.n1.id,
    template: 'list',
    language: 'python',
    guide: 'templates',
    gitHost: `git.${env.domain}`,
    version: seed.version,
    instanceId: `authz-matrix:${a.id.slice(0, 8)}`,
    ...overrides,
  }
}

/** The full request of an operation; throws when authz/requests.ts lacks what the operation needs. */
export function buildRequest(op: OpenApiOperation, ids: Ids, variant: 'valid' | 'safe' = 'valid'): RequestSpec {
  const factory = REQUESTS[op.operationId]
  if (!factory) throw new Error(`authz/requests.ts has no request factory for ${op.operationId}`)
  const spec = (variant === 'safe' && factory.safe ? factory.safe : factory.valid)(ids)
  const path: Record<string, string | number> = {}
  for (const param of op.parameters.filter((p) => p.in === 'path')) {
    const value = spec.path?.[param.name] ?? PARAMS[param.name]?.(ids)
    if (value === undefined) throw new Error(`authz/requests.ts has no value for the path parameter {${param.name}} of ${op.operationId}`)
    path[param.name] = value
  }
  for (const param of op.parameters.filter((p) => p.in === 'query' && p.required)) {
    if (spec.query?.[param.name] === undefined)
      throw new Error(`authz/requests.ts gives ${op.operationId} no value for its required query parameter ${param.name}`)
  }
  if (op.requestBody?.required && spec.body === undefined) throw new Error(`authz/requests.ts gives ${op.operationId} no request body`)
  return { ...spec, path }
}

export interface Answer {
  status: number
  headers: Record<string, string>
  /** parsed JSON, or undefined */
  json: unknown
  text: string
}

/** The error code of a scantor error envelope, if the answer is one. */
export function errorCode(answer: Answer): string | undefined {
  return (answer.json as { error?: { code?: string } } | undefined)?.error?.code
}

function expandPath(template: string, params: Record<string, string | number>, raw: boolean): string {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => (raw ? String(params[name]) : encodeURIComponent(String(params[name]))))
}

/**
 * Sends a request of an operation as is: no redirects followed, no schema validation, an explicit timeout. With
 * `rawPath` the path values are inserted without encoding (injection cases encode them themselves).
 */
export async function send(
  context: APIRequestContext,
  op: OpenApiOperation,
  spec: RequestSpec,
  options: { rawPath?: boolean; timeoutMs?: number } = {},
): Promise<Answer> {
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(spec.query ?? {})) if (value !== undefined) params[key] = String(value)
  const headers: Record<string, string> = { ...spec.headers }
  let data: Buffer | string | undefined
  if (Buffer.isBuffer(spec.body)) data = spec.body
  else if (spec.body !== undefined) {
    data = JSON.stringify(spec.body)
    headers['Content-Type'] ??= 'application/json'
  }
  const response = await context.fetch(expandPath(op.path, (spec.path ?? {}) as Record<string, string | number>, options.rawPath ?? false), {
    method: op.method.toUpperCase(),
    params,
    headers,
    data,
    maxRedirects: 0,
    timeout: options.timeoutMs ?? 60_000,
  })
  const raw = await response.body()
  const responseHeaders = response.headers()
  let json: unknown
  if ((responseHeaders['content-type'] ?? '').includes('json') && raw.length > 0) {
    try {
      json = JSON.parse(raw.toString('utf8'))
    } catch {
      json = undefined
    }
  }
  return { status: response.status(), headers: responseHeaders, json, text: raw.toString('utf8') }
}

/** A short description of an answer for assertion messages. */
export function describe(op: OpenApiOperation, answer: Answer): string {
  return `${op.operationId} (${op.method.toUpperCase()} ${op.path}) answered ${answer.status} ${answer.text.slice(0, 300)}`
}

export function scopeOf(op: OpenApiOperation): string {
  return String(op.extensions['x-scantor-scope'])
}

/** DELETE, `x-destructive`, and the cancel/retry/ban/rotate/revoke actions run last (docs/security.md §7 case 7). */
export function isDestructive(op: OpenApiOperation): boolean {
  return op.method === 'delete' || op.extensions['x-destructive'] === true || /^(cancel|retry|ban|rotate|revoke)[A-Z]/.test(op.operationId)
}

export function isRead(op: OpenApiOperation): boolean {
  return op.method === 'get' || op.extensions['x-read-only'] === true
}

/** The operation addresses an owned resource in its path, or references owned documents in its body. */
export function referencesOwned(op: OpenApiOperation): boolean {
  return op.parameters.some((p) => p.in === 'path' && OWNED_PARAMS.has(p.name)) || REQUESTS[op.operationId]?.bodyRefs === true
}

/** Account-scoped parameters: API keys and OAuth apps are only ever the caller's, also for admins. */
export function isAccountScoped(op: OpenApiOperation): boolean {
  return op.parameters.some((p) => p.in === 'path' && (p.name === 'keyId' || p.name === 'clientId'))
}

/** The operations of a scope, ordered: reads, then mutations, then destructive operations. */
export function operationsOf(openapi: OpenApiIndex, scope: string): OpenApiOperation[] {
  const rank = (op: OpenApiOperation) => (isDestructive(op) ? 2 : isRead(op) ? 0 : 1)
  return [...openapi.operations.values()].filter((op) => scopeOf(op) === scope).sort((x, y) => rank(x) - rank(y) || x.operationId.localeCompare(y.operationId))
}

/** "ok" in docs/security.md §7: anything but 401, 403 and 404 (state conflicts and validation errors are fine). */
export const isOk = (status: number) => status !== 401 && status !== 403 && status !== 404
