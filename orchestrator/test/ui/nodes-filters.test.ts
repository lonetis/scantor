import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { poolFilterProblem, useNodes, type NodeFilters } from '../../app/composables/useNodes'

// The nodes list filters (docs/ui.md §5.15): a filter change reads the list at once, the answer of an older read never
// replaces a newer one, and a pool that listNodes would reject is explained instead of sent.

interface Pending {
  pool: string | null
  resolve: () => void
}

let pending: Pending[]

beforeEach(() => {
  pending = []
  vi.stubGlobal('apiQuery', (query: Record<string, unknown>) => query)
  vi.stubGlobal('toApiError', (cause: unknown) => cause)
  vi.stubGlobal('usePoll', () => ({ running: ref(false), refresh: async () => {} }))
  vi.stubGlobal('useApi', () => (_path: string, options: { query: { pool: string | null } }) =>
    new Promise((resolve) => pending.push({ pool: options.query.pool, resolve: () => resolve({ items: [{ id: `node-${options.query.pool}` }] }) })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function settle(): Promise<void> {
  for (let tick = 0; tick < 3; tick++) await nextTick()
}

describe('poolFilterProblem', () => {
  it('accepts an empty filter and pool slugs, and explains anything else', () => {
    expect(poolFilterProblem('')).toBeNull()
    expect(poolFilterProblem(' eu-west ')).toBeNull()
    expect(poolFilterProblem('EU')).toMatch(/lowercase letters/)
    expect(poolFilterProblem('eu-')).toMatch(/lowercase letters/)
  })
})

describe('useNodes filters', () => {
  it('reads at once on every change and applies only the latest answer', async () => {
    const filters = ref<NodeFilters>({ pool: '' })
    const list = effectScope().run(() => useNodes(filters))!
    filters.value = { pool: 'a' }
    await settle()
    filters.value = { pool: 'b' }
    await settle()
    expect(pending.map((request) => request.pool)).toEqual(['a', 'b'])
    pending[1]!.resolve()
    await settle()
    pending[0]!.resolve()
    await settle()
    expect(list.nodes.value.map((node) => node.id)).toEqual(['node-b'])
  })

  it('sends no request for an invalid pool and explains it', async () => {
    const filters = ref<NodeFilters>({ pool: '' })
    const list = effectScope().run(() => useNodes(filters))!
    filters.value = { pool: 'EU' }
    await settle()
    expect(pending).toEqual([])
    expect(list.filterProblem.value).toMatch(/lowercase letters/)
  })
})
