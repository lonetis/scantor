import type { NotificationTrigger } from '../utils/notifications'
import type { IsoDate } from './common'

// Notification settings of the signed-in user (docs/api.md §2 `NotificationSettings`, §4.3). One object per channel
// kind; `ntfy` is the only kind today, later kinds (webhook, email) become sibling keys.

/** The outcome of the last delivery attempt, a test message included. */
export interface NotificationDelivery {
  at: IsoDate
  ok: boolean
  /** HTTP status of the channel's answer; null when it could not be reached */
  status: number | null
  /** the channel's error message; null after a success */
  message: string | null
}

export interface NtfyChannelSettings {
  /** the ntfy server of this instance (`SCANTOR_NTFY_URL`); users subscribe to `<server>/<topic>` */
  server: string | null
  enabled: boolean
  topic: string | null
  /** whether an access token is stored (the token itself is never returned) */
  tokenSet: boolean
  triggers: NotificationTrigger[]
  lastDelivery: NotificationDelivery | null
}

export interface NotificationSettings {
  /** false when the operator disabled push notifications (`SCANTOR_NTFY_URL` is empty) */
  available: boolean
  ntfy: NtfyChannelSettings
}

/** `testNotification` response: what the channel answered to a test message. */
export interface NotificationTestResult {
  delivered: boolean
  status: number | null
  message: string | null
}
