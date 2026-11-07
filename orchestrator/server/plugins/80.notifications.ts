import { defineNitroPlugin } from 'nitropack/runtime'
import { notificationEventSink, notificationJobKind } from '../services/notifications/delivery'
import { deleteNotificationSettings } from '../services/notifications/settings'
import { useConfig } from '../utils/config'
import { registerEventSink } from '../utils/event-sinks'
import { registerJobKind } from '../utils/jobs'
import { registerUserPurgeStep } from '../utils/user-purge'

// Push notifications (docs/architecture.md §11.6, docs/api.md §4.3): the event sink that turns subscribed events into
// `notification` jobs (only while SCANTOR_NTFY_URL is set), the job kind that delivers them to ntfy, and userPurge
// step 105 (the user's settings, after the credentials).

export default defineNitroPlugin(() => {
  registerEventSink(notificationEventSink(() => useConfig().ntfyUrl !== null))
  registerJobKind('notification', notificationJobKind)
  registerUserPurgeStep({ name: 'notification-settings', order: 105, run: ({ userId }) => deleteNotificationSettings(userId) })
})
