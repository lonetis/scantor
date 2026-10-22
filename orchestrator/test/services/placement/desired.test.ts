import { describe, expect, it } from 'vitest'
import { desiredProcesses, orderVictims, planDesiredWorkers, wantedWorkers } from '../../../server/services/placement/desired'
import { NodeView } from '../../../server/services/placement/node-view'
import { canonicalJson, specHash } from '../../../server/services/placement/spec'
import { at, node, scan, snapshot, worker } from './helpers'

// Placement phase 1 (docs/nodes.md §12.1): desired worker counts per scan and role, victims on scale-in, the
// processes each worker should run, and the spec hash recorded at placement.

const placed = (id: string, scanId: string, overrides = {}) =>
  worker(id, scanId, { state: 'running', nodeId: 'n1', processes: { desired: 1, assigned: 1, running: 1 }, ...overrides })

describe('wantedWorkers', () => {
  it('wants one scheduler while scheduling is pending or running, plus the runner count, for running scans only', () => {
    expect(wantedWorkers(scan('s1', { schedulingState: 'pending', settings: { workers: 3 } }))).toEqual({ scheduler: 1, runner: 3 })
    expect(wantedWorkers(scan('s1', { schedulingState: 'running', settings: { workers: 3 } }))).toEqual({ scheduler: 1, runner: 3 })
    for (const state of ['done', 'retrying', 'failed'] as const) {
      expect(wantedWorkers(scan('s1', { schedulingState: state, settings: { workers: 3 } }))).toEqual({ scheduler: 0, runner: 3 })
    }
    for (const state of ['creating', 'paused', 'completed', 'failed', 'cancelled', 'deleting', 'deleted'] as const) {
      expect(wantedWorkers(scan('s1', { state }))).toEqual({ scheduler: 0, runner: 0 })
    }
    expect(wantedWorkers(undefined)).toEqual({ scheduler: 0, runner: 0 })
  })

  it('gives runners the scan processes and schedulers one process', () => {
    expect(desiredProcesses(scan('s1', { settings: { processes: 6 } }), 'runner')).toBe(6)
    expect(desiredProcesses(scan('s1', { settings: { processes: 6 } }), 'scheduler')).toBe(1)
  })
})

describe('planDesiredWorkers', () => {
  it('inserts the missing scheduler and runners of a new scan', () => {
    const plan = planDesiredWorkers(snapshot({ scans: [scan('s1', { schedulingState: 'pending', settings: { workers: 2 } })] }))
    expect(plan.inserts).toEqual([
      { scanId: 's1', role: 'scheduler', count: 1 },
      { scanId: 's1', role: 'runner', count: 2 },
    ])
    expect(plan.stops).toEqual([])
    expect(plan.drains).toEqual([])
  })

  it('counts pending … backoff workers, not draining, stopped or lost ones', () => {
    const workers = [
      worker('p', 's1'),
      placed('a', 's1', { state: 'assigned' }),
      placed('d', 's1', { state: 'draining' }),
      placed('x', 's1', { state: 'stopped' }),
      placed('l', 's1', { state: 'lost' }),
    ]
    const plan = planDesiredWorkers(snapshot({ scans: [scan('s1', { schedulingState: 'done', settings: { workers: 4 } })], workers }))
    expect(plan.inserts).toEqual([{ scanId: 's1', role: 'runner', count: 2 }])
  })

  it('drains the scheduler once scheduling is done', () => {
    const plan = planDesiredWorkers(
      snapshot({ scans: [scan('s1', { schedulingState: 'done' })], workers: [placed('sched', 's1', { role: 'scheduler' }), placed('r1', 's1')] }),
    )
    expect(plan.drains).toEqual([{ workerId: 'sched', scanId: 's1', nodeId: 'n1', reason: 'scheduling finished' }])
    expect(plan.inserts).toEqual([])
  })

  it('stops pending workers and drains placed ones of paused, cancelled, terminal and deleted scans', () => {
    for (const [state, reason] of [
      ['paused', 'scan paused'],
      ['cancelled', 'scan cancelled'],
      ['completed', 'scan completed'],
      ['failed', 'scan failed'],
    ] as const) {
      const plan = planDesiredWorkers(snapshot({ scans: [scan('s1', { state })], workers: [worker('p', 's1'), placed('r', 's1')] }))
      expect(plan.stops, state).toEqual([{ workerId: 'p', scanId: 's1' }])
      expect(plan.drains, state).toEqual([{ workerId: 'r', scanId: 's1', nodeId: 'n1', reason }])
    }
    const orphan = planDesiredWorkers(snapshot({ workers: [placed('r', 'gone')] }))
    expect(orphan.drains).toEqual([{ workerId: 'r', scanId: 'gone', nodeId: 'n1', reason: 'scan deleted' }])
  })

  it('picks scale-in victims: pending first, then least busy, then on the most loaded node, then newest', () => {
    const nodes = [node('n1'), node('n2')]
    const workers = [
      placed('busy', 's1', { nodeId: 'n2' }),
      placed('idle-loaded', 's1', { nodeId: 'n1' }),
      placed('idle-empty', 's1', { nodeId: 'n2', createdAt: at(10) }),
      placed('extra-1', 's9', { nodeId: 'n1' }),
      placed('extra-2', 's9', { nodeId: 'n1' }),
      worker('pending', 's1'),
    ]
    const plan = planDesiredWorkers(
      snapshot({ scans: [scan('s1', { schedulingState: 'done', settings: { workers: 2 } }), scan('s9', { schedulingState: 'done', settings: { workers: 2 } })], workers, nodes, busy: { busy: 2 } }),
    )
    expect(plan.stops).toEqual([{ workerId: 'pending', scanId: 's1' }])
    expect(plan.drains).toEqual([{ workerId: 'idle-loaded', scanId: 's1', nodeId: 'n1', reason: 'scaled in' }])
  })

  it('orders victims of equal load by newest first', () => {
    const view = new NodeView([node('n1')], [])
    const victims = orderVictims([placed('old', 's1', { createdAt: at(0) }), placed('new', 's1', { createdAt: at(5) })], {}, view)
    expect(victims.map((victim) => victim.id)).toEqual(['new', 'old'])
  })

  it('updates processes.desired of runners to the scan setting, but not of the scheduler or victims', () => {
    const workers = [placed('r1', 's1', { processes: { desired: 2, assigned: 2, running: 2 } }), placed('sched', 's1', { role: 'scheduler' })]
    const plan = planDesiredWorkers(snapshot({ scans: [scan('s1', { settings: { workers: 1, processes: 4 } })], workers }))
    expect(plan.desiredUpdates).toEqual([{ workerId: 'r1', desired: 4 }])

    const shrinking = planDesiredWorkers(
      snapshot({ scans: [scan('s1', { schedulingState: 'done', settings: { workers: 1, processes: 4 } })], workers: [placed('r1', 's1'), placed('r2', 's1', { createdAt: at(5) })] }),
    )
    expect(shrinking.drains.map((drain) => drain.workerId)).toEqual(['r2'])
    expect(shrinking.desiredUpdates).toEqual([{ workerId: 'r1', desired: 4 }])
  })

  it('changes nothing when the counts match', () => {
    const plan = planDesiredWorkers(snapshot({ scans: [scan('s1')], workers: [placed('sched', 's1', { role: 'scheduler' }), placed('r1', 's1')] }))
    expect(plan).toEqual({ inserts: [], stops: [], drains: [], desiredUpdates: [] })
  })
})

describe('specHash', () => {
  const base = { repository: 'tasks/t1', digest: 'sha256:abc', privileged: false, dindMode: null, capAdd: ['NET_RAW', 'NET_BIND_SERVICE'] }

  it('hashes the canonical JSON of {image, privileged, dindMode, capAdd}', () => {
    const hash = specHash(base)
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(specHash({ ...base, capAdd: ['NET_BIND_SERVICE', 'NET_RAW'] })).toBe(hash)
    expect(specHash({ ...base, dindMode: 'sysbox', privileged: true })).not.toBe(hash)
    expect(specHash({ ...base, digest: 'sha256:def' })).not.toBe(hash)
  })

  it('serializes objects with sorted keys and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: [true, null, { d: 'x', c: undefined }] })).toBe('{"a":[true,null,{"d":"x"}],"b":1}')
  })
})
