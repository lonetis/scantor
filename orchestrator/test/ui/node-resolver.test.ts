import { describe, expect, it } from 'vitest'
import { resolverErrorText, resolverHealthText, resolverStatRows, resolverWarning } from '../../app/utils/node-resolver'
import type { NodeResolverReport, NodeResolverStats } from '../../shared/types/nodes'

// The node resolver on the node pages (docs/ui.md §5.15, docs/nodes.md §6.11): error codes as readable text, the nodes
// table warning for a resolver that cannot serve, and the statistics of the "Node resolver" card.

function resolver(changes: Partial<NodeResolverReport> = {}): NodeResolverReport {
  return {
    mode: 'recursive',
    state: 'ready',
    address: '10.10.0.1',
    kept: false,
    error: null,
    since: '2026-11-24T08:00:00.000Z',
    spec: `sha256:${'a'.repeat(64)}`,
    ipv6: false,
    upstreamOk: true,
    stats: null,
    ...changes,
  }
}

const STATS: NodeResolverStats = { queries: 120_345, cacheHits: 98_000, lookups: 20_100, failures: 340, inflight: 12, qps: 850.54, conntrackUsed: 0.05 }

describe('resolverErrorText', () => {
  it("renders the error codes as readable text with the daemon's detail", () => {
    expect(resolverErrorText('bindInUse', '10.10.0.1:53')).toBe("Another process holds port 53 on the worker network's gateway (10.10.0.1:53)")
    expect(resolverErrorText('probeFailed')).toMatch(/^Workers cannot reach the resolver/)
    expect(resolverErrorText('upstreamUnreachable', '')).toBe('No upstream or root server answers')
  })

  it('shows an unknown code as it is, without escape sequences, and nothing without an error', () => {
    expect(resolverErrorText('somethingNew\u001B[31m', 'x\u0007')).toBe('SomethingNew (x)')
    expect(resolverErrorText(null)).toBeNull()
    expect(resolverErrorText(undefined, 'detail')).toBeNull()
  })
})

describe('resolverWarning', () => {
  it('warns about a resolver that is failed, degraded or unreachable', () => {
    expect(resolverWarning(resolver({ state: 'failed', error: 'bindInUse' }))).toBe(
      "Node resolver failed: another process holds port 53 on the worker network's gateway",
    )
    expect(resolverWarning(resolver({ state: 'degraded' }))).toBe('Node resolver degraded: no upstream or root server answers')
    expect(resolverWarning(resolver({ state: 'unreachable', error: 'probeFailed' }))).toMatch(/^Node resolver unreachable: workers cannot reach the resolver/)
    expect(resolverWarning(resolver({ state: 'failed' }))).toBe('Node resolver failed: the resolver cannot serve')
  })

  it('stays quiet for the other states and for daemons without a resolver', () => {
    for (const state of ['starting', 'ready', 'disabled'] as const) expect(resolverWarning(resolver({ state }))).toBeNull()
    expect(resolverWarning(null)).toBeNull()
    expect(resolverWarning(undefined)).toBeNull()
  })
})

describe('resolverHealthText', () => {
  it('shows the upstream check and IPv6 use of a resolver with health check output', () => {
    expect(resolverHealthText(resolver({ stats: STATS }))).toEqual({ upstream: 'servers answer', ipv6: 'not used' })
    expect(resolverHealthText(resolver({ stats: STATS, ipv6: true }))).toEqual({ upstream: 'servers answer', ipv6: 'used' })
    expect(resolverHealthText(resolver({ state: 'degraded', error: 'upstreamUnreachable', upstreamOk: false, stats: STATS }))).toEqual({
      upstream: 'no server answers',
      ipv6: 'not used',
    })
    // A resolver kept for existing workers in mode disabled still runs its health check.
    expect(resolverHealthText(resolver({ mode: 'disabled', state: 'disabled', kept: true, stats: STATS }))).toEqual({
      upstream: 'servers answer',
      ipv6: 'not used',
    })
  })

  it('shows unknown while the report cannot know them: starting, disabled, or no health check output', () => {
    const unknown = { upstream: 'unknown', ipv6: 'unknown' }
    // The daemon sends both flags as false without health check output.
    expect(resolverHealthText(resolver({ state: 'starting', upstreamOk: false, stats: null }))).toEqual(unknown)
    expect(resolverHealthText(resolver({ state: 'starting', upstreamOk: false, stats: STATS }))).toEqual(unknown)
    expect(resolverHealthText(resolver({ mode: 'disabled', state: 'disabled', address: undefined, upstreamOk: false, stats: null }))).toEqual(unknown)
    expect(resolverHealthText(resolver({ mode: 'disabled', state: 'disabled', upstreamOk: false, stats: STATS }))).toEqual(unknown)
    expect(resolverHealthText(resolver({ state: 'failed', error: 'crashLoop', upstreamOk: false, stats: null }))).toEqual(unknown)
    expect(resolverHealthText(resolver({ state: 'ready', stats: null }))).toEqual(unknown)
  })
})

describe('resolverStatRows', () => {
  it('shows counts, the cache hit ratio, queries per second and the conntrack usage', () => {
    expect(resolverStatRows(STATS)).toEqual([
      { label: 'Queries', value: '120,345' },
      { label: 'Cache hits', value: '81.4 %', title: '98,000 of 120,345 queries' },
      { label: 'Lookups', value: '20,100' },
      { label: 'Failures', value: '340' },
      { label: 'In flight', value: '12' },
      { label: 'Queries per second', value: '850.5' },
      { label: 'Conntrack usage', value: '5.0 %', warn: false },
    ])
  })

  it('has no ratio before the first query, marks a nearly full conntrack table and an unknown one', () => {
    const rows = (stats: Partial<NodeResolverStats>) => resolverStatRows({ ...STATS, ...stats })
    expect(rows({ queries: 0, cacheHits: 0 }).find((row) => row.label === 'Cache hits')!.value).toBe('–')
    expect(rows({ conntrackUsed: 0.85 }).find((row) => row.label === 'Conntrack usage')).toEqual({ label: 'Conntrack usage', value: '85.0 %', warn: true })
    expect(rows({ conntrackUsed: 0 }).find((row) => row.label === 'Conntrack usage')!.value).toBe('unknown')
  })

  it('has no rows without statistics', () => {
    expect(resolverStatRows(null)).toEqual([])
    expect(resolverStatRows(undefined)).toEqual([])
  })
})
