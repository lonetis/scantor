import { effectScope, nextTick, ref, toValue, type MaybeRefOrGetter } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCursorList } from '../../app/composables/useCursorList'
import { useWorkers } from '../../app/composables/useWorkers'

// The workers tab (docs/ui.md §5.13.5, FEATURES UI-RES-018): the list loads while the tab is visible and reloads on
// every filter change, also for a finished scan, whose list is not polled.

interface Request {
  path: string
  state: readonly string[]
  cursor: string | null
}

let requests: Request[]
let pollEnabled: () => boolean

beforeEach(() => {
  requests = []
  vi.stubGlobal('useCursorList', useCursorList)
  vi.stubGlobal('apiQuery', (query: Record<string, unknown>) => query)
  vi.stubGlobal('useApi', () => async (path: string, options: { query: { state: readonly string[], cursor: string | null } }) => {
    requests.push({ path, state: options.query.state, cursor: options.query.cursor })
    return { items: options.query.state.map((state) => ({ id: `${path}:${state}` })), nextCursor: null }
  })
  vi.stubGlobal('usePoll', (_fn: unknown, options: { enabled: MaybeRefOrGetter<boolean> }) => {
    pollEnabled = () => toValue(options.enabled)
    return { running: ref(false), refresh: async () => {} }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function settle(): Promise<void> {
  for (let tick = 0; tick < 3; tick++) await nextTick()
}

function setup(live: boolean) {
  const scanId = ref('scan-1')
  const state = ref<string[]>(['running'])
  const visible = ref(false)
  const isLive = ref(live)
  const scope = effectScope()
  const workers = scope.run(() => useWorkers(scanId, { state: state as never, enabled: visible, live: isLive }))!
  return { scanId, state, visible, isLive, scope, workers }
}

describe('useWorkers', () => {
  it('reloads the workers of a finished scan when the state filter changes (UI-RES-018)', async () => {
    const { state, visible, scope, workers } = setup(false)
    await settle()
    expect(requests).toEqual([])

    visible.value = true
    await settle()
    expect(requests.map((request) => request.state)).toEqual([['running']])
    expect(pollEnabled()).toBe(false)

    state.value = []
    await settle()
    expect(requests.map((request) => request.state)).toEqual([['running'], []])
    state.value = ['stopped', 'failed']
    await settle()
    expect(requests.at(-1)).toEqual({ path: '/api/scans/scan-1/workers', state: ['stopped', 'failed'], cursor: null })
    expect(workers.items.value).toEqual([{ id: '/api/scans/scan-1/workers:stopped' }, { id: '/api/scans/scan-1/workers:failed' }])
    expect(pollEnabled()).toBe(false)
    scope.stop()
  })

  it('re-reads a finished scan once when its tab opens again', async () => {
    const { visible, scope } = setup(false)
    visible.value = true
    await settle()
    visible.value = false
    await settle()
    expect(requests).toHaveLength(1)
    visible.value = true
    await settle()
    expect(requests).toHaveLength(2)
    scope.stop()
  })

  it('polls a live scan while its tab is visible and leaves the reopen to the poll', async () => {
    const { visible, isLive, scope } = setup(true)
    expect(pollEnabled()).toBe(false)
    visible.value = true
    await settle()
    expect(requests).toHaveLength(1)
    expect(pollEnabled()).toBe(true)
    visible.value = false
    await settle()
    expect(pollEnabled()).toBe(false)
    visible.value = true
    await settle()
    expect(requests).toHaveLength(1)
    expect(pollEnabled()).toBe(true)
    isLive.value = false
    expect(pollEnabled()).toBe(false)
    scope.stop()
  })

  it('reads another scan from the start when the tab opens after the scan changed', async () => {
    const { scanId, visible, scope, workers } = setup(false)
    visible.value = true
    await settle()
    visible.value = false
    scanId.value = 'scan-2'
    await settle()
    expect(requests).toHaveLength(1)
    visible.value = true
    await settle()
    expect(requests.at(-1)).toEqual({ path: '/api/scans/scan-2/workers', state: ['running'], cursor: null })
    expect(workers.items.value).toEqual([{ id: '/api/scans/scan-2/workers:running' }])
    scope.stop()
  })
})
