import { computed, ref, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import type { CreateNodeBody, NodeForm, UpdateNodeBody } from '#shared/schemas/nodes'
import { isSlug } from '#shared/utils/slug'
import type { NodeJoin, NodeWithToken, ScantorNode } from '#shared/types/nodes'
import type { ScanWorker } from '#shared/types/workers'
import type { ScantorEvent } from '#shared/types/events'

// Node administration (docs/api.md §4.17, docs/ui.md §5.15). The list and the detail poll every 10 s while the
// page is visible. Mutations throw ApiError so modals can show errors inline; they never toast on their own.

export const NODES_POLL_MS = 10_000

/** The fields of a node form that differ from the node (updateNode takes only changes). */
export function nodeChanges(node: ScantorNode, form: NodeForm): UpdateNodeBody {
  const changes: UpdateNodeBody = {}
  if (form.name !== node.name) changes.name = form.name
  if (form.pool !== node.pool) changes.pool = form.pool
  if (!sameLabels(form.labels, node.labels)) changes.labels = form.labels
  if (form.maxWorkers !== node.maxWorkers) changes.maxWorkers = form.maxWorkers
  if (form.cordoned !== node.cordoned) changes.cordoned = form.cordoned
  return changes
}

function sameLabels(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key])
}

export interface NodeFilters {
  state?: NodeState | null
  pool?: string | null
}

/** Why a typed pool filter cannot be sent (listNodes accepts only pool slugs), or null when it can. */
export function poolFilterProblem(pool: string | null | undefined): string | null {
  const value = pool?.trim() ?? ''
  return value === '' || isSlug(value) ? null : 'A pool is 1–64 lowercase letters, digits or hyphens.'
}

export function useNodes(filters: MaybeRefOrGetter<NodeFilters>) {
  const api = useApi()
  const nodes = shallowRef<ScantorNode[]>([])
  const loaded = ref(false)
  const error = shallowRef<ApiError | null>(null)
  /** Shown at the pool filter; no request is sent while it is set. */
  const filterProblem = computed(() => poolFilterProblem(toValue(filters).pool))
  /** Counts list reads: only the answer of the latest one (the current filters) is applied. */
  let generation = 0

  async function load(options: { background?: boolean } = {}): Promise<void> {
    const current = toValue(filters)
    if (poolFilterProblem(current.pool)) return
    const read = ++generation
    try {
      const result = await api<ItemList<ScantorNode>>('/api/nodes', {
        query: apiQuery({ state: current.state ?? null, pool: current.pool?.trim() || null }),
        background: options.background ?? false,
        toast: false,
      })
      if (read !== generation) return
      nodes.value = result.items
      error.value = null
      loaded.value = true
    } catch (cause) {
      if (read !== generation) return
      error.value = toApiError(cause)
      throw error.value
    }
  }

  const poll = usePoll(() => load({ background: true }), { intervalMs: NODES_POLL_MS })
  // A filter change reads at once, also while a poll is in flight (the poll skips a tick then; its answer is stale).
  watch(() => JSON.stringify(toValue(filters)), () => {
    load().catch((cause: unknown) => console.error('[nodes] loading the nodes failed', cause))
  })

  function replace(node: ScantorNode): void {
    nodes.value = nodes.value.some((item) => item.id === node.id)
      ? nodes.value.map((item) => (item.id === node.id ? node : item))
      : [...nodes.value, node]
  }

  async function createNode(body: CreateNodeBody): Promise<NodeWithToken> {
    const created = await api<NodeWithToken>('/api/nodes', { method: 'POST', body, toast: false })
    replace(created.node)
    return created
  }

  async function updateNode(nodeId: string, body: UpdateNodeBody): Promise<ScantorNode> {
    const node = await api<ScantorNode>(`/api/nodes/${nodeId}`, { method: 'PATCH', body, toast: false })
    replace(node)
    return node
  }

  async function deleteNode(nodeId: string): Promise<void> {
    await api(`/api/nodes/${nodeId}`, { method: 'DELETE' })
    nodes.value = nodes.value.filter((node) => node.id !== nodeId)
  }

  async function rotateNodeToken(nodeId: string): Promise<NodeWithToken> {
    const rotated = await api<NodeWithToken>(`/api/nodes/${nodeId}/token`, { method: 'POST' })
    replace(rotated.node)
    return rotated
  }

  async function revokeNodeToken(nodeId: string): Promise<ScantorNode> {
    const node = await api<ScantorNode>(`/api/nodes/${nodeId}/token`, { method: 'DELETE' })
    replace(node)
    return node
  }

  async function getNodeJoin(nodeId: string): Promise<NodeJoin> {
    return api<NodeJoin>(`/api/nodes/${nodeId}/join`)
  }

  return {
    nodes,
    loaded,
    error,
    filterProblem,
    refreshing: poll.running,
    refresh: poll.refresh,
    createNode,
    updateNode,
    deleteNode,
    rotateNodeToken,
    revokeNodeToken,
    getNodeJoin,
  }
}

/** One node with its workers and events (`/admin/nodes/:nodeId`). */
export function useNode(nodeId: MaybeRefOrGetter<string>, options: { workerStates: MaybeRefOrGetter<WorkerState[]> }) {
  const api = useApi()
  const node = shallowRef<ScantorNode | null>(null)
  const error = shallowRef<ApiError | null>(null)

  const workers = useCursorList<ScanWorker>(
    (cursor) =>
      api<Page<ScanWorker>>(`/api/nodes/${toValue(nodeId)}/workers`, {
        query: apiQuery({ state: toValue(options.workerStates), cursor, limit: 50 }),
        background: true,
      }),
    { immediate: false },
  )
  const events = useCursorList<ScantorEvent>(
    (cursor) => api<Page<ScantorEvent>>(`/api/nodes/${toValue(nodeId)}/events`, { query: apiQuery({ cursor, limit: 50 }), background: true }),
    { immediate: false },
  )

  async function load(): Promise<void> {
    try {
      node.value = await api<ScantorNode>(`/api/nodes/${toValue(nodeId)}`, { background: true })
      error.value = null
    } catch (cause) {
      error.value = toApiError(cause)
      throw error.value
    }
    await Promise.all([workers.loaded.value ? workers.refresh() : workers.reset(), events.loaded.value ? events.refresh() : events.reset()])
  }

  const poll = usePoll(load, { intervalMs: NODES_POLL_MS })
  watch(() => toValue(nodeId), () => {
    node.value = null
    void poll.refresh()
  })
  watch(() => toValue(options.workerStates).join(','), () => {
    workers.reset().catch((cause: unknown) => console.error('[nodes] loading workers failed', cause))
  })

  return { node, error, workers, events, refreshing: poll.running, refresh: poll.refresh }
}
