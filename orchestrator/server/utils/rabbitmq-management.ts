import { useConfig } from './config'

// Generic client of the RabbitMQ management HTTP API (docs/queue.md §3, §4), used with the admin user for
// vhosts, users, permissions, topic permissions, user limits, queues and alarms. Every call is one request; 404 on
// a delete counts as done.

export const RABBITMQ_VHOST = 'scantor'

export class RabbitmqManagementError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(`RabbitMQ management ${path}: HTTP ${status}${message ? ` ${message}` : ''}`)
    this.name = 'RabbitmqManagementError'
  }
}

export interface RabbitmqUser {
  name: string
  tags: string[] | string
}

export interface RabbitmqPermission {
  user: string
  vhost: string
  configure: string
  write: string
  read: string
}

export interface RabbitmqTopicPermission {
  user: string
  vhost: string
  exchange: string
  write: string
  read: string
}

export interface RabbitmqUserLimit {
  user: string
  value: Record<string, number>
}

export interface RabbitmqQueue {
  name: string
  vhost?: string
  arguments?: Record<string, unknown>
  messages_ready?: number
  messages_unacknowledged?: number
  messages_delayed?: number
  consumers?: number
}

export interface RabbitmqQueuePage {
  items: RabbitmqQueue[]
  page: number
  page_count: number
  total_count?: number
}

export interface RabbitmqNodeAlarms {
  name: string
  mem_alarm: boolean
  disk_free_alarm: boolean
}

const enc = encodeURIComponent

export interface RabbitmqManagementOptions {
  baseUrl: string
  username: string
  password: string
  timeoutMs?: number
}

export class RabbitmqManagement {
  private readonly authorization: string

  constructor(private readonly options: RabbitmqManagementOptions) {
    this.authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T | null> {
    const response = await fetch(`${this.options.baseUrl}/api${path}`, {
      method,
      headers: {
        authorization: this.authorization,
        // Only reads ask for JSON: RabbitMQ 4.4 answers some writes (PUT /api/user-limits/…) with 406 when the
        // request carries `Accept: application/json`.
        ...(method === 'GET' ? { accept: 'application/json' } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    })
    if (okStatuses.includes(response.status)) return null
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, 500)
      throw new RabbitmqManagementError(response.status, path, text)
    }
    if (response.status === 204) return null
    const text = await response.text()
    return text ? (JSON.parse(text) as T) : null
  }

  // vhosts and permissions

  async putVhost(vhost: string, settings: { description?: string; default_queue_type?: string } = {}): Promise<void> {
    await this.request('PUT', `/vhosts/${enc(vhost)}`, settings)
  }

  async putPermissions(vhost: string, user: string, permissions: { configure: string; write: string; read: string }): Promise<void> {
    await this.request('PUT', `/permissions/${enc(vhost)}/${enc(user)}`, permissions)
  }

  async listPermissions(): Promise<RabbitmqPermission[]> {
    return (await this.request<RabbitmqPermission[]>('GET', '/permissions')) ?? []
  }

  async putTopicPermissions(vhost: string, user: string, permission: { exchange: string; write: string; read: string }): Promise<void> {
    await this.request('PUT', `/topic-permissions/${enc(vhost)}/${enc(user)}`, permission)
  }

  async listTopicPermissions(): Promise<RabbitmqTopicPermission[]> {
    return (await this.request<RabbitmqTopicPermission[]>('GET', '/topic-permissions')) ?? []
  }

  // users and limits

  async listUsers(): Promise<RabbitmqUser[]> {
    return (await this.request<RabbitmqUser[]>('GET', '/users')) ?? []
  }

  async putUser(user: string, password: string, tags: string[] = []): Promise<void> {
    await this.request('PUT', `/users/${enc(user)}`, { password, tags })
  }

  /** Deletes a user; live connections of the user are closed by the broker. */
  async deleteUser(user: string): Promise<void> {
    await this.request('DELETE', `/users/${enc(user)}`, undefined, [404])
  }

  async listUserLimits(): Promise<RabbitmqUserLimit[]> {
    return (await this.request<RabbitmqUserLimit[]>('GET', '/user-limits')) ?? []
  }

  async putUserLimit(user: string, limit: 'max-connections' | 'max-channels', value: number): Promise<void> {
    await this.request('PUT', `/user-limits/${enc(user)}/${limit}`, { value })
  }

  // queues

  /** One page of queues of `vhost`, optionally filtered by a name regex. */
  async listQueues(
    vhost: string,
    options: { nameRegex?: string; page?: number; pageSize?: number; columns?: string[] } = {},
  ): Promise<RabbitmqQueuePage> {
    const params = new URLSearchParams({ page: String(options.page ?? 1), page_size: String(options.pageSize ?? 500) })
    if (options.nameRegex) {
      params.set('name', options.nameRegex)
      params.set('use_regex', 'true')
    }
    if (options.columns) params.set('columns', options.columns.join(','))
    return (await this.request<RabbitmqQueuePage>('GET', `/queues/${enc(vhost)}?${params}`)) ?? { items: [], page: 1, page_count: 0 }
  }

  /** Every queue of `vhost` matching `nameRegex`, following pagination. */
  async listAllQueues(vhost: string, options: { nameRegex?: string; columns?: string[] } = {}): Promise<RabbitmqQueue[]> {
    const queues: RabbitmqQueue[] = []
    for (let page = 1; ; page++) {
      const result = await this.listQueues(vhost, { ...options, page })
      queues.push(...result.items)
      if (page >= result.page_count) return queues
    }
  }

  async getQueue(vhost: string, queue: string): Promise<RabbitmqQueue | null> {
    return this.request<RabbitmqQueue>('GET', `/queues/${enc(vhost)}/${enc(queue)}`, undefined, [404])
  }

  async deleteQueue(vhost: string, queue: string): Promise<void> {
    await this.request('DELETE', `/queues/${enc(vhost)}/${enc(queue)}`, undefined, [404])
  }

  // health

  /** Names of active memory or disk alarms (`memory`, `disk`) across the cluster. */
  async activeAlarms(): Promise<('memory' | 'disk')[]> {
    const nodes = (await this.request<RabbitmqNodeAlarms[]>('GET', '/nodes?columns=name,mem_alarm,disk_free_alarm')) ?? []
    const alarms = new Set<'memory' | 'disk'>()
    for (const node of nodes) {
      if (node.mem_alarm) alarms.add('memory')
      if (node.disk_free_alarm) alarms.add('disk')
    }
    return [...alarms]
  }
}

let client: RabbitmqManagement | null = null

/** The management client of the orchestrator's admin user. */
export function useRabbitmqManagement(): RabbitmqManagement {
  if (!client) {
    const config = useConfig()
    client = new RabbitmqManagement({
      baseUrl: config.rabbitmqManagementUrl,
      username: config.rabbitmqUser,
      password: config.rabbitmqPassword,
    })
  }
  return client
}
