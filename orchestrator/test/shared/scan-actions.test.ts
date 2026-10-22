import { describe, expect, it } from 'vitest'
import { SCAN_STATES, SCHEDULING_STATES, type ScanState, type SchedulingState } from '#shared/utils/enums'
import { isScanActionAllowed, SCAN_ACTION_STATES, scanActions } from '#shared/utils/scan-actions'

// Scan lifecycle actions (docs/architecture.md §11.3, docs/data-model.md §6.1).

function scan(state: ScanState, scheduling: SchedulingState = 'done') {
  return { state, scheduling: { state: scheduling } }
}

describe('scanActions', () => {
  it.each([
    ['creating', ['scale', 'cancel', 'restart']],
    ['running', ['pause', 'scale', 'cancel', 'retryFailed', 'restart']],
    ['paused', ['resume', 'scale', 'cancel', 'restart']],
    ['completed', ['retryFailed', 'restart', 'delete']],
    ['failed', ['retryFailed', 'restart', 'delete']],
    ['cancelled', ['retryFailed', 'restart', 'delete']],
    ['deleting', []],
    ['deleted', []],
  ] as const)('%s → %j', (state, actions) => {
    expect(scanActions(scan(state))).toEqual(actions)
  })

  it('allows retry-failed only once scheduling is done or failed', () => {
    for (const scheduling of SCHEDULING_STATES) {
      expect(isScanActionAllowed('retryFailed', scan('completed', scheduling)), scheduling).toBe(scheduling === 'done' || scheduling === 'failed')
    }
  })

  it('only names known states', () => {
    for (const states of Object.values(SCAN_ACTION_STATES)) for (const state of states) expect(SCAN_STATES).toContain(state)
  })
})
