import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNode, useNodes } from '../../app/composables/useNodes'

// Daemon overrides from the node pages (docs/ui.md §5.15, docs/api.md §4.17): updateNodeDaemonOverrides and
// deleteNodeDaemonOverrides replace the node with the response, and a poll that read the node before the change never
// puts the old overrides back.

interface Request {
  path: string
  method: string
  body: unknown
  toast: unknown
  resolve: (value: unknown) => void
}

let requests: Request[]
let poll: () => Promise<void>

const NODE_ID = '2d9e3f4a-0b1c-4d2e-8f3a-5b6c7d8e9f01'

beforeEach(() => {
  requests = []
  vi.stubGlobal('apiQuery', (query: Record<string, unknown>) => query)
  vi.stubGlobal('toApiError', (cause: unknown) => cause)
  vi.stubGlobal('useCursorList', () => ({ loaded: ref(true), refresh: async () => {}, reset: async () => {} }))
  vi.stubGlobal('usePoll', (fn: () => Promise<void>) => {
    poll = fn
    return { running: ref(false), refresh: async () => {} }
  })
  vi.stubGlobal(
    'useApi',
    () =>
      (path: string, options: { method?: string; body?: unknown; toast?: unknown } = {}) =>
        new Promise((resolve) => requests.push({ path, method: options.method ?? 'GET', body: options.body, toast: options.toast, resolve })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function settle(): Promise<void> {
  for (let tick = 0; tick < 3; tick++) await nextTick()
}

function nodeWith(rev: number, id = NODE_ID) {
  return { id, name: 'scan-eu-1', daemonConfig: { overridesRev: rev } }
}

describe('useNode daemon overrides', () => {
  it('patches and deletes the overrides of the node and shows the node of the response', async () => {
    const detail = effectScope().run(() => useNode(NODE_ID, { workerStates: [] }))!

    const updated = detail.updateNodeDaemonOverrides(NODE_ID, { maxWorkers: 8, dns: { mode: null } })
    await settle()
    expect(requests.at(-1)).toMatchObject({
      path: `/api/nodes/${NODE_ID}/daemon-overrides`,
      method: 'PATCH',
      body: { maxWorkers: 8, dns: { mode: null } },
      toast: false,
    })
    requests.at(-1)!.resolve(nodeWith(1))
    expect(await updated).toEqual(nodeWith(1))
    expect(detail.node.value).toEqual(nodeWith(1))

    const deleted = detail.deleteNodeDaemonOverrides(NODE_ID)
    await settle()
    // The page confirms first, so a failure toasts like the other confirmed node actions.
    expect(requests.at(-1)).toMatchObject({ path: `/api/nodes/${NODE_ID}/daemon-overrides`, method: 'DELETE', toast: undefined })
    requests.at(-1)!.resolve(nodeWith(2))
    await deleted
    expect(detail.node.value).toEqual(nodeWith(2))
  })

  it('drops a poll that read the node before the change', async () => {
    const detail = effectScope().run(() => useNode(NODE_ID, { workerStates: [] }))!
    const stalePoll = poll()
    await settle()
    const staleRead = requests.at(-1)!
    expect(staleRead).toMatchObject({ path: `/api/nodes/${NODE_ID}`, method: 'GET' })

    const updated = detail.updateNodeDaemonOverrides(NODE_ID, { maxWorkers: 8 })
    await settle()
    requests.at(-1)!.resolve(nodeWith(5))
    await updated
    staleRead.resolve(nodeWith(4))
    await stalePoll
    expect(detail.node.value).toEqual(nodeWith(5))

    const nextPoll = poll()
    await settle()
    requests.at(-1)!.resolve(nodeWith(6))
    await nextPoll
    expect(detail.node.value).toEqual(nodeWith(6))
  })

  it('keeps the node when the response is another node', async () => {
    const detail = effectScope().run(() => useNode(NODE_ID, { workerStates: [] }))!
    const updated = detail.updateNodeDaemonOverrides('00000000-0000-4000-8000-000000000000', { maxWorkers: 8 })
    await settle()
    requests.at(-1)!.resolve(nodeWith(1, '00000000-0000-4000-8000-000000000000'))
    await updated
    expect(detail.node.value).toBeNull()
  })
})

describe('useNodes daemon overrides', () => {
  it('replaces the node in the list with the response', async () => {
    const list = effectScope().run(() => useNodes({}))!
    list.nodes.value = [nodeWith(0) as never, nodeWith(0, 'other') as never]

    const updated = list.updateNodeDaemonOverrides(NODE_ID, { logLevel: 'debug' })
    await settle()
    expect(requests.at(-1)).toMatchObject({ method: 'PATCH', body: { logLevel: 'debug' }, toast: false })
    requests.at(-1)!.resolve(nodeWith(1))
    await updated
    expect(list.nodes.value).toEqual([nodeWith(1), nodeWith(0, 'other')])

    const deleted = list.deleteNodeDaemonOverrides(NODE_ID)
    await settle()
    expect(requests.at(-1)).toMatchObject({ path: `/api/nodes/${NODE_ID}/daemon-overrides`, method: 'DELETE' })
    requests.at(-1)!.resolve(nodeWith(2))
    await deleted
    expect(list.nodes.value).toEqual([nodeWith(2), nodeWith(0, 'other')])
  })
})
