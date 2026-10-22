import { describe, expect, it } from 'vitest'
import { type BusyItem, INFLIGHT_STALE_MS, InflightStore } from '../../server/services/inflight'

// The in-memory in-flight store (docs/api.md §4.13 listInflightAnalyses, §8.2): every state poll replaces its
// worker's busy list; stale workers disappear; nothing is persisted.

const SCAN = '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f'
const OTHER_SCAN = '6f2a1d3e-9b8c-4d4e-8f2a-3b4c5d6e7f80'
const T = Date.parse('2026-10-21T10:00:00.000Z')

function busy(seq: number, startedAt: string, progress: unknown = null): BusyItem {
  return { seq, round: 1, attempt: 1, executionId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, startedAt, progress }
}

describe('InflightStore', () => {
  it('lists the busy analyses of a scan sorted by start, with worker and node', () => {
    const store = new InflightStore()
    store.record({ workerId: 'w1', scanId: SCAN, nodeId: 'n1', busy: [busy(7, '2026-10-21T10:00:02.000Z', { fraction: 0.5 })], at: new Date(T) })
    store.record({ workerId: 'w2', scanId: SCAN, nodeId: 'n2', busy: [busy(3, '2026-10-21T10:00:01.000Z')], at: new Date(T + 1000) })
    store.record({ workerId: 'w3', scanId: OTHER_SCAN, nodeId: 'n1', busy: [busy(1, '2026-10-21T10:00:00.000Z')], at: new Date(T) })
    expect(store.scan(SCAN, T + 2000)).toEqual({
      items: [
        { analysisId: `${SCAN}-3`, seq: 3, round: 1, attempt: 1, startedAt: '2026-10-21T10:00:01.000Z', workerId: 'w2', nodeId: 'n2', progress: null },
        { analysisId: `${SCAN}-7`, seq: 7, round: 1, attempt: 1, startedAt: '2026-10-21T10:00:02.000Z', workerId: 'w1', nodeId: 'n1', progress: { fraction: 0.5 } },
      ],
      updatedAt: new Date(T + 1000).toISOString(),
    })
    expect(store.busyCount('w1', T + 2000)).toBe(1)
  })

  it('replaces a worker\'s list on every poll', () => {
    const store = new InflightStore()
    store.record({ workerId: 'w1', scanId: SCAN, nodeId: 'n1', busy: [busy(1, '2026-10-21T10:00:00.000Z'), busy(2, '2026-10-21T10:00:00.000Z')], at: new Date(T) })
    store.record({ workerId: 'w1', scanId: SCAN, nodeId: 'n1', busy: [], at: new Date(T + 5000) })
    expect(store.scan(SCAN, T + 5000).items).toEqual([])
    expect(store.busyCount('w1', T + 5000)).toBe(0)
  })

  it('drops workers that stopped polling and forgets workers explicitly', () => {
    const store = new InflightStore()
    store.record({ workerId: 'w1', scanId: SCAN, nodeId: 'n1', busy: [busy(1, '2026-10-21T10:00:00.000Z')], at: new Date(T) })
    store.record({ workerId: 'w2', scanId: SCAN, nodeId: 'n1', busy: [busy(2, '2026-10-21T10:00:00.000Z')], at: new Date(T) })
    expect(store.scan(SCAN, T + INFLIGHT_STALE_MS + 1)).toEqual({ items: [], updatedAt: null })
    expect(store.busyCount('w1', T + INFLIGHT_STALE_MS + 1)).toBe(0)

    store.record({ workerId: 'w3', scanId: SCAN, nodeId: 'n1', busy: [busy(3, '2026-10-21T10:00:00.000Z')], at: new Date(T) })
    store.forget('w3')
    expect(store.scan(SCAN, T).items).toEqual([])
    expect(store.scan('unknown', T)).toEqual({ items: [], updatedAt: null })
  })
})
