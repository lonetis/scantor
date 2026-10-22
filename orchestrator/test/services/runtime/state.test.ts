import { describe, expect, it } from 'vitest'
import { type ActionInput, allowedProcesses, runtimeAction } from '../../../server/services/runtime/state'
import { workerDoc } from '../nodes/helpers'

// The runtime state poll (docs/api.md §8.2, docs/runtime.md §5.1, docs/nodes.md §12.6): the action table and the
// processes a runner may run (min(desired, node-applied) while scaling up, desired at once while scaling down).

const runner: ActionInput = { scanState: 'running', workerState: 'running', role: 'runner', workerEpoch: 0, schedulingState: 'running', schedulingEpoch: 1 }
const scheduler: ActionInput = { ...runner, role: 'scheduler', workerEpoch: 1 }

describe('runtimeAction', () => {
  it('runs active workers of running scans', () => {
    expect(runtimeAction(runner)).toBe('run')
    expect(runtimeAction(scheduler)).toBe('run')
    expect(runtimeAction({ ...runner, workerState: 'backoff' })).toBe('run')
  })

  it('drains on pause, scale-in and the end of scheduling', () => {
    expect(runtimeAction({ ...runner, scanState: 'paused' })).toBe('drain')
    expect(runtimeAction({ ...runner, workerState: 'draining' })).toBe('drain')
    expect(runtimeAction({ ...scheduler, schedulingState: 'done' })).toBe('drain')
    expect(runtimeAction({ ...scheduler, schedulingState: 'retrying' })).toBe('drain')
    expect(runtimeAction({ ...runner, schedulingState: 'done' })).toBe('run')
  })

  it('stops workers of terminal, cancelled or vanished scans, lost workers and fenced schedulers', () => {
    for (const scanState of ['cancelled', 'completed', 'failed', 'deleting', 'deleted'] as const) {
      expect(runtimeAction({ ...runner, scanState }), scanState).toBe('stop')
    }
    expect(runtimeAction({ ...runner, scanState: null })).toBe('stop')
    expect(runtimeAction({ ...runner, workerState: 'lost' })).toBe('stop')
    expect(runtimeAction({ ...runner, workerState: 'stopped' })).toBe('stop')
    expect(runtimeAction({ ...scheduler, workerEpoch: 0 })).toBe('stop')
    // Scheduling failed above SCANTOR_SCHEDULER_MAX_RESTARTS: the next poll stops the scheduler.
    expect(runtimeAction({ ...scheduler, schedulingState: 'failed' })).toBe('stop')
  })
})

describe('allowedProcesses', () => {
  it('is 1 for the scheduler', () => {
    expect(allowedProcesses(workerDoc('s', { role: 'scheduler', processes: { desired: 4, assigned: 4, applied: 4, running: 1 } }), 64)).toBe(1)
  })

  it('waits for the node to apply larger limits before scaling up', () => {
    expect(allowedProcesses(workerDoc('w', { processes: { desired: 4, assigned: 4, applied: 2, running: 2 } }), 64)).toBe(2)
    expect(allowedProcesses(workerDoc('w', { processes: { desired: 4, assigned: 4, applied: 4, running: 2 } }), 64)).toBe(4)
  })

  it('scales down at once', () => {
    expect(allowedProcesses(workerDoc('w', { processes: { desired: 1, assigned: 4, applied: 4, running: 4 } }), 64)).toBe(1)
  })

  it('falls back to the assigned value before the node reported, and clamps to the maximum', () => {
    expect(allowedProcesses(workerDoc('w', { processes: { desired: 3, assigned: 3, applied: null, running: null } }), 64)).toBe(3)
    expect(allowedProcesses(workerDoc('w', { processes: { desired: 100, assigned: 100, applied: 100, running: 1 } }), 64)).toBe(64)
  })
})
