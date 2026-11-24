import { describe, expect, it } from 'vitest'
import { type NodeMetricsDoc, nodeGaugeSamples } from '../../../server/services/metrics/collect'

// The per-node gauges of /api/metrics (docs/deployment.md §13.1): heartbeat age, free disk, capacity (min of the
// reported value and the admin worker limit) and the node resolver gauges of online nodes.

const NOW = Date.parse('2026-10-21T10:01:00.000Z')

function node(name: string, overrides: Partial<NodeMetricsDoc> = {}): NodeMetricsDoc {
  return {
    name,
    state: 'online',
    lastSeenAt: new Date(NOW - 15_000),
    maxWorkers: null,
    info: { diskFreeBytes: 100, maxWorkers: 8, resolver: { state: 'ready', stats: { queries: 1000, cacheHits: 750, qps: 12.5 } } },
    ...overrides,
  }
}

describe('nodeGaugeSamples', () => {
  it('samples heartbeat, disk and capacity of every node with info', () => {
    const samples = nodeGaugeSamples([node('a', { maxWorkers: 4 }), node('b', { state: 'pending', lastSeenAt: null, info: null })], NOW)
    expect(samples.states).toEqual(
      new Map([
        ['online', 1],
        ['pending', 1],
      ]),
    )
    expect(samples.heartbeat).toEqual([[{ node: 'a' }, 15]])
    expect(samples.disk).toEqual([[{ node: 'a' }, 100]])
    expect(samples.capacity).toEqual([[{ node: 'a' }, 4]])
  })

  it('samples the node resolver of online nodes', () => {
    const samples = nodeGaugeSamples(
      [
        node('ready'),
        node('failed', { info: { diskFreeBytes: 1, maxWorkers: 1, resolver: { state: 'failed', stats: null } } }),
        node('idle', { info: { diskFreeBytes: 1, maxWorkers: 1, resolver: { state: 'ready', stats: { queries: 0, cacheHits: 0, qps: 0 } } } }),
        node('offline', { state: 'offline' }),
        node('old-daemon', { info: { diskFreeBytes: 1, maxWorkers: 1 } }),
        node('invalid-report', { info: { diskFreeBytes: 1, maxWorkers: 1, resolver: null } }),
      ],
      NOW,
    )
    expect(samples.resolverReady).toEqual([
      [{ node: 'ready' }, 1],
      [{ node: 'failed' }, 0],
      [{ node: 'idle' }, 1],
    ])
    expect(samples.resolverQps).toEqual([
      [{ node: 'ready' }, 12.5],
      [{ node: 'idle' }, 0],
    ])
    expect(samples.resolverCacheHitRatio).toEqual([[{ node: 'ready' }, 0.75]])
  })
})
