import type { ScanState, SchedulingState } from './enums'

// Scan lifecycle actions and the states they are allowed from (docs/architecture.md §11.3, docs/data-model.md
// §6.1). The server uses the table to answer 409 invalidState with `details.allowed`; the UI uses scanActions()
// to decide which buttons to show.

export const SCAN_ACTIONS = ['pause', 'resume', 'scale', 'cancel', 'retryFailed', 'restart', 'delete'] as const
export type ScanAction = (typeof SCAN_ACTIONS)[number]

export const SCAN_ACTION_STATES: Record<ScanAction, readonly ScanState[]> = {
  pause: ['running'],
  resume: ['paused'],
  scale: ['creating', 'running', 'paused'],
  cancel: ['creating', 'running', 'paused'],
  retryFailed: ['running', 'completed', 'failed', 'cancelled'],
  restart: ['creating', 'running', 'paused', 'completed', 'failed', 'cancelled'],
  delete: ['completed', 'failed', 'cancelled'],
}

/**
 * Lifecycle actions are idempotent (docs/api.md §1.5): requesting the state a scan is already in returns 200 with
 * the unchanged scan instead of 409.
 */
export const SCAN_ACTION_RESULT_STATE: Partial<Record<ScanAction, ScanState>> = {
  pause: 'paused',
  resume: 'running',
  cancel: 'cancelled',
}

/** Retry-failed additionally needs finished scheduling and no retry in progress. */
export const RETRY_FAILED_SCHEDULING_STATES: readonly SchedulingState[] = ['done', 'failed']

export interface ScanActionSubject {
  state: ScanState
  scheduling: { state: SchedulingState }
}

export function isScanActionAllowed(action: ScanAction, scan: ScanActionSubject): boolean {
  if (!SCAN_ACTION_STATES[action].includes(scan.state)) return false
  if (action === 'retryFailed') return RETRY_FAILED_SCHEDULING_STATES.includes(scan.scheduling.state)
  return true
}

/** The actions the UI may offer for a scan (real transitions only, no idempotent no-ops). */
export function scanActions(scan: ScanActionSubject): ScanAction[] {
  return SCAN_ACTIONS.filter((action) => isScanActionAllowed(action, scan))
}
