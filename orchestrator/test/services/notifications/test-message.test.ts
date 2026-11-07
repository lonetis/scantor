import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationSettingsDoc } from '../../../server/types/documents'
import { FakeCollection } from '../../helpers/fake-collection'

// The test message of testNotification (docs/api.md §4.3): sent to the saved topic, enabled or not, answered with the
// ntfy server's reply, refused without a topic or while notifications are off, and limited to one per 10 s.

const store = { settings: new FakeCollection<NotificationSettingsDoc>('notificationSettings') }

vi.mock('../../../server/utils/mongo', () => ({ useCollections: () => ({ notificationSettings: store.settings.asCollection() }) }))
vi.mock('../../../server/utils/user-cache', () => ({ getCachedUser: vi.fn() }))
vi.mock('../../../server/utils/keys', async (original) => {
  const actual = await original<typeof import('../../../server/utils/keys')>()
  const keyring = actual.createKeyring('test-secret-for-notification-tests')
  return { ...actual, useKeys: () => keyring }
})

const { resetTestCooldowns, sendTestNotification, TEST_COOLDOWN_MS } = await import('../../../server/services/notifications')
const { updateNotificationSettings } = await import('../../../server/services/notifications/settings')
const { ApiError } = await import('../../../server/utils/errors')

const alice = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const config = { ntfyUrl: 'https://ntfy.example.com', publicUrl: 'https://scantor.example.com' }

async function code(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    return error.code
  }
}

beforeEach(() => {
  store.settings.docs.length = 0
  resetTestCooldowns()
})

describe('sendTestNotification', () => {
  it('sends to the saved topic with the token, also while disabled, and records the answer', async () => {
    await updateNotificationSettings(alice, { ntfy: { topic: 'alice-topic', token: 'tk_alice' } }, { isAdmin: false })
    const publish = vi.fn().mockResolvedValue({ ok: false, status: 401, message: 'the ntfy server answered 401: unauthorized', retryable: false })
    const result = await sendTestNotification(alice, config, { now: 1_000_000, publish })
    expect(result).toEqual({ delivered: false, status: 401, message: 'the ntfy server answered 401: unauthorized' })
    expect(publish.mock.calls[0]![0]).toEqual({ server: 'https://ntfy.example.com', topic: 'alice-topic', token: 'tk_alice' })
    expect(publish.mock.calls[0]![1]).toMatchObject({ title: 'scantor test notification' })
    expect((store.settings.docs[0] as unknown as NotificationSettingsDoc).ntfy!.lastDelivery).toMatchObject({ ok: false, status: 401 })
  })

  it('allows one test per user every 10 s', async () => {
    await updateNotificationSettings(alice, { ntfy: { topic: 'alice-topic' } }, { isAdmin: false })
    const publish = vi.fn().mockResolvedValue({ ok: true, status: 200, message: null, retryable: false })
    expect(await sendTestNotification(alice, config, { now: 1_000_000, publish })).toEqual({ delivered: true, status: 200, message: null })
    expect(await code(sendTestNotification(alice, config, { now: 1_000_000 + TEST_COOLDOWN_MS - 1, publish }))).toBe('tooManyRequests')
    expect((await sendTestNotification(alice, config, { now: 1_000_000 + TEST_COOLDOWN_MS, publish })).delivered).toBe(true)
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('needs a saved topic and notifications on the instance', async () => {
    const publish = vi.fn()
    expect(await code(sendTestNotification(alice, config, { publish }))).toBe('invalidState')
    await updateNotificationSettings(alice, { ntfy: { topic: 'alice-topic' } }, { isAdmin: false })
    expect(await code(sendTestNotification(alice, { ...config, ntfyUrl: null }, { publish }))).toBe('invalidState')
    expect(publish).not.toHaveBeenCalled()
  })
})
