import { describe, expect, it } from 'vitest'
import type { NodeWorkerReport } from '../../../shared/schemas/nodes'
import { boundLogTail, DRAIN_ABSENT_REPORTS, nextWorkerState, planStatus } from '../../../server/services/nodes/status'
import type { WorkerDoc } from '../../../server/types/documents'
import { at, T0, workerDoc } from './helpers'

// Planning of a node status report (docs/api.md §7.3, docs/nodes.md §7, docs/data-model.md §6.6): worker state
// transitions, crash detection (only a new lastExit with exit code ≠ 0 or an OOM kill), image pulls, drains completed
// by `removed` or by absence from two consecutive snapshots, and foreign workers ignored.

const W1 = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const W2 = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const FOREIGN = '3e4f5a6b-7c8d-4e9f-9a0b-1c2d3e4f5a6b'

function plan(workers: WorkerDoc[], reports: NodeWorkerReport[], absences = new Map<string, number>()) {
  return planStatus({ workers, reports, absences, now: at(60) })
}

describe('nextWorkerState', () => {
  it.each([
    ['assigned', 'pulling', 'pulling'],
    ['pulling', 'pulling', null],
    ['assigned', 'starting', 'starting'],
    ['pulling', 'running', 'starting'],
    ['starting', 'running', null],
    ['running', 'running', null],
    ['backoff', 'starting', 'starting'],
    ['backoff', 'running', 'starting'],
    ['starting', 'backoff', 'backoff'],
    ['running', 'backoff', 'backoff'],
    ['backoff', 'backoff', null],
    ['draining', 'removed', 'stopped'],
    ['running', 'removed', null],
    ['draining', 'running', null],
    ['draining', 'backoff', null],
    ['assigned', 'error', null],
    ['running', 'stopping', null],
  ] as const)('%s reported %s → %s', (current, reported, expected) => {
    expect(nextWorkerState(current, reported)).toBe(expected)
  })
})

describe('planStatus', () => {
  it('moves a pulled worker to starting and records the container', () => {
    const result = plan([workerDoc(W1, { state: 'pulling' })], [{ workerId: W1, state: 'running', containerId: 'f1e2d3c4b5a6', startedAt: at(20).toISOString(), restarts: 0, applied: { processes: 2, nanoCpus: 2e9, memoryBytes: 1342177280 } }])
    expect(result.updates).toHaveLength(1)
    const [update] = result.updates
    expect(update!.fromStates).toEqual(['pulling'])
    expect(update!.set).toMatchObject({
      state: 'starting',
      stateReason: null,
      startedAt: at(20),
      'processes.applied': 2,
      container: { id: 'f1e2d3c4b5a6', name: `scantor-w-${W1}`, startedAt: at(20), restarts: 0, lastExit: null, nextRestartAt: null },
    })
    expect(result.pulled.map((worker) => worker._id)).toEqual([W1])
    expect(result.crashes).toEqual([])
  })

  it('keeps a running worker running and only updates details in any active state', () => {
    const known = workerDoc(W1, { state: 'running', container: { id: 'c1', name: `scantor-w-${W1}`, startedAt: T0, restarts: 0, lastExit: null, nextRestartAt: null } })
    const result = plan([known], [{ workerId: W1, state: 'running', containerId: 'c1', restarts: 0, applied: { processes: 3, nanoCpus: 3e9, memoryBytes: 1 } }])
    expect(result.updates[0]!.set.state).toBeUndefined()
    expect(result.updates[0]!.fromStates).toContain('running')
    expect(result.updates[0]!.fromStates).toContain('draining')
    expect(result.updates[0]!.set['processes.applied']).toBe(3)
    expect(result.pulled).toEqual([])
  })

  it('counts the first container of a worker the runtime already bootstrapped as a pulled image', () => {
    // The runtime bootstrapped (assigned → running) before the node reported the container it created.
    const bootstrapped = plan([workerDoc(W1, { state: 'running' })], [{ workerId: W1, state: 'running', containerId: 'c1', restarts: 0 }])
    expect(bootstrapped.pulled.map((worker) => worker._id)).toEqual([W1])
    expect(bootstrapped.updates[0]!.set).toMatchObject({ container: { id: 'c1' } })
    expect(bootstrapped.updates[0]!.set.state).toBeUndefined()
    // Reports without a container never count.
    expect(plan([workerDoc(W1, { state: 'running' })], [{ workerId: W1, state: 'running' }]).pulled).toEqual([])
    expect(plan([workerDoc(W1, { state: 'running' })], [{ workerId: W1, state: 'error', error: { code: 'imagePullFailed', message: 'x' } }]).pulled).toEqual([])
  })

  it('raises a crash for a new non-zero exit, once', () => {
    const exit = { exitCode: 137, oomKilled: true, at: at(58).toISOString(), logTail: 'killed' }
    const first = plan([workerDoc(W1, { state: 'running' })], [{ workerId: W1, state: 'backoff', containerId: 'c1', restarts: 3, lastExit: exit, nextRestartAt: at(98).toISOString() }])
    expect(first.crashes).toEqual([expect.objectContaining({ exitCode: 137, oomKilled: true, restarts: 3, logTail: 'killed', at: at(58) })])
    expect(first.updates[0]!.set).toMatchObject({ state: 'backoff', stateReason: { code: 'crashed', message: 'exited with code 137 (OOM killed)' } })

    // The same exit reported again (the stored lastExit has the same time): no new crash.
    const stored = workerDoc(W1, {
      state: 'backoff',
      container: { id: 'c1', name: `scantor-w-${W1}`, startedAt: T0, restarts: 3, lastExit: { exitCode: 137, oomKilled: true, at: at(58), logTail: 'killed' }, nextRestartAt: at(98) },
    })
    const again = plan([stored], [{ workerId: W1, state: 'backoff', containerId: 'c1', restarts: 3, lastExit: exit, nextRestartAt: at(98).toISOString() }])
    expect(again.crashes).toEqual([])
  })

  it('never treats exit 0 as a crash', () => {
    const result = plan([workerDoc(W1, { state: 'running' })], [{ workerId: W1, state: 'backoff', containerId: 'c1', restarts: 0, lastExit: { exitCode: 0, oomKilled: false, at: at(59).toISOString(), logTail: '' } }])
    expect(result.crashes).toEqual([])
    expect(result.updates[0]!.set).toMatchObject({ state: 'backoff', stateReason: { code: 'exited' } })
  })

  it('treats an OOM kill with exit code 0 as a crash', () => {
    const result = plan([workerDoc(W1, { state: 'running' })], [{ workerId: W1, state: 'backoff', containerId: 'c1', lastExit: { exitCode: 0, oomKilled: true, at: at(59).toISOString(), logTail: '' } }])
    expect(result.crashes).toHaveLength(1)
  })

  it('bounds log tails to 4 KiB on a character boundary', () => {
    const tail = `${'é'.repeat(3000)}end`
    const result = plan([workerDoc(W1, { state: 'running' })], [{ workerId: W1, state: 'backoff', containerId: 'c1', lastExit: { exitCode: 1, oomKilled: false, at: at(59).toISOString(), logTail: tail } }])
    const bounded = result.crashes[0]!.logTail
    expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(4096)
    expect(bounded.endsWith('end')).toBe(true)
    expect(bounded).not.toContain('�')
    expect(boundLogTail('short')).toBe('short')
  })

  it('records pull failures and leaves the state alone', () => {
    const result = plan([workerDoc(W1, { state: 'assigned' })], [{ workerId: W1, state: 'error', error: { code: 'imagePullFailed', message: 'manifest unknown' } }])
    expect(result.pullFailures).toEqual([{ worker: expect.objectContaining({ _id: W1 }), message: 'manifest unknown' }])
    expect(result.updates[0]!.set).toMatchObject({ stateReason: { code: 'imagePullFailed', message: 'manifest unknown' } })
    expect(result.updates[0]!.set.state).toBeUndefined()
  })

  it('completes a drain on removed, or after two snapshots without the worker', () => {
    const draining = workerDoc(W1, { state: 'draining' })
    const removed = plan([draining], [{ workerId: W1, state: 'removed' }])
    expect(removed.updates[0]!.set).toMatchObject({ state: 'stopped', stoppedAt: at(60), expiresAt: new Date(at(60).getTime() + 7 * 86_400_000) })
    expect(removed.stopped.map((worker) => worker._id)).toEqual([W1])

    const firstAbsence = plan([draining], [])
    expect(firstAbsence.updates).toEqual([])
    expect(firstAbsence.absences.get(W1)).toBe(1)
    const secondAbsence = plan([draining], [], firstAbsence.absences)
    expect(DRAIN_ABSENT_REPORTS).toBe(2)
    expect(secondAbsence.updates).toEqual([{ workerId: W1, fromStates: ['draining'], set: expect.objectContaining({ state: 'stopped' }) }])
    expect(secondAbsence.stopped).toHaveLength(1)
  })

  it('never stops a worker that is merely absent and not draining', () => {
    const result = plan([workerDoc(W1, { state: 'assigned' }), workerDoc(W2, { state: 'running' })], [])
    expect(result.updates).toEqual([])
    expect(result.absences.size).toBe(0)
  })

  it('ignores reports of workers that are not active workers of the node', () => {
    const result = plan([workerDoc(W1)], [{ workerId: FOREIGN, state: 'running' }, { workerId: W1, state: 'running' }])
    expect(result.ignored).toEqual([FOREIGN])
  })

  it('keeps the state reason of a draining worker', () => {
    const result = plan([workerDoc(W1, { state: 'draining' })], [{ workerId: W1, state: 'error', error: { code: 'imagePullFailed', message: 'x' } }])
    expect(result.updates).toEqual([])
    expect(result.pullFailures).toEqual([])
  })
})
