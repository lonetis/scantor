import { describe, expect, it } from 'vitest'
import { NOTIFICATION_TRIGGER_INFO, NOTIFICATION_TRIGGERS } from '#shared/utils/notifications'
import { isAdminOnlyTrigger, triggerOf, type TriggerEvent } from '../../../server/services/notifications/triggers'

// Which events notify (docs/data-model.md §4.17): every event maps onto at most one trigger of the shared catalog.

const owner = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'

function stateChanged(to: string, reason: string, level: TriggerEvent['level'] = 'info'): TriggerEvent {
  return { type: 'scan.stateChanged', level, userId: owner, data: { from: 'running', to, reason } }
}

function conditionRaised(type: string, level: TriggerEvent['level']): TriggerEvent {
  return { type: 'scan.conditionRaised', level, userId: owner, data: { type, reason: 'x' } }
}

describe('triggerOf', () => {
  it('maps finished scans, except a cancel by the user', () => {
    expect(triggerOf(stateChanged('completed', 'completed'))).toBe('scanFinished')
    expect(triggerOf(stateChanged('failed', 'schedulingFailed', 'error'))).toBe('scanFinished')
    expect(triggerOf(stateChanged('failed', 'revisionUnavailable', 'error'))).toBe('scanFinished')
    expect(triggerOf(stateChanged('cancelled', 'stalled'))).toBe('scanFinished')
    expect(triggerOf(stateChanged('cancelled', 'user'))).toBeNull()
    expect(triggerOf(stateChanged('running', 'topologyReady'))).toBeNull()
    expect(triggerOf(stateChanged('deleting', 'user'))).toBeNull()
  })

  it('maps pauses by the platform only', () => {
    expect(triggerOf(stateChanged('paused', 'failureRate', 'warning'))).toBe('scanPaused')
    expect(triggerOf(stateChanged('paused', 'brokerAlarm', 'warning'))).toBe('scanPaused')
    expect(triggerOf(stateChanged('paused', 'user'))).toBeNull()
  })

  it('maps error conditions that no other trigger reports', () => {
    for (const type of ['crashLoop', 'imagePullFailed', 'topologyFailed', 'brokerAlarm']) {
      expect(triggerOf(conditionRaised(type, 'error')), type).toBe('scanProblem')
    }
    // Reported as scanFinished (the scan fails) and scanPaused (the breaker pauses it).
    expect(triggerOf(conditionRaised('schedulingFailed', 'error'))).toBeNull()
    expect(triggerOf(conditionRaised('breakerTripped', 'error'))).toBeNull()
    for (const type of ['workersPending', 'workerErrors', 'stalled', 'clockSkew']) {
      expect(triggerOf(conditionRaised(type, 'warning')), type).toBeNull()
    }
    expect(triggerOf({ type: 'scan.conditionCleared', level: 'info', userId: owner, data: { type: 'crashLoop' } })).toBeNull()
  })

  it('maps revision builds and owner-less node availability', () => {
    expect(triggerOf({ type: 'revision.ready', level: 'info', userId: owner })).toBe('revisionBuilt')
    expect(triggerOf({ type: 'revision.failed', level: 'error', userId: owner })).toBe('revisionBuilt')
    expect(triggerOf({ type: 'node.offline', level: 'warning', userId: null })).toBe('nodeAvailability')
    expect(triggerOf({ type: 'node.online', level: 'info', userId: null })).toBe('nodeAvailability')
    expect(triggerOf({ type: 'node.revoked', level: 'warning', userId: null })).toBeNull()
  })

  it('ignores worker, scheduling and security events', () => {
    for (const type of ['scan.created', 'scan.scaled', 'worker.crashed', 'worker.started', 'scan.schedulingFailed', 'security.ingestRejected']) {
      expect(triggerOf({ type, level: 'error', userId: owner }), type).toBeNull()
    }
  })

  it('marks exactly the catalog entries flagged adminOnly', () => {
    for (const trigger of NOTIFICATION_TRIGGERS) expect(isAdminOnlyTrigger(trigger)).toBe(NOTIFICATION_TRIGGER_INFO[trigger].adminOnly)
    expect(NOTIFICATION_TRIGGERS.filter(isAdminOnlyTrigger)).toEqual(['nodeAvailability'])
  })
})
