import type { APIRequestContext, APIResponse } from '@playwright/test'
import type { Account, CreatedApiKey } from '#shared/types/account'
import type { AnalysisAggregateResult, AnalysisQueryResult } from '#shared/types/analyses'
import type { ItemList, JobAccepted, Page } from '#shared/types/common'
import type { Health, InstanceInfo } from '#shared/types/instance'
import type { Job } from '#shared/types/jobs'
import type { Node, NodeWithToken } from '#shared/types/nodes'
import type { Revision } from '#shared/types/revisions'
import type { Scan, ScanSummary } from '#shared/types/scans'
import type { Task, UploadTaskResult } from '#shared/types/tasks'
import type { User } from '#shared/types/users'
import type { Worker } from '#shared/types/workers'
import type { OpenApiIndex } from './openapi'

// The REST client of the suite (docs/testing.md §7.8). `call(operationId, …)` resolves the method and path template
// through the OpenAPI document, so every operation is reachable by its operationId; the thin typed wrappers below
// cover frequent operations with the shared representation types. Responses are returned, never thrown: assert on
// `status` in tests, or use `ok()` when a step must succeed. 2xx JSON bodies are validated against the documented
// response schema (pass `validate: false` only in tests of invalid documentation).

export type PathParams = Record<string, string | number>
export type QueryParams = Record<string, string | number | boolean | undefined>

export interface CallOptions {
  path?: PathParams
  query?: QueryParams
  /** JSON body, or a Buffer sent as is (set its Content-Type in `headers`) */
  body?: unknown
  headers?: Record<string, string>
  /** default 0: follow no redirects, so 302 answers stay visible */
  maxRedirects?: number
  validate?: boolean
}

export interface ApiResponse<T = unknown> {
  status: number
  headers: Record<string, string>
  /** the parsed JSON body; `{}` when the response is not JSON */
  body: T
  /** the raw body (downloads, exports) */
  raw: Buffer
}

export class ApiError extends Error {
  constructor(
    readonly operation: string,
    readonly response: ApiResponse,
  ) {
    super(`${operation} answered ${response.status}: ${JSON.stringify(response.body).slice(0, 2000)}`)
  }
}

/** Throws ApiError unless the response is 2xx; returns the body. */
export function ok<T>(response: ApiResponse<T>, operation = 'request'): T {
  if (response.status < 200 || response.status > 299) throw new ApiError(operation, response)
  return response.body
}

function expandPath(template: string, params: PathParams = {}): string {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params[name]
    if (value === undefined) throw new Error(`missing path parameter ${name} for ${template}`)
    return encodeURIComponent(String(value))
  })
}

async function toApiResponse<T>(response: APIResponse): Promise<ApiResponse<T>> {
  const raw = await response.body()
  const headers = response.headers()
  let body: unknown = {}
  if ((headers['content-type'] ?? '').includes('json') && raw.length > 0) body = JSON.parse(raw.toString('utf8'))
  return { status: response.status(), headers, body: body as T, raw }
}

export class ApiClient {
  constructor(
    readonly request: APIRequestContext,
    readonly openapi: OpenApiIndex,
  ) {}

  /** Calls an operation by its operationId. */
  async call<T = unknown>(operationId: string, options: CallOptions = {}): Promise<ApiResponse<T>> {
    const op = this.openapi.get(operationId)
    const url = expandPath(op.path, options.path)
    const params: Record<string, string> = {}
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) params[key] = String(value)
    const headers: Record<string, string> = { ...options.headers }
    let data: Buffer | string | undefined
    if (Buffer.isBuffer(options.body)) {
      data = options.body
    } else if (options.body !== undefined) {
      data = JSON.stringify(options.body)
      headers['Content-Type'] ??= 'application/json'
    }
    const response = await this.request.fetch(url, {
      method: op.method.toUpperCase(),
      params,
      headers,
      data,
      maxRedirects: options.maxRedirects ?? 0,
    })
    const result = await toApiResponse<T>(response)
    if (options.validate !== false && result.status >= 200 && result.status < 300 && (result.headers['content-type'] ?? '').includes('json')) {
      const problems = this.openapi.validateResponse(operationId, result.status, result.body)
      if (problems.length > 0) {
        throw new Error(`${operationId} ${result.status}: the body does not match the documented schema:\n  ${problems.join('\n  ')}`)
      }
    }
    return result
  }

  // ── health, instance, account ─────────────────────────────────────────────────────────────────────

  getHealth() {
    return this.call<Health>('getHealth')
  }

  getInstanceInfo() {
    return this.call<InstanceInfo>('getInstanceInfo')
  }

  getAccount() {
    return this.call<Account>('getAccount')
  }

  createApiKey(name: string, expiresInDays?: number) {
    return this.call<CreatedApiKey>('createApiKey', { body: { name, expiresInDays } })
  }

  // ── users (admin) ─────────────────────────────────────────────────────────────────────────────────

  createUser(body: { email: string; name: string; password?: string; role?: 'user' | 'admin'; canRunPrivileged?: boolean; maxWorkers?: number }) {
    return this.call<User>('createUser', { body })
  }

  getUser(userId: string) {
    return this.call<User>('getUser', { path: { userId } })
  }

  deleteUser(userId: string) {
    return this.call<JobAccepted>('deleteUser', { path: { userId } })
  }

  // ── nodes (admin) ─────────────────────────────────────────────────────────────────────────────────

  listNodes(query: { state?: string; pool?: string } = {}) {
    return this.call<ItemList<Node>>('listNodes', { query })
  }

  createNode(body: { name: string; pool?: string; labels?: Record<string, string>; maxWorkers?: number }) {
    return this.call<NodeWithToken>('createNode', { body })
  }

  deleteNode(nodeId: string) {
    return this.call('deleteNode', { path: { nodeId } })
  }

  // ── tasks and revisions ───────────────────────────────────────────────────────────────────────────

  getTask(task: string) {
    return this.call<Task>('getTask', { path: { task } })
  }

  listTasks(query: QueryParams = {}) {
    return this.call<Page<Task>>('listTasks', { query })
  }

  /** Uploads a tar.gz of a task folder (helpers/tasks.ts packs one). */
  uploadTask(archive: Buffer, query: { publish?: boolean; force?: boolean; message?: string; wait?: number } = {}) {
    return this.call<UploadTaskResult>('uploadTask', { body: archive, headers: { 'Content-Type': 'application/gzip' }, query })
  }

  deleteTask(task: string) {
    return this.call<JobAccepted>('deleteTask', { path: { task } })
  }

  publishRevision(task: string, body: { message?: string } = {}, wait?: number) {
    return this.call<Revision>('publishRevision', { path: { task }, body, query: { wait } })
  }

  getRevision(task: string, revision: string | number, wait?: number) {
    return this.call<Revision>('getRevision', { path: { task, revision }, query: { wait } })
  }

  // ── scans and analyses ────────────────────────────────────────────────────────────────────────────

  startScan(body: Record<string, unknown>) {
    return this.call<Scan>('startScan', { body })
  }

  getScan(scanId: string, wait?: number) {
    return this.call<Scan>('getScan', { path: { scanId }, query: { wait } })
  }

  listScans(query: QueryParams = {}) {
    return this.call<Page<ScanSummary>>('listScans', { query })
  }

  cancelScan(scanId: string) {
    return this.call<Scan>('cancelScan', { path: { scanId } })
  }

  deleteScan(scanId: string) {
    return this.call<JobAccepted & { scan: Scan }>('deleteScan', { path: { scanId } })
  }

  listScanWorkers(scanId: string, query: QueryParams = {}) {
    return this.call<Page<Worker>>('listScanWorkers', { path: { scanId }, query })
  }

  queryAnalyses(
    scanId: string,
    body: { filter: Record<string, unknown>; projection?: Record<string, unknown>; sort?: Record<string, unknown>; limit?: number; afterSeq?: number },
  ) {
    return this.call<AnalysisQueryResult>('queryAnalyses', { path: { scanId }, body })
  }

  aggregateAnalyses(scanId: string, pipeline: Record<string, unknown>[], limit?: number) {
    return this.call<AnalysisAggregateResult>('aggregateAnalyses', { path: { scanId }, body: { pipeline, limit } })
  }

  // ── jobs ──────────────────────────────────────────────────────────────────────────────────────────

  getJob(jobId: string, wait?: number) {
    return this.call<Job>('getJob', { path: { jobId }, query: { wait } })
  }
}
