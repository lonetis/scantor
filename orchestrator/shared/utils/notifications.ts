// Push notifications (docs/api.md §4.3, docs/data-model.md §4.17): the trigger catalog shared by the server, the UI and
// the tests. A trigger names a family of events (docs/data-model.md §4.11) a user can subscribe to; the server maps
// events onto triggers in server/services/notifications/triggers.ts. New triggers are appended here and there.

export const NOTIFICATION_TRIGGERS = ['scanFinished', 'scanPaused', 'scanProblem', 'revisionBuilt', 'nodeAvailability'] as const
export type NotificationTrigger = (typeof NOTIFICATION_TRIGGERS)[number]

export interface NotificationTriggerInfo {
  title: string
  description: string
  /** only admins may subscribe (the events have no owner, docs/data-model.md §4.11) */
  adminOnly: boolean
}

export const NOTIFICATION_TRIGGER_INFO: Record<NotificationTrigger, NotificationTriggerInfo> = {
  scanFinished: {
    title: 'Scan finished',
    description: 'A scan completed, failed, or was cancelled by the platform.',
    adminOnly: false,
  },
  scanPaused: {
    title: 'Scan paused by the platform',
    description: 'The platform paused a running scan, for example because too many analyses failed.',
    adminOnly: false,
  },
  scanProblem: {
    title: 'Scan problem',
    description: 'An error condition was raised on a scan: a crash loop, a failed image pull, a broker alarm.',
    adminOnly: false,
  },
  revisionBuilt: {
    title: 'Revision built',
    description: 'A revision build finished: the revision is ready or failed.',
    adminOnly: false,
  },
  nodeAvailability: {
    title: 'Node availability',
    description: 'A node went offline or came back online (admins only).',
    adminOnly: true,
  },
}

/** Triggers of settings that were never saved. */
export const DEFAULT_NOTIFICATION_TRIGGERS: readonly NotificationTrigger[] = ['scanFinished', 'scanPaused', 'scanProblem']

/** ntfy topic names (the characters ntfy accepts). */
export const NTFY_TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
export const NTFY_TOKEN_MAX_LENGTH = 256
