import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationSettingsDoc } from '../../../server/types/documents'
import { FakeCollection } from '../../helpers/fake-collection'

// Notification settings (docs/data-model.md §4.17, docs/api.md §4.3): PATCH merges, the token is stored encrypted and
// never returned, admin-only triggers need an admin, enabling needs a topic, and the event sink's cache is
// invalidated by every save.

const store = { settings: new FakeCollection<NotificationSettingsDoc>('notificationSettings') }
const roles = new Map<string, 'admin' | 'user'>()

vi.mock('../../../server/utils/mongo', () => ({ useCollections: () => ({ notificationSettings: store.settings.asCollection() }) }))
vi.mock('../../../server/utils/keys', async (original) => {
  const actual = await original<typeof import('../../../server/utils/keys')>()
  const keyring = actual.createKeyring('test-secret-for-notifications')
  return { ...actual, useKeys: () => keyring }
})
vi.mock('../../../server/utils/user-cache', () => ({
  getCachedUser: async (id: string) => (roles.has(id) ? { id, role: roles.get(id) } : null),
}))

const settings = await import('../../../server/services/notifications/settings')
const { decryptSecret } = await import('../../../server/utils/secrets')
const { ApiError } = await import('../../../server/utils/errors')

const alice = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const admin = '1b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c12'
const config = { ntfyUrl: 'https://ntfy.sh' }

async function issues(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return null
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    return { code: error.code, issues: error.details?.issues }
  }
}

beforeEach(() => {
  store.settings.docs.length = 0
  roles.clear()
  roles.set(alice, 'user')
  roles.set(admin, 'admin')
  settings.resetNotificationSettingsCache()
})

describe('notification settings', () => {
  it('reports defaults before the first save and whether the instance sends notifications', () => {
    expect(settings.toApiNotificationSettings(null, config)).toEqual({
      available: true,
      ntfy: {
        server: 'https://ntfy.sh',
        enabled: false,
        topic: null,
        tokenSet: false,
        triggers: ['scanFinished', 'scanPaused', 'scanProblem'],
        lastDelivery: null,
      },
    })
    expect(settings.toApiNotificationSettings(null, { ntfyUrl: null })).toMatchObject({ available: false, ntfy: { server: null } })
  })

  it('merges a PATCH, encrypts the token and never returns it', async () => {
    await settings.updateNotificationSettings(alice, { ntfy: { topic: 'alice-topic', token: 'tk_alice' } }, { isAdmin: false })
    const enabled = await settings.updateNotificationSettings(alice, { ntfy: { enabled: true } }, { isAdmin: false })
    const api = settings.toApiNotificationSettings(enabled, config)
    expect(api.ntfy).toMatchObject({ enabled: true, topic: 'alice-topic', tokenSet: true, triggers: ['scanFinished', 'scanPaused', 'scanProblem'] })
    expect(JSON.stringify(api)).not.toContain('tk_alice')
    const stored = store.settings.docs[0] as unknown as NotificationSettingsDoc
    expect(stored._id).toBe(alice)
    expect(stored.ntfy!.tokenEnc).toMatch(/^enc:v1:/)
    expect(decryptSecret(stored.ntfy!.tokenEnc!, 'credentials', settings.ntfyTokenAad(alice))).toBe('tk_alice')
    expect(settings.ntfyToken(alice, stored.ntfy!)).toBe('tk_alice')
    // The AAD binds the token to its user.
    expect(() => settings.ntfyToken(admin, stored.ntfy!)).toThrow()

    const cleared = await settings.updateNotificationSettings(alice, { ntfy: { token: null, triggers: ['revisionBuilt'] } }, { isAdmin: false })
    expect(cleared.ntfy).toMatchObject({ tokenEnc: null, topic: 'alice-topic', enabled: true, triggers: ['revisionBuilt'] })
    expect(cleared.createdAt).toEqual(stored.createdAt)
  })

  it('needs a topic to enable and an admin for admin-only triggers', async () => {
    expect(await issues(settings.updateNotificationSettings(alice, { ntfy: { enabled: true } }, { isAdmin: false }))).toEqual({
      code: 'validationFailed',
      issues: [{ path: 'ntfy.topic', message: 'a topic is required to enable notifications' }],
    })
    await settings.updateNotificationSettings(alice, { ntfy: { topic: 't', enabled: true } }, { isAdmin: false })
    expect(await issues(settings.updateNotificationSettings(alice, { ntfy: { topic: null } }, { isAdmin: false }))).toMatchObject({ code: 'validationFailed' })
    expect(await issues(settings.updateNotificationSettings(alice, { ntfy: { triggers: ['scanFinished', 'nodeAvailability'] } }, { isAdmin: false }))).toEqual({
      code: 'validationFailed',
      issues: [{ path: 'ntfy.triggers', message: 'nodeAvailability is for admins only' }],
    })
    const saved = await settings.updateNotificationSettings(admin, { ntfy: { triggers: ['nodeAvailability'] } }, { isAdmin: true })
    expect(saved.ntfy!.triggers).toEqual(['nodeAvailability'])
  })

  it('records deliveries and forgets them when the topic or token changes', async () => {
    await settings.updateNotificationSettings(alice, { ntfy: { topic: 't' } }, { isAdmin: false })
    const at = new Date('2026-11-07T10:00:00.000Z')
    await settings.recordNtfyDelivery(alice, { ok: false, status: 403, message: 'the ntfy server answered 403: forbidden' }, at)
    const doc = await settings.findNotificationSettings(alice)
    expect(settings.toApiNotificationSettings(doc, config).ntfy.lastDelivery).toEqual({
      at: '2026-11-07T10:00:00.000Z',
      ok: false,
      status: 403,
      message: 'the ntfy server answered 403: forbidden',
    })
    const kept = await settings.updateNotificationSettings(alice, { ntfy: { enabled: true } }, { isAdmin: false })
    expect(kept.ntfy!.lastDelivery).not.toBeNull()
    const reset = await settings.updateNotificationSettings(alice, { ntfy: { token: 'tk_new' } }, { isAdmin: false })
    expect(reset.ntfy!.lastDelivery).toBeNull()
    // No channel, no record.
    await settings.recordNtfyDelivery(admin, { ok: true, status: 200, message: null })
    expect(await settings.findNotificationSettings(admin)).toBeNull()
  })

  it('caches subscriptions for the event sink until a save invalidates them', async () => {
    expect(await settings.cachedSubscription(alice)).toBeNull()
    await settings.updateNotificationSettings(alice, { ntfy: { topic: 't', enabled: true } }, { isAdmin: false })
    expect(await settings.cachedSubscription(alice)).toEqual({ enabled: true, triggers: ['scanFinished', 'scanPaused', 'scanProblem'] })
    // A write behind the cache's back is seen only after the TTL.
    const stored = store.settings.docs[0] as unknown as NotificationSettingsDoc
    stored.ntfy!.enabled = false
    expect((await settings.cachedSubscription(alice))?.enabled).toBe(true)
    expect((await settings.cachedSubscription(alice, Date.now() + settings.SETTINGS_CACHE_TTL_MS + 1))?.enabled).toBe(false)
  })

  it('finds the subscribed admins of an owner-less trigger', async () => {
    await settings.updateNotificationSettings(admin, { ntfy: { topic: 'ops', enabled: true, triggers: ['nodeAvailability'] } }, { isAdmin: true })
    await settings.updateNotificationSettings(alice, { ntfy: { topic: 'alice', enabled: true } }, { isAdmin: false })
    expect(await settings.cachedAdminSubscribers('nodeAvailability')).toEqual([admin])
    // An admin demoted later no longer receives admin-only notifications.
    roles.set(admin, 'user')
    settings.invalidateCachedNotificationSettings(admin)
    expect(await settings.cachedAdminSubscribers('nodeAvailability')).toEqual([])
  })

  it('deletes the settings of a purged user', async () => {
    await settings.updateNotificationSettings(alice, { ntfy: { topic: 't', enabled: true } }, { isAdmin: false })
    await settings.cachedSubscription(alice)
    await settings.deleteNotificationSettings(alice)
    expect(store.settings.docs).toHaveLength(0)
    expect(await settings.cachedSubscription(alice)).toBeNull()
  })
})
