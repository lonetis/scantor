import { z } from 'zod'
import { NOTIFICATION_TRIGGERS, NTFY_TOKEN_MAX_LENGTH, NTFY_TOPIC_PATTERN } from '../utils/notifications'

// Request schemas of the notification settings (docs/api.md §4.3). PATCH merges: an omitted field keeps its stored
// value, `token: null` removes the stored token and `topic: null` clears the topic.

export const ntfyTopic = () => z.string().trim().regex(NTFY_TOPIC_PATTERN, 'must be 1–64 letters, digits, "-" or "_"')

export const ntfyToken = () =>
  z
    .string()
    .trim()
    .min(1)
    .max(NTFY_TOKEN_MAX_LENGTH)
    .regex(/^[\x21-\x7e]+$/, 'must be printable ASCII without spaces')

export const notificationTriggers = () =>
  z
    .array(z.enum(NOTIFICATION_TRIGGERS))
    .max(NOTIFICATION_TRIGGERS.length)
    .refine((triggers) => new Set(triggers).size === triggers.length, 'must not repeat a trigger')

export const updateNotificationSettingsBody = z.strictObject({
  ntfy: z
    .strictObject({
      enabled: z.boolean().optional(),
      topic: ntfyTopic().nullable().optional(),
      token: ntfyToken().nullable().optional(),
      triggers: notificationTriggers().optional(),
    })
    .optional(),
})
export type UpdateNotificationSettingsBody = z.infer<typeof updateNotificationSettingsBody>
