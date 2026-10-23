import { randomBytes, randomUUID } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import type { Node, NodeInfo, NodeWithToken } from '#shared/types/nodes'
import { ApiClient, ApiError, ok, type ApiResponse, type CallOptions } from './api-client'
import { stateContext } from './api-platform-tenant'
import type { OpenApiIndex } from './openapi'
import { SMALL_SETTINGS } from './scans'
import { deleteTaskOrLeaveToPurge } from './api-platform-cleanup'
import { exampleTaskDir, uploadAndPublish, type UploadedTask } from './tasks'
import { unique } from './unique'
import { newApiContext } from './users'

// The machine side of the platform for API tests (writer api-platform): a fake node daemon that speaks the node API
// (docs/api.md §7) with a node token, so placement, assignments, worker tokens and registry grants can be tested
// without containers; a runtime client that speaks the runtime API (docs/api.md §8) with the worker tokens the
// assignments carry; and raw registry token requests (docs/api.md §6). Fake nodes get a unique pool, so only scans
// whose nodeSelector names that pool are placed on them; they are deleted at the end of the test.

/** A worker of the desired set (docs/api.md §7.2). */
export interface Assignment {
  workerId: string
  scanId: string
  userId: string
  role: 'scheduler' | 'runner'
  specHash: string
  image: string
  baseImage: string | null
  processes: number
  resources: { nanoCpus: number; memoryBytes: number }
  privileged: boolean
  dindMode: 'sysbox' | 'privileged' | null
  capAdd: string[]
  env: Record<string, string>
}

export interface LogRequest {
  requestId: string
  workerId: string
  tailBytes: number
}

export interface AssignmentsResponse {
  serverTime: number
  rev: number
  workers: Assignment[]
  logRequests: LogRequest[]
}

export interface HelloResponse {
  serverTime: number
  node: { id: string; name: string; builtIn: boolean; endpointProfile: 'internal' | 'public'; pool: string; labels: Record<string, string> }
  config: {
    statusIntervalMs: number
    assignmentsWaitSeconds: number
    offlineAfterMs: number
    drainGraceMs: number
    registry: { host: string; username: string }
    minFreeDiskBytes: number
  }
}

/** One entry of a status report (docs/api.md §7.3). */
export interface WorkerReport {
  workerId: string
  state: 'pulling' | 'starting' | 'running' | 'backoff' | 'stopping' | 'removed' | 'error'
  containerId?: string
  startedAt?: string
  restarts?: number
  applied?: { processes: number; nanoCpus: number; memoryBytes: number }
}

/** What a daemon reports about its host in hello (docs/api.md §7.1). */
export type HostInfo = Omit<NodeInfo, 'version' | 'clockOffsetMs'>

const GIB = 1024 * 1024 * 1024

/** The version every machine client of the suite sends: the orchestrator's own (the same minor is always accepted). */
export async function serverVersion(api: ApiClient): Promise<string> {
  return ok(await api.getHealth(), 'getHealth').version
}

/** The built-in node (read-only: tests never change it). */
export async function builtinNode(adminApi: ApiClient): Promise<Node> {
  const nodes = ok(await adminApi.listNodes(), 'listNodes').items
  const builtin = nodes.find((node) => node.builtIn)
  if (!builtin) throw new Error('the built-in node is missing')
  return builtin
}

/**
 * Plays the node daemon of one node: an engine id (stable per host), a boot nonce (new at every daemon start) and
 * the node token. Calls go through the generic client, so 2xx bodies are checked against the OpenAPI document.
 */
export class FakeDaemon {
  nonce = randomBytes(4).toString('hex')

  constructor(
    readonly api: ApiClient,
    public token: string,
    readonly version: string,
    readonly engineId: string = randomUUID(),
  ) {}

  /** `<engine id>:<nonce>` (docs/api.md §7.1) */
  get instanceId(): string {
    return `${this.engineId}:${this.nonce}`
  }

  /** A daemon restart on the same engine: a new nonce. */
  restart(): void {
    this.nonce = randomBytes(4).toString('hex')
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'User-Agent': `scantor-node/${this.version}`,
      'X-Scantor-Version': this.version,
      'X-Scantor-Instance-Id': this.instanceId,
      ...extra,
    }
  }

  call<T>(operationId: string, options: CallOptions = {}): Promise<ApiResponse<T>> {
    return this.api.call<T>(operationId, { ...options, headers: this.headers(options.headers) })
  }

  hello(info: HostInfo, containers: { workerId: string; containerId: string; state: string; specHash: string }[] = []) {
    return this.call<HelloResponse>('nodeHello', { body: { instanceId: this.instanceId, version: this.version, info, containers } })
  }

  assignments(query: { rev?: number; wait?: number } = {}) {
    return this.call<AssignmentsResponse>('getNodeAssignments', { query })
  }

  status(info: HostInfo, workers: WorkerReport[], options: { appliedRev?: number; clockOffsetMs?: number } = {}) {
    return this.call<{ serverTime: number; rev: number; nextStatusMs: number }>('postNodeStatus', {
      body: {
        instanceId: this.instanceId,
        appliedRev: options.appliedRev ?? 0,
        clockOffsetMs: options.clockOffsetMs ?? 0,
        info: {
          version: this.version,
          cpus: info.cpus,
          memoryBytes: info.memoryBytes,
          diskFreeBytes: info.diskFreeBytes,
          dindMode: info.dindMode,
          maxWorkers: info.maxWorkers,
          egressDenyApplied: info.egressDenyApplied,
        },
        workers,
      },
    })
  }

  logs(workerId: string, body: { requestId: string; text: string; bytes: number; truncated: boolean; collectedAt: string }) {
    return this.call('postWorkerLogs', { path: { workerId }, body })
  }
}

export interface FakeNodeOptions {
  /** default: a unique pool, so only scans that select it are placed here */
  pool?: string
  labels?: Record<string, string>
  maxWorkers?: number
  /** capacity reported in hello; os/arch default to the built-in node's platform (the task images' platform) */
  info?: Partial<HostInfo>
}

/**
 * A remote node created by the admin plus the daemon that serves it. `online()` says hello and starts a heartbeat
 * (a status report every few seconds, well inside SCANTOR_NODE_OFFLINE_AFTER) that reports the workers in
 * `reports`. `dispose()` stops the heartbeat and deletes the node (its workers become lost).
 */
export class FakeNode {
  readonly reports = new Map<string, WorkerReport>()
  /** unexpected heartbeat answers (a heartbeat that gets 401 after a revoke stops quietly) */
  readonly heartbeatErrors: string[] = []
  private timer: NodeJS.Timeout | null = null
  private beating: Promise<void> | null = null
  private disposed = false

  private constructor(
    private readonly adminApi: ApiClient,
    private readonly context: APIRequestContext,
    readonly created: NodeWithToken,
    readonly daemon: FakeDaemon,
    readonly info: HostInfo,
  ) {}

  static async create(adminApi: ApiClient, openapi: OpenApiIndex, options: FakeNodeOptions = {}): Promise<FakeNode> {
    const builtin = await builtinNode(adminApi)
    const version = await serverVersion(adminApi)
    const name = unique('fake-node')
    const created = ok(
      await adminApi.createNode({ name, pool: options.pool ?? unique('pool'), labels: options.labels, maxWorkers: options.maxWorkers }),
      'createNode',
    )
    const context = await newApiContext()
    const info: HostInfo = {
      hostname: name,
      os: builtin.info?.os ?? 'linux',
      arch: builtin.info?.arch ?? 'amd64',
      kernel: '6.8.0-scantor-test',
      dockerVersion: '29.9.2',
      cpus: 8,
      memoryBytes: 16 * GIB,
      diskFreeBytes: 100 * GIB,
      dindMode: 'disabled',
      maxWorkers: 8,
      egressDenyApplied: true,
      ...options.info,
    }
    return new FakeNode(adminApi, context, created, new FakeDaemon(new ApiClient(context, openapi), created.token, version), info)
  }

  get id(): string {
    return this.created.node.id
  }

  get name(): string {
    return this.created.node.name
  }

  get pool(): string {
    return this.created.node.pool
  }

  /** A second daemon process with this node's token (another engine unless `engineId` is given). */
  otherDaemon(engineId?: string): FakeDaemon {
    return new FakeDaemon(this.daemon.api, this.daemon.token, this.daemon.version, engineId)
  }

  /** Says hello (the node becomes online) and starts the heartbeat. */
  async online(heartbeatMs = 4000): Promise<HelloResponse> {
    const hello = ok(await this.daemon.hello(this.info), 'nodeHello')
    this.startHeartbeat(heartbeatMs)
    return hello
  }

  /** From now on the heartbeat reports these workers as running containers (a draining one then never counts as gone). */
  reportRunning(...assignments: Assignment[]): void {
    for (const assignment of assignments) {
      this.reports.set(assignment.workerId, {
        workerId: assignment.workerId,
        state: 'running',
        containerId: randomBytes(32).toString('hex'),
        startedAt: new Date().toISOString(),
        restarts: 0,
        applied: { processes: assignment.processes, nanoCpus: assignment.resources.nanoCpus, memoryBytes: assignment.resources.memoryBytes },
      })
    }
  }

  /** Sends one status report now (the reports of `reports`). */
  async report(): Promise<void> {
    ok(await this.daemon.status(this.info, [...this.reports.values()]), 'postNodeStatus')
  }

  startHeartbeat(intervalMs = 4000): void {
    this.stopTimer()
    this.timer = setInterval(() => {
      if (this.beating) return
      this.beating = this.beat().finally(() => {
        this.beating = null
      })
    }, intervalMs)
  }

  private async beat(): Promise<void> {
    try {
      const response = await this.daemon.status(this.info, [...this.reports.values()])
      if (response.status === 401 || response.status === 409) {
        this.stopTimer()
      } else if (response.status !== 200) {
        this.heartbeatErrors.push(`status answered ${response.status}: ${JSON.stringify(response.body)}`)
      }
    } catch (error) {
      // The context is disposed while a beat is in flight at the end of a test.
      if (this.timer) this.heartbeatErrors.push(String(error))
    }
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async stopHeartbeat(): Promise<void> {
    this.stopTimer()
    await this.beating
  }

  /** Long-polls the assignments until `accept` holds; returns that response. */
  async waitForAssignments(accept: (response: AssignmentsResponse) => boolean, timeoutMs = 90_000): Promise<AssignmentsResponse> {
    const deadline = Date.now() + timeoutMs
    let rev = -1
    for (;;) {
      const remaining = Math.ceil((deadline - Date.now()) / 1000)
      const response = ok(await this.daemon.assignments({ rev, wait: Math.max(1, Math.min(20, remaining)) }), 'getNodeAssignments')
      if (accept(response)) return response
      rev = response.rev
      if (Date.now() >= deadline) {
        throw new Error(`the assignments of node ${this.name} did not match within ${timeoutMs / 1000} s; last: ${JSON.stringify(response)}`)
      }
    }
  }

  /** Waits until the scan's scheduler and `runners` runners are assigned to this node. */
  async waitForScanWorkers(
    scanId: string,
    runners = 1,
    timeoutMs = 90_000,
  ): Promise<{ scheduler: Assignment; runners: Assignment[]; response: AssignmentsResponse }> {
    const response = await this.waitForAssignments((current) => {
      const mine = current.workers.filter((worker) => worker.scanId === scanId)
      return mine.some((worker) => worker.role === 'scheduler') && mine.filter((worker) => worker.role === 'runner').length >= runners
    }, timeoutMs)
    const mine = response.workers.filter((worker) => worker.scanId === scanId)
    return { scheduler: mine.find((worker) => worker.role === 'scheduler')!, runners: mine.filter((worker) => worker.role === 'runner'), response }
  }

  /** Stops the heartbeat and deletes the node (a node that is already gone counts as deleted). Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.stopHeartbeat()
    try {
      const response = await this.adminApi.deleteNode(this.id)
      if (response.status !== 204 && response.status !== 404) throw new ApiError(`deleteNode ${this.name}`, response)
    } finally {
      await this.context.dispose()
    }
  }
}

/**
 * The nodes one test creates: plain node records (`create`) and fake nodes with a daemon (`fake`). `dispose()` deletes
 * every one of them (body of a test-scoped fixture); a node the test deleted itself counts as deleted.
 */
export class NodeTracker {
  private readonly records: string[] = []
  private readonly fakes: FakeNode[] = []

  constructor(
    private readonly adminApi: ApiClient,
    private readonly openapi: OpenApiIndex,
  ) {}

  /** createNode as the admin; the record is deleted at teardown when the call succeeded. */
  async create(body: { name: string; pool?: string; labels?: Record<string, string>; maxWorkers?: number }): Promise<ApiResponse<NodeWithToken>> {
    const response = await this.adminApi.createNode(body)
    if (response.status === 201) this.records.push(response.body.node.id)
    return response
  }

  async fake(options: FakeNodeOptions = {}): Promise<FakeNode> {
    const node = await FakeNode.create(this.adminApi, this.openapi, options)
    this.fakes.push(node)
    return node
  }

  async dispose(): Promise<void> {
    const failures: unknown[] = []
    for (const node of this.fakes) await node.dispose().catch((error: unknown) => failures.push(error))
    for (const nodeId of this.records) {
      const response = await this.adminApi.deleteNode(nodeId)
      if (response.status !== 204 && response.status !== 404) failures.push(new ApiError(`deleteNode ${nodeId}`, response))
    }
    if (failures.length > 0) throw new AggregateError(failures, 'deleting the nodes of the test failed')
  }
}

/** Scan settings that place the scan's workers only on `node` (its unique pool). */
export function settingsOn(node: FakeNode, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...SMALL_SETTINGS, ...overrides, nodeSelector: { pool: node.pool, labels: {} } }
}

// ── runtime API ─────────────────────────────────────────────────────────────

/** The runtime of one worker: every call carries its worker token (docs/api.md §8). */
export class FakeRuntime {
  constructor(
    readonly api: ApiClient,
    readonly token: string,
    readonly version: string,
  ) {}

  static of(api: ApiClient, assignment: Assignment, version: string): FakeRuntime {
    const token = assignment.env.SCANTOR_WORKER_TOKEN
    if (!token) throw new Error(`assignment ${assignment.workerId} carries no worker token`)
    return new FakeRuntime(api, token, version)
  }

  call<T>(operationId: string, options: CallOptions = {}): Promise<ApiResponse<T>> {
    return this.api.call<T>(operationId, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'User-Agent': `scantor-runtime/${this.version}`,
        'X-Scantor-Version': this.version,
        ...options.headers,
      },
    })
  }

  bootstrap() {
    return this.call<Record<string, unknown> & { action: 'run' | 'drain' | 'stop' }>('runtimeBootstrap')
  }
}

/** A ScantorError of the runtime (docs/runtime.md §9). */
export function runtimeError(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'platform',
    phase: 'bootstrap',
    message: 'connector did not send hello within 30s',
    retryable: false,
    attempt: 0,
    at: new Date().toISOString(),
    ...overrides,
  }
}

// ── registry token realm ────────────────────────────────────────────────────

export interface RegistryAnswer {
  status: number
  body: Record<string, unknown>
  headers: Record<string, string>
}

export interface RegistryAccess {
  type: string
  name: string
  actions: string[]
}

export interface RegistryClaims {
  iss: string
  sub: string
  aud: string
  iat: number
  nbf: number
  exp: number
  jti: string
  access: RegistryAccess[]
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

async function registryAnswer(response: Awaited<ReturnType<APIRequestContext['fetch']>>): Promise<RegistryAnswer> {
  const raw = await response.body()
  const headers = response.headers()
  const body = (headers['content-type'] ?? '').includes('json') && raw.length > 0 ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : {}
  return { status: response.status(), body, headers }
}

/** `GET /api/registry/token` (docs/api.md §6) with Basic credentials and repeated `scope` values. */
export async function registryTokenGet(
  request: APIRequestContext,
  credential: { username: string; password: string } | null,
  query: { service?: string; scopes?: string[]; extra?: Record<string, string> } = {},
): Promise<RegistryAnswer> {
  const params = new URLSearchParams()
  params.set('service', query.service ?? 'scantor-registry')
  for (const scope of query.scopes ?? []) params.append('scope', scope)
  for (const [key, value] of Object.entries(query.extra ?? {})) params.set(key, value)
  const response = await request.fetch(`/api/registry/token?${params.toString()}`, {
    method: 'GET',
    headers: credential ? { Authorization: basic(credential.username, credential.password) } : {},
    maxRedirects: 0,
  })
  return registryAnswer(response)
}

/** `POST /api/registry/token` with an OAuth2 password grant form (or a raw body). */
export async function registryTokenPost(
  request: APIRequestContext,
  form: URLSearchParams | Buffer,
  headers: Record<string, string> = {},
): Promise<RegistryAnswer> {
  const response = await request.fetch('/api/registry/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    data: Buffer.isBuffer(form) ? form : Buffer.from(form.toString(), 'utf8'),
    maxRedirects: 0,
  })
  return registryAnswer(response)
}

/** Decodes a JWT without verifying it (the registry verifies; tests read the claims). */
export function decodeJwt<T = RegistryClaims>(token: string): { header: Record<string, unknown>; claims: T } {
  const [header, claims] = token.split('.')
  if (!header || !claims) throw new Error(`not a JWT: ${token.slice(0, 40)}…`)
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as T,
  }
}

/** The repository of a task's images in the platform registry. */
export const taskRepository = (taskId: string) => `tasks/${taskId}`

// ── a ready echo revision per Playwright worker ─────────────────────────────

/**
 * Uploads the `echo` example once for the worker's tenant and publishes a ready revision; deletes the task at worker
 * teardown, or leaves it to the tenant's purge while a scan of it is still being deleted
 * (helpers/api-platform-cleanup.ts). Body of a worker-scoped fixture.
 */
export async function withEchoTask(storageState: string, openapi: OpenApiIndex, use: (task: UploadedTask) => Promise<void>): Promise<void> {
  const context = await stateContext(storageState)
  const api = new ApiClient(context, openapi)
  const name = unique('echo-platform')
  try {
    const task = await uploadAndPublish(api, exampleTaskDir('echo'), name)
    await use(task)
    await deleteTaskOrLeaveToPurge(api, name)
  } finally {
    await context.dispose()
  }
}
