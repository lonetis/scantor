import { randomBytes, randomUUID } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import type { Node, NodeInfo, NodeWithToken } from '#shared/types/nodes'
import { ApiClient, ApiError, ok } from './api-client'
import type { OpenApiIndex } from './openapi'
import { SMALL_SETTINGS } from './scans'
import { unique } from './unique'
import { newApiContext } from './users'

// Fake nodes for the placement and worker specs (docs/nodes.md §6, §12): a remote node created by the admin in a pool
// of its own, whose "daemon" is this process speaking the node API (docs/api.md §7.1, §7.3) with the node token. It
// reports the capacity a test chooses and, unless the test sets worker reports, no containers, so the workers placed
// on it stay `assigned` (and drained ones become `stopped` after two reports) while placement decisions are
// observable through the scan, its workers and events. Only scans whose nodeSelector names the node's unique pool are
// ever placed on it.

type HostInfo = Omit<NodeInfo, 'version' | 'clockOffsetMs'>

/** One worker entry of a node status report (docs/api.md §7.3). */
export interface FakeWorkerReport {
  workerId: string
  state: 'pulling' | 'starting' | 'running' | 'backoff' | 'stopping' | 'removed' | 'error'
  containerId?: string
  error?: { code: 'imagePullFailed' | 'createFailed' | 'platformMismatch'; message: string }
}

const GIB = 1024 ** 3

export class FakeNode {
  private timer: NodeJS.Timeout | null = null
  private beating: Promise<void> | null = null
  private disposed = false
  /** the worker entries of every status report */
  private workers: FakeWorkerReport[] = []
  readonly instanceId = `${randomUUID()}:${randomBytes(4).toString('hex')}`

  private constructor(
    private readonly adminApi: ApiClient,
    private readonly context: APIRequestContext,
    private readonly daemon: ApiClient,
    readonly created: NodeWithToken,
    readonly info: HostInfo,
    readonly version: string,
  ) {}

  /** Creates the node (admin) and brings it online: hello, then a status report every 4 s. */
  static async start(adminApi: ApiClient, openapi: OpenApiIndex, options: { pool?: string; info?: Partial<HostInfo> } = {}): Promise<FakeNode> {
    const nodes = ok(await adminApi.listNodes(), 'listNodes').items
    const builtin = nodes.find((node: Node) => node.builtIn)
    const version = ok(await adminApi.getHealth(), 'getHealth').version
    const name = unique('fake-node')
    const created = ok(await adminApi.createNode({ name, pool: options.pool ?? unique('pool') }), 'createNode')
    const context = await newApiContext()
    const info: HostInfo = {
      hostname: name,
      // The platform of the task images (built on the built-in node's engine).
      os: builtin?.info?.os ?? 'linux',
      arch: builtin?.info?.arch ?? 'amd64',
      kernel: '6.8.0-scantor-test',
      dockerVersion: '29.9.2',
      cpus: 16,
      memoryBytes: 32 * GIB,
      diskFreeBytes: 100 * GIB,
      dindMode: 'disabled',
      maxWorkers: 16,
      egressDenyApplied: true,
      ...options.info,
    }
    const node = new FakeNode(adminApi, context, new ApiClient(context, openapi), created, info, version)
    try {
      await node.hello()
      await node.report()
      node.timer = setInterval(() => {
        if (node.beating) return
        node.beating = node
          .report()
          .catch(() => undefined)
          .finally(() => {
            node.beating = null
          })
      }, 4000)
      return node
    } catch (error) {
      await node.dispose()
      throw error
    }
  }

  get id(): string {
    return this.created.node.id
  }

  get pool(): string {
    return this.created.node.pool
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.created.token}`,
      'User-Agent': `scantor-node/${this.version}`,
      'X-Scantor-Version': this.version,
      'X-Scantor-Instance-Id': this.instanceId,
    }
  }

  private async hello(): Promise<void> {
    ok(
      await this.daemon.call('nodeHello', {
        headers: this.headers(),
        body: { instanceId: this.instanceId, version: this.version, info: this.info, containers: [] },
      }),
      'nodeHello',
    )
  }

  /** Reports these worker entries now and in every later status report. */
  async setWorkers(workers: FakeWorkerReport[]): Promise<void> {
    this.workers = workers
    await this.beating
    await this.report()
  }

  /** One status report: the node's capacity and the worker entries the test set (none by default). */
  async report(): Promise<void> {
    const { info } = this
    ok(
      await this.daemon.call('postNodeStatus', {
        headers: this.headers(),
        body: {
          instanceId: this.instanceId,
          appliedRev: 0,
          clockOffsetMs: 0,
          info: {
            version: this.version,
            cpus: info.cpus,
            memoryBytes: info.memoryBytes,
            diskFreeBytes: info.diskFreeBytes,
            dindMode: info.dindMode,
            maxWorkers: info.maxWorkers,
            egressDenyApplied: info.egressDenyApplied,
          },
          workers: this.workers,
        },
      }),
      'postNodeStatus',
    )
  }

  /** The node's desired workers (docs/api.md §7.2), with the worker tokens the runtime API takes. */
  async assignments(): Promise<{ workerId: string; scanId: string; role: string; dindMode: string | null; env: Record<string, string> }[]> {
    const response = await this.daemon.call<{
      workers: { workerId: string; scanId: string; role: string; dindMode: string | null; env: Record<string, string> }[]
    }>('getNodeAssignments', { headers: this.headers(), query: { rev: -1, wait: 0 } })
    return ok(response, 'getNodeAssignments').workers
  }

  /** Calls a runtime API operation (docs/api.md §8) as a worker of this node, with its worker token. */
  runtimeCall<T>(operationId: string, token: string, options: { body?: unknown } = {}) {
    return this.daemon.call<T>(operationId, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': `scantor-runtime/${this.version}`, 'X-Scantor-Version': this.version },
      body: options.body,
    })
  }

  /** Stops the heartbeat and deletes the node (its workers become lost); idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    await this.beating
    try {
      const response = await this.adminApi.deleteNode(this.id)
      if (response.status !== 204 && response.status !== 404) throw new ApiError(`deleteNode ${this.created.node.name}`, response)
    } finally {
      await this.context.dispose()
    }
  }
}

/** The fake nodes of one test; `dispose()` deletes all of them. */
export class FakeNodes {
  private readonly nodes: FakeNode[] = []

  constructor(
    private readonly adminApi: ApiClient,
    private readonly openapi: OpenApiIndex,
  ) {}

  async start(options: { pool?: string; info?: Partial<HostInfo> } = {}): Promise<FakeNode> {
    const node = await FakeNode.start(this.adminApi, this.openapi, options)
    this.nodes.push(node)
    return node
  }

  async dispose(): Promise<void> {
    const errors: unknown[] = []
    for (const node of this.nodes) await node.dispose().catch((error: unknown) => errors.push(error))
    if (errors.length > 0) throw new AggregateError(errors, 'deleting the fake nodes failed')
  }
}

/** Scan settings that select a pool (SMALL_SETTINGS unless overridden). */
export function inPool(pool: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...SMALL_SETTINGS, ...overrides, nodeSelector: { pool, labels: {} } }
}

export const MIB = 1024 ** 2
