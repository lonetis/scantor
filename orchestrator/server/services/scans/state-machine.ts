import type { ScanState, SchedulingState } from '#shared/utils/enums'
import { RETRY_FAILED_SCHEDULING_STATES, SCAN_ACTION_RESULT_STATE, SCAN_ACTION_STATES, type ScanAction } from '#shared/utils/scan-actions'
import { apiError, invalidState } from '../../utils/errors'

/*
 * The scan state machine (docs/data-model.md §6.1, §6.2; docs/architecture.md §11.3). Lifecycle routes only record
 * intent; this module decides whether an action is allowed from the current state. Unlisted transitions are
 * forbidden (409 invalidState with `details: {state, allowed}`); requesting the state a scan is already in is
 * idempotent (200 with the unchanged scan, docs/api.md §1.5).
 */

/** Every allowed transition of `scans.state` and its actor (docs/data-model.md §6.1). */
export const SCAN_TRANSITIONS: Readonly<Record<ScanState, readonly ScanState[]>> = {
  creating: ['running', 'cancelled'],
  running: ['paused', 'completed', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  completed: ['running', 'deleting'],
  failed: ['running', 'deleting'],
  cancelled: ['running', 'deleting'],
  deleting: ['deleted'],
  deleted: [],
}

export function isAllowedTransition(from: ScanState, to: ScanState): boolean {
  return SCAN_TRANSITIONS[from].includes(to)
}

/** Every allowed transition of `scans.scheduling.state` (docs/data-model.md §6.2). */
export const SCHEDULING_TRANSITIONS: Readonly<Record<SchedulingState, readonly SchedulingState[]>> = {
  pending: ['running', 'done', 'failed'],
  running: ['done', 'failed'],
  done: ['retrying'],
  failed: ['retrying'],
  retrying: ['done', 'failed'],
}

export function isAllowedSchedulingTransition(from: SchedulingState, to: SchedulingState): boolean {
  return SCHEDULING_TRANSITIONS[from].includes(to)
}

export interface TransitionSubject {
  state: ScanState
  scheduling: { state: SchedulingState }
}

export type TransitionDecision = 'apply' | 'unchanged'

const ACTION_VERBS: Record<ScanAction, string> = {
  pause: 'pause',
  resume: 'resume',
  scale: 'scale',
  cancel: 'cancel',
  retryFailed: 'retry-failed',
  restart: 'restart',
  delete: 'delete',
}

/**
 * Decides a lifecycle action: `apply` when allowed, `unchanged` when the scan already is in the action's result
 * state. Throws 409 invalidState otherwise. Retry-failed additionally needs finished scheduling, which also excludes
 * an active retry (scheduling `retrying`).
 */
export function decideTransition(action: ScanAction, scan: TransitionSubject): TransitionDecision {
  const allowed = SCAN_ACTION_STATES[action]
  const resultState = SCAN_ACTION_RESULT_STATE[action]
  if (resultState !== undefined && scan.state === resultState) return 'unchanged'
  if (action === 'delete' && scan.state === 'deleting') return 'unchanged'
  if (!allowed.includes(scan.state)) throw invalidState('scan', scan.state, allowed, ACTION_VERBS[action])
  if (action === 'retryFailed' && !RETRY_FAILED_SCHEDULING_STATES.includes(scan.scheduling.state)) {
    const message =
      scan.scheduling.state === 'retrying'
        ? 'a retry of failed analyses is already running'
        : `scheduling is ${scan.scheduling.state}; retry-failed requires finished scheduling (done or failed)`
    throw apiError('invalidState', message, {
      state: scan.state,
      allowed: [...allowed],
      schedulingState: scan.scheduling.state,
      allowedSchedulingStates: [...RETRY_FAILED_SCHEDULING_STATES],
    })
  }
  return 'apply'
}

/** The state a lifecycle action moves the scan to (scale and restart leave the scan's state alone). */
export function targetState(action: ScanAction, scan: TransitionSubject): ScanState {
  switch (action) {
    case 'pause':
      return 'paused'
    case 'resume':
      return 'running'
    case 'cancel':
      return 'cancelled'
    case 'retryFailed':
      return 'running'
    case 'delete':
      return 'deleting'
    case 'scale':
    case 'restart':
      return scan.state
  }
}
