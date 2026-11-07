import type { ConditionType, ScanState } from '#shared/utils/enums'
import { NOTIFICATION_TRIGGER_INFO, NOTIFICATION_TRIGGERS, type NotificationTrigger } from '#shared/utils/notifications'
import type { EventDoc } from '../../types/documents'

/*
 * Which events notify (docs/data-model.md §4.11, §4.17): one matcher per trigger of the shared catalog, so a new
 * trigger is one entry here and one in shared/utils/notifications.ts. Every event matches at most one trigger, and the
 * matchers read only the event, so the event sink filters without I/O.
 */

export type TriggerEvent = Pick<EventDoc, 'type' | 'level' | 'userId' | 'data'>

const FINISHED_STATES: readonly ScanState[] = ['completed', 'failed', 'cancelled']

/**
 * Error conditions whose outcome another trigger already reports: `schedulingFailed` fails the scan (scanFinished) and
 * `breakerTripped` pauses it (scanPaused), so they would notify twice.
 */
const CONDITIONS_REPORTED_ELSEWHERE: ReadonlySet<ConditionType> = new Set(['schedulingFailed', 'breakerTripped'])

function dataField(event: TriggerEvent, key: string): unknown {
  return event.data?.[key]
}

const MATCHERS: Record<NotificationTrigger, (event: TriggerEvent) => boolean> = {
  // A user's own cancel (reason `user`) does not notify the user who just clicked it.
  scanFinished: (event) =>
    event.type === 'scan.stateChanged' &&
    FINISHED_STATES.includes(dataField(event, 'to') as ScanState) &&
    !(dataField(event, 'to') === 'cancelled' && dataField(event, 'reason') === 'user'),
  scanPaused: (event) => event.type === 'scan.stateChanged' && dataField(event, 'to') === 'paused' && dataField(event, 'reason') !== 'user',
  scanProblem: (event) =>
    event.type === 'scan.conditionRaised' && event.level === 'error' && !CONDITIONS_REPORTED_ELSEWHERE.has(dataField(event, 'type') as ConditionType),
  revisionBuilt: (event) => event.type === 'revision.ready' || event.type === 'revision.failed',
  // Node events have no owner (userId null): they go to the admins who subscribed.
  nodeAvailability: (event) => event.userId === null && (event.type === 'node.offline' || event.type === 'node.online'),
}

/** The trigger an event belongs to, or null when it notifies nobody. */
export function triggerOf(event: TriggerEvent): NotificationTrigger | null {
  for (const trigger of NOTIFICATION_TRIGGERS) {
    if (MATCHERS[trigger](event)) return trigger
  }
  return null
}

export function isAdminOnlyTrigger(trigger: NotificationTrigger): boolean {
  return NOTIFICATION_TRIGGER_INFO[trigger].adminOnly
}
