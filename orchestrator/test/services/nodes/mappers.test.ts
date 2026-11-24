import { describe, expect, it } from 'vitest'
import { toApiDaemonConfig, toApiNode } from '../../../server/services/nodes/mappers'
import type { NodeResolverDoc } from '../../../server/types/documents'
import { at, daemonConfigDoc, nodeDoc, T0, USER_ID } from './helpers'

// The Node representation (docs/api.md §2): info.resolver with an ISO `since`, and daemonConfig — the report of the
// current daemon instance with the overrides of that instance — only when asked for.

const INSTANCE = 'engine-a:7d1e'

const resolver: NodeResolverDoc = {
  mode: 'iterative',
  state: 'degraded',
  address: '10.10.0.1',
  kept: false,
  error: 'upstreamUnreachable',
  since: at(30),
  ipv6: false,
  upstreamOk: false,
  stats: { queries: 10, cacheHits: 4, lookups: 6, failures: 6, inflight: 0, qps: 0.5, conntrackUsed: 0 },
}

describe('toApiNode', () => {
  it('maps the resolver report with an ISO timestamp and leaves an absent one absent', () => {
    const withResolver = toApiNode(nodeDoc({ info: { ...nodeDoc().info!, resolver } }), 2)
    expect(withResolver.info?.resolver).toEqual({ ...resolver, since: at(30).toISOString() })
    expect(toApiNode(nodeDoc({ info: { ...nodeDoc().info!, resolver: null } }), 0).info?.resolver).toBeNull()
    expect(toApiNode(nodeDoc(), 0).info).not.toHaveProperty('resolver')
  })

  it('adds daemonConfig only when asked for', () => {
    const doc = nodeDoc({ daemonConfig: daemonConfigDoc(INSTANCE) })
    expect(toApiNode(doc, 0)).not.toHaveProperty('daemonConfig')
    expect(toApiNode(doc, 0, { daemonConfig: true }).daemonConfig?.values.maxWorkers).toBe(16)
    expect(toApiNode(nodeDoc(), 0, { daemonConfig: true }).daemonConfig).toBeNull()
  })
})

describe('toApiDaemonConfig', () => {
  it('combines the report of the current instance with its overrides', () => {
    const doc = nodeDoc({
      daemonConfig: daemonConfigDoc(INSTANCE, { appliedOverridesRev: 2, rejected: { dns: { upstreams: 'not allowed on this node' } }, warnings: ['w'] }),
      daemonOverrides: { instanceId: INSTANCE, values: { dns: { upstreams: ['host'] } }, rev: 3, updatedAt: at(10), updatedBy: USER_ID },
    })
    expect(toApiDaemonConfig(doc)).toEqual({
      values: doc.daemonConfig!.values,
      sources: doc.daemonConfig!.sources,
      warnings: ['w'],
      overrides: { dns: { upstreams: ['host'] } },
      overridesRev: 3,
      appliedOverridesRev: 2,
      pending: true,
      rejected: { dns: { upstreams: 'not allowed on this node' } },
      overriddenBy: USER_ID,
      overriddenAt: at(10).toISOString(),
      reportedAt: T0.toISOString(),
    })
  })

  it('is not pending without overrides and ignores those of another instance', () => {
    const doc = nodeDoc({
      daemonConfig: daemonConfigDoc(INSTANCE),
      daemonOverrides: { instanceId: 'engine-a:old', values: { maxWorkers: 2 }, rev: 7, updatedAt: at(10), updatedBy: USER_ID },
    })
    expect(toApiDaemonConfig(doc)).toMatchObject({
      overrides: {},
      overridesRev: 0,
      appliedOverridesRev: 0,
      pending: false,
      overriddenBy: null,
      overriddenAt: null,
    })
  })

  it('is null for a report of another instance or a node without an instance', () => {
    expect(toApiDaemonConfig(nodeDoc({ daemonConfig: daemonConfigDoc('engine-a:old') }))).toBeNull()
    expect(toApiDaemonConfig(nodeDoc({ instance: null, daemonConfig: daemonConfigDoc(INSTANCE) }))).toBeNull()
  })
})
