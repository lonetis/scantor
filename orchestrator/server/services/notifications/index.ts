import type { NotificationTestResult } from '#shared/types/notifications'
import type { Config } from '../../utils/config'
import { apiError } from '../../utils/errors'
import { SecretDecryptionError } from '../../utils/secrets'
import { testNotificationMessage } from './messages'
import { publishNtfy } from './ntfy'
import { findNotificationSettings, ntfyToken, recordNtfyDelivery } from './settings'

// The test message of `POST /api/account/notifications/test` (docs/api.md §4.3): sent at once to the stored topic,
// enabled or not, and answered with what the ntfy server said. One test per user every TEST_COOLDOWN_MS keeps the
// instance's address clear of the public server's rate limits.

export const TEST_COOLDOWN_MS = 10_000

const lastTests = new Map<string, number>()

export async function sendTestNotification(
  userId: string,
  config: Pick<Config, 'ntfyUrl' | 'publicUrl'>,
  options: { now?: number; publish?: typeof publishNtfy } = {},
): Promise<NotificationTestResult> {
  if (config.ntfyUrl === null) throw apiError('invalidState', 'push notifications are disabled on this instance')
  const settings = await findNotificationSettings(userId)
  const ntfy = settings?.ntfy
  if (!ntfy?.topic) throw apiError('invalidState', 'save a ntfy topic before sending a test notification')
  const now = options.now ?? Date.now()
  const last = lastTests.get(userId)
  if (last !== undefined && now - last < TEST_COOLDOWN_MS) {
    throw apiError('tooManyRequests', 'wait a few seconds before sending another test notification', { retryAfterMs: TEST_COOLDOWN_MS - (now - last) })
  }
  lastTests.set(userId, now)
  if (lastTests.size > 10_000) {
    for (const [id, at] of lastTests) if (now - at >= TEST_COOLDOWN_MS) lastTests.delete(id)
  }
  let token: string | null
  try {
    token = ntfyToken(userId, ntfy)
  } catch (error) {
    if (!(error instanceof SecretDecryptionError)) throw error
    throw apiError('invalidState', 'the stored access token cannot be decrypted; save it again')
  }
  const outcome = await (options.publish ?? publishNtfy)({ server: config.ntfyUrl, topic: ntfy.topic, token }, testNotificationMessage(config.publicUrl))
  await recordNtfyDelivery(userId, outcome, new Date(now))
  return { delivered: outcome.ok, status: outcome.status, message: outcome.message }
}

/** Test seam. */
export function resetTestCooldowns(): void {
  lastTests.clear()
}
