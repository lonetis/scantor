import { describe, expect, it } from 'vitest'
import { updateNodeDaemonOverridesBody } from '../../../shared/schemas/nodes'
import type { DaemonOverrideValues } from '../../../shared/types/nodes'
import {
  assignedDaemonOverrides,
  changedOverrideKeys,
  instanceDaemonConfig,
  instanceOverrides,
  mergeDaemonOverrides,
  overrideAllowed,
  overrideKeys,
  patchedOverrideKeys,
} from '../../../server/services/nodes/overrides'
import type { DaemonOverridesDoc } from '../../../server/types/documents'
import { daemonConfigDoc, nodeDoc, T0, USER_ID } from './helpers'

// Daemon overrides (docs/nodes.md §6.12, docs/api.md §4.17): a JSON merge patch over the overrides of one daemon
// instance, validated again after merging; the keys are the dotted names of schemas/daemon-overrides.json.

const INSTANCE = 'engine-a:7d1e'

function overridesDoc(values: DaemonOverrideValues, rev = 1, instanceId = INSTANCE): DaemonOverridesDoc {
  return { instanceId, values, rev, updatedAt: T0, updatedBy: USER_ID }
}

const patch = (body: unknown) => updateNodeDaemonOverridesBody.parse(body)

describe('mergeDaemonOverrides', () => {
  it('sets values, removes null ones and merges dns key by key', () => {
    const current: DaemonOverrideValues = { maxWorkers: 16, logLevel: 'debug', dns: { mode: 'iterative', maxLookups: 500 } }
    expect(mergeDaemonOverrides(current, patch({ maxWorkers: 8, logLevel: null, dns: { maxLookups: null, upstreamQps: 100 } }))).toEqual({
      maxWorkers: 8,
      dns: { mode: 'iterative', upstreamQps: 100 },
    })
  })

  it('removes every dns override with dns: null and drops an emptied dns object', () => {
    const current: DaemonOverrideValues = { maxWorkers: 16, dns: { mode: 'disabled' } }
    expect(mergeDaemonOverrides(current, patch({ dns: null }))).toEqual({ maxWorkers: 16 })
    expect(mergeDaemonOverrides(current, patch({ dns: { mode: null } }))).toEqual({ maxWorkers: 16 })
    expect(mergeDaemonOverrides({}, patch({ dns: { mode: null } }))).toEqual({})
  })

  it('replaces lists as a whole', () => {
    const current: DaemonOverrideValues = { dns: { upstreams: ['1.1.1.1', '8.8.8.8'], localDomains: ['a.example'] } }
    expect(mergeDaemonOverrides(current, patch({ dns: { upstreams: ['host'] } }))).toEqual({ dns: { upstreams: ['host'], localDomains: ['a.example'] } })
  })

  it('returns the keys in schema order, so equal sets serialize equally', () => {
    const merged = mergeDaemonOverrides({ logLevel: 'warn' }, patch({ maxWorkers: 2, dns: { maxLookups: 10, mode: 'recursive' } }))
    expect(JSON.stringify(merged)).toBe('{"maxWorkers":2,"logLevel":"warn","dns":{"mode":"recursive","maxLookups":10}}')
  })

  it('validates the merged result (stored values from an older schema fail with validationFailed)', () => {
    expect(() => mergeDaemonOverrides({ maxWorkers: 0 }, patch({ logLevel: 'warn' }))).toThrow(expect.objectContaining({ code: 'validationFailed' }))
    expect(() => mergeDaemonOverrides({ retired: 1 } as DaemonOverrideValues, patch({ logLevel: 'warn' }))).toThrow(
      expect.objectContaining({ code: 'validationFailed' }),
    )
  })

  it('never modifies the current overrides', () => {
    const current: DaemonOverrideValues = { dns: { mode: 'iterative' } }
    mergeDaemonOverrides(current, patch({ dns: { mode: 'recursive' } }))
    expect(current).toEqual({ dns: { mode: 'iterative' } })
  })
})

describe('override keys', () => {
  it('lists the dotted keys that hold a value', () => {
    expect(overrideKeys({ maxWorkers: 1, dns: { mode: 'disabled', upstreams: ['host'] }, logLevel: 'info' })).toEqual([
      'maxWorkers',
      'dns.mode',
      'dns.upstreams',
      'logLevel',
    ])
    expect(overrideKeys({})).toEqual([])
    expect(overrideKeys({ dns: {} })).toEqual([])
  })

  it('lists added, changed and removed keys', () => {
    expect(changedOverrideKeys({ maxWorkers: 1, dns: { mode: 'disabled' } }, { maxWorkers: 2, dns: { upstreams: ['host'] } })).toEqual([
      'maxWorkers',
      'dns.mode',
      'dns.upstreams',
    ])
    expect(changedOverrideKeys({ dns: { upstreams: ['host'] } }, { dns: { upstreams: ['host'] } })).toEqual([])
    expect(changedOverrideKeys({ dns: { upstreams: ['1.1.1.1', 'host'] } }, { dns: { upstreams: ['host', '1.1.1.1'] } })).toEqual(['dns.upstreams'])
  })

  it('lists the keys a patch sets, not the ones it removes', () => {
    expect(patchedOverrideKeys(patch({ maxWorkers: 4, logLevel: null, dns: { mode: 'iterative', upstreams: null } }))).toEqual(['maxWorkers', 'dns.mode'])
    expect(patchedOverrideKeys(patch({ dns: null }))).toEqual([])
  })

  it('allows keys by the reported SCANTOR_NODE_OVERRIDES', () => {
    expect(overrideAllowed('all', 'dns.mode')).toBe(true)
    expect(overrideAllowed('none', 'maxWorkers')).toBe(false)
    expect(overrideAllowed(undefined, 'maxWorkers')).toBe(false)
    expect(overrideAllowed(['maxWorkers', 'dns.mode'], 'dns.mode')).toBe(true)
    expect(overrideAllowed(['maxWorkers', 'dns.mode'], 'dns.upstreams')).toBe(false)
  })
})

describe('overrides of the current daemon instance', () => {
  it('belong to the instance that holds the lease only', () => {
    const own = nodeDoc({ daemonOverrides: overridesDoc({ maxWorkers: 4 }, 3), daemonConfig: daemonConfigDoc(INSTANCE) })
    expect(instanceOverrides(own)?.rev).toBe(3)
    expect(instanceDaemonConfig(own)?.instanceId).toBe(INSTANCE)
    expect(assignedDaemonOverrides(own)).toEqual({ rev: 3, values: { maxWorkers: 4 } })

    const stale = nodeDoc({ daemonOverrides: overridesDoc({ maxWorkers: 4 }, 3, 'engine-a:old'), daemonConfig: daemonConfigDoc('engine-a:old') })
    expect(instanceOverrides(stale)).toBeNull()
    expect(instanceDaemonConfig(stale)).toBeNull()
    expect(assignedDaemonOverrides(stale)).toEqual({ rev: 0, values: {} })
  })

  it('are none without an instance or on a node from before daemon overrides', () => {
    expect(assignedDaemonOverrides(nodeDoc({ instance: null, daemonOverrides: overridesDoc({ maxWorkers: 4 }) }))).toEqual({ rev: 0, values: {} })
    const legacy = nodeDoc()
    expect(legacy).not.toHaveProperty('daemonOverrides')
    expect(assignedDaemonOverrides(legacy)).toEqual({ rev: 0, values: {} })
    expect(instanceDaemonConfig(legacy)).toBeNull()
  })
})
