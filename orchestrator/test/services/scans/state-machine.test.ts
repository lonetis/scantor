import { describe, expect, it } from 'vitest'
import { SCAN_STATES, SCHEDULING_STATES, type ScanState, type SchedulingState } from '#shared/utils/enums'
import { SCAN_ACTIONS, SCAN_ACTION_STATES, type ScanAction } from '#shared/utils/scan-actions'
import {
  decideTransition,
  isAllowedSchedulingTransition,
  isAllowedTransition,
  SCAN_TRANSITIONS,
  targetState,
} from '../../../server/services/scans/state-machine'
import { ApiError } from '../../../server/utils/errors'

// The scan state machine (docs/data-model.md §6.1, §6.2; docs/architecture.md §11.3; docs/api.md §1.5).

function scan(state: ScanState, scheduling: SchedulingState = 'done') {
  return { state, scheduling: { state: scheduling } }
}

function decide(action: ScanAction, state: ScanState, scheduling: SchedulingState = 'done') {
  try {
    return decideTransition(action, scan(state, scheduling))
  } catch (error) {
    if (error instanceof ApiError) return { code: error.data?.code, details: error.data?.details }
    throw error
  }
}

describe('SCAN_TRANSITIONS', () => {
  it('is exactly the table of docs/data-model.md §6.1', () => {
    expect(SCAN_TRANSITIONS).toEqual({
      creating: ['running', 'cancelled'],
      running: ['paused', 'completed', 'failed', 'cancelled'],
      paused: ['running', 'cancelled'],
      completed: ['running', 'deleting'],
      failed: ['running', 'deleting'],
      cancelled: ['running', 'deleting'],
      deleting: ['deleted'],
      deleted: [],
    })
    expect(Object.keys(SCAN_TRANSITIONS).sort()).toEqual([...SCAN_STATES].sort())
  })

  it('forbids every unlisted transition', () => {
    expect(isAllowedTransition('paused', 'completed')).toBe(false)
    expect(isAllowedTransition('creating', 'paused')).toBe(false)
    expect(isAllowedTransition('deleted', 'running')).toBe(false)
    expect(isAllowedTransition('cancelled', 'running')).toBe(true)
  })

  it('keeps every action target reachable from its allowed states', () => {
    for (const action of SCAN_ACTIONS) {
      for (const state of SCAN_ACTION_STATES[action]) {
        const to = targetState(action, scan(state))
        if (to !== state) expect(isAllowedTransition(state, to), `${action} from ${state}`).toBe(true)
      }
    }
  })
})

describe('scheduling transitions (docs/data-model.md §6.2)', () => {
  it.each([
    ['pending', 'running', true],
    ['pending', 'done', true],
    ['pending', 'failed', true],
    ['running', 'done', true],
    ['running', 'failed', true],
    ['done', 'retrying', true],
    ['failed', 'retrying', true],
    ['retrying', 'done', true],
    ['retrying', 'failed', true],
    ['done', 'running', false],
    ['running', 'pending', false],
    ['retrying', 'running', false],
  ] as const)('%s → %s: %s', (from, to, allowed) => {
    expect(isAllowedSchedulingTransition(from, to)).toBe(allowed)
  })
})

describe('decideTransition', () => {
  it.each([
    ['pause', 'running', 'apply'],
    ['pause', 'paused', 'unchanged'],
    ['resume', 'paused', 'apply'],
    ['resume', 'running', 'unchanged'],
    ['cancel', 'creating', 'apply'],
    ['cancel', 'running', 'apply'],
    ['cancel', 'paused', 'apply'],
    ['cancel', 'cancelled', 'unchanged'],
    ['scale', 'creating', 'apply'],
    ['scale', 'running', 'apply'],
    ['scale', 'paused', 'apply'],
    ['retryFailed', 'running', 'apply'],
    ['retryFailed', 'completed', 'apply'],
    ['retryFailed', 'failed', 'apply'],
    ['retryFailed', 'cancelled', 'apply'],
    ['restart', 'creating', 'apply'],
    ['restart', 'completed', 'apply'],
    ['restart', 'cancelled', 'apply'],
    ['delete', 'completed', 'apply'],
    ['delete', 'failed', 'apply'],
    ['delete', 'cancelled', 'apply'],
    ['delete', 'deleting', 'unchanged'],
  ] as const)('%s from %s → %s', (action, state, decision) => {
    expect(decide(action, state)).toBe(decision)
  })

  it.each([
    ['pause', 'creating'],
    ['pause', 'completed'],
    ['resume', 'creating'],
    ['resume', 'cancelled'],
    ['cancel', 'completed'],
    ['cancel', 'deleting'],
    ['scale', 'completed'],
    ['scale', 'deleted'],
    ['retryFailed', 'creating'],
    ['retryFailed', 'paused'],
    ['retryFailed', 'deleting'],
    ['restart', 'deleting'],
    ['restart', 'deleted'],
    ['delete', 'running'],
    ['delete', 'paused'],
    ['delete', 'creating'],
    ['delete', 'deleted'],
  ] as const)('%s from %s is 409 invalidState with the allowed states', (action, state) => {
    expect(decide(action, state)).toEqual({ code: 'invalidState', details: { state, allowed: [...SCAN_ACTION_STATES[action]] } })
  })

  it('allows retry-failed only with finished scheduling (and so never during a retry)', () => {
    for (const scheduling of SCHEDULING_STATES) {
      const result = decide('retryFailed', 'completed', scheduling)
      if (scheduling === 'done' || scheduling === 'failed') expect(result, scheduling).toBe('apply')
      else expect(result, scheduling).toMatchObject({ code: 'invalidState', details: { schedulingState: scheduling, allowedSchedulingStates: ['done', 'failed'] } })
    }
  })

  it('names the target state of every action', () => {
    expect(targetState('pause', scan('running'))).toBe('paused')
    expect(targetState('resume', scan('paused'))).toBe('running')
    expect(targetState('cancel', scan('creating'))).toBe('cancelled')
    expect(targetState('retryFailed', scan('failed'))).toBe('running')
    expect(targetState('delete', scan('completed'))).toBe('deleting')
    expect(targetState('scale', scan('paused'))).toBe('paused')
    expect(targetState('restart', scan('failed'))).toBe('failed')
  })
})
