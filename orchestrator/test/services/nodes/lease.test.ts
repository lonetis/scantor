import { describe, expect, it } from 'vitest'
import { checkLeaseHolder, engineIdOf, evaluateHelloLease, leaseRemainingMs, type NodeInstance } from '../../../server/services/nodes/lease'
import { at, T0 } from './helpers'

// The node instance lease (docs/nodes.md §5.2, docs/api.md §7.1, security.md MC-6): one daemon instance per node; a
// restarted daemon on the same Docker engine takes the lease over at once, a live lease of another engine is a 409
// with the remaining lease time, an expired lease is granted to anyone.

const OFFLINE_AFTER_MS = 60_000

function instance(id: string, lastSeenAt: Date = T0): NodeInstance {
  return { id, version: '1.4.0', startedAt: T0, lastSeenAt }
}

describe('engineIdOf', () => {
  it('is the instance id without its boot nonce', () => {
    expect(engineIdOf('4c6f2b1e-9a8d-4e7f-b6c5-3d2e1f0a9b8c:7d1e')).toBe('4c6f2b1e-9a8d-4e7f-b6c5-3d2e1f0a9b8c')
    // Older engines used colon-separated ids: the nonce is after the last colon.
    expect(engineIdOf('ABCD:EFGH:IJKL:1234')).toBe('ABCD:EFGH:IJKL')
    expect(engineIdOf('no-nonce')).toBe('no-nonce')
  })
})

describe('evaluateHelloLease', () => {
  it('grants a node without a lease', () => {
    expect(evaluateHelloLease(null, 'engine-a:1', T0, OFFLINE_AFTER_MS)).toEqual({ kind: 'grant', takeover: false })
  })

  it('grants the lease holder itself', () => {
    expect(evaluateHelloLease(instance('engine-a:1'), 'engine-a:1', at(5), OFFLINE_AFTER_MS)).toEqual({ kind: 'grant', takeover: false })
  })

  it('lets a restarted daemon on the same engine take the lease over at once', () => {
    expect(evaluateHelloLease(instance('engine-a:1'), 'engine-a:2', at(5), OFFLINE_AFTER_MS)).toEqual({ kind: 'grant', takeover: true })
  })

  it('refuses another engine while the lease lives, with the remaining time', () => {
    expect(evaluateHelloLease(instance('engine-a:1'), 'engine-b:1', at(15), OFFLINE_AFTER_MS)).toEqual({ kind: 'conflict', retryAfterMs: 45_000 })
  })

  it('grants another engine once the lease expired', () => {
    expect(evaluateHelloLease(instance('engine-a:1'), 'engine-b:1', at(60), OFFLINE_AFTER_MS)).toEqual({ kind: 'grant', takeover: false })
    expect(evaluateHelloLease(instance('engine-a:1'), 'engine-b:1', at(120), OFFLINE_AFTER_MS)).toEqual({ kind: 'grant', takeover: false })
  })
})

describe('checkLeaseHolder', () => {
  it('accepts only the lease holder on later requests', () => {
    expect(checkLeaseHolder(instance('engine-a:1'), 'engine-a:1', at(5), OFFLINE_AFTER_MS)).toEqual({ ok: true })
    expect(checkLeaseHolder(instance('engine-a:2'), 'engine-a:1', at(5), OFFLINE_AFTER_MS)).toEqual({ ok: false, retryAfterMs: 55_000 })
    expect(checkLeaseHolder(instance('engine-a:1'), null, at(5), OFFLINE_AFTER_MS)).toEqual({ ok: false, retryAfterMs: 55_000 })
    expect(checkLeaseHolder(null, 'engine-a:1', at(5), OFFLINE_AFTER_MS)).toEqual({ ok: false, retryAfterMs: 0 })
  })

  it('keeps accepting the holder after the lease expired (a healed partition)', () => {
    expect(checkLeaseHolder(instance('engine-a:1'), 'engine-a:1', at(600), OFFLINE_AFTER_MS)).toEqual({ ok: true })
  })

  it('computes the remaining lease time', () => {
    expect(leaseRemainingMs(instance('x:1'), at(10), OFFLINE_AFTER_MS)).toBe(50_000)
    expect(leaseRemainingMs(instance('x:1'), at(90), OFFLINE_AFTER_MS)).toBe(0)
  })
})
