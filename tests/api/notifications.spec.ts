import type { NotificationSettings, NotificationTestResult } from '#shared/types/notifications'
import { ok, type ApiResponse } from '../helpers/api-client'
import { stackValue } from '../helpers/api-auth'
import { NTFY_TOKEN, ntfyMessages } from '../helpers/fixtures-server'
import { expect, test, unique } from '../fixtures'

// Push notifications (docs/api.md §4.3, docs/architecture.md §11.6): the caller's ntfy settings, the test message and
// the delivery of subscribed events. SCANTOR_NTFY_URL of the test stack points at the fixtures server's ntfy fake,
// which records every publish per topic and protects `protected-*` topics with NTFY_TOKEN.

const DEFAULT_TRIGGERS = ['scanFinished', 'scanPaused', 'scanProblem']
const TEST_COOLDOWN_MS = 10_000

function expectError(response: ApiResponse, status: number, code: string): { code: string; details?: Record<string, unknown> } {
  expect(response.status, response.raw.toString('utf8').slice(0, 300)).toBe(status)
  const error = (response.body as { error: { code: string; details?: Record<string, unknown> } }).error
  expect(error.code).toBe(code)
  return error
}

function issuePaths(response: ApiResponse): string[] {
  const error = expectError(response, 400, 'validationFailed')
  return ((error.details?.issues ?? []) as { path: string }[]).map((issue) => issue.path)
}

test.describe('notifications', () => {
  test('GET /api/account/notifications returns the defaults and the instance server', { tag: ['@NOTIF-001'] }, async ({ freshApi }) => {
    const settings = ok(await freshApi.call<NotificationSettings>('getNotificationSettings'), 'getNotificationSettings')
    expect(settings).toEqual({
      available: true,
      ntfy: { server: stackValue('SCANTOR_NTFY_URL'), enabled: false, topic: null, tokenSet: false, triggers: DEFAULT_TRIGGERS, lastDelivery: null },
    })
  })

  test('PATCH /api/account/notifications merges, keeps the token write-only and validates', { tag: ['@NOTIF-002'] }, async ({ freshApi, adminApi }) => {
    const topic = unique('notif')
    const saved = ok(
      await freshApi.call<NotificationSettings>('updateNotificationSettings', {
        body: { ntfy: { topic, token: NTFY_TOKEN, enabled: true, triggers: ['scanFinished', 'revisionBuilt'] } },
      }),
      'updateNotificationSettings',
    )
    expect(saved.ntfy).toMatchObject({ enabled: true, topic, tokenSet: true, triggers: ['scanFinished', 'revisionBuilt'], lastDelivery: null })
    expect(JSON.stringify(saved)).not.toContain(NTFY_TOKEN)

    // Omitted fields keep their value; token null removes the token.
    const disabled = ok(await freshApi.call<NotificationSettings>('updateNotificationSettings', { body: { ntfy: { enabled: false } } }), 'disable')
    expect(disabled.ntfy).toMatchObject({ enabled: false, topic, tokenSet: true, triggers: ['scanFinished', 'revisionBuilt'] })
    const cleared = ok(await freshApi.call<NotificationSettings>('updateNotificationSettings', { body: { ntfy: { token: null } } }), 'remove the token')
    expect(cleared.ntfy).toMatchObject({ tokenSet: false, topic })
    expect(ok(await freshApi.call<NotificationSettings>('getNotificationSettings'), 'getNotificationSettings')).toEqual(cleared)

    const invalid: [unknown, string][] = [
      [{ ntfy: { topic: 'has space' } }, 'ntfy.topic'],
      [{ ntfy: { topic: 'x'.repeat(65) } }, 'ntfy.topic'],
      [{ ntfy: { token: 'two words' } }, 'ntfy.token'],
      [{ ntfy: { triggers: ['everything'] } }, 'ntfy.triggers.0'],
      [{ ntfy: { triggers: ['scanFinished', 'scanFinished'] } }, 'ntfy.triggers'],
      // The server is the operator's (SCANTOR_NTFY_URL): a request can never choose where the orchestrator sends.
      [{ ntfy: { server: 'http://169.254.169.254' } }, 'ntfy.server'],
      [{ webhook: { url: 'http://127.0.0.1' } }, 'webhook'],
      // Node availability is for admins only.
      [{ ntfy: { triggers: ['nodeAvailability'] } }, 'ntfy.triggers'],
    ]
    for (const [body, path] of invalid) {
      expect(issuePaths(await freshApi.call('updateNotificationSettings', { body })), JSON.stringify(body)).toContain(path)
    }
    // Enabling needs a topic.
    ok(await freshApi.call('updateNotificationSettings', { body: { ntfy: { topic: null } } }), 'clear the topic')
    expect(issuePaths(await freshApi.call('updateNotificationSettings', { body: { ntfy: { enabled: true } } }))).toEqual(['ntfy.topic'])

    // Admins may subscribe to node availability (left disabled, then restored).
    const before = ok(await adminApi.call<NotificationSettings>('getNotificationSettings'), 'admin settings')
    try {
      const admin = ok(
        await adminApi.call<NotificationSettings>('updateNotificationSettings', { body: { ntfy: { triggers: ['nodeAvailability'] } } }),
        'admin triggers',
      )
      expect(admin.ntfy.triggers).toEqual(['nodeAvailability'])
    } finally {
      ok(await adminApi.call('updateNotificationSettings', { body: { ntfy: { triggers: before.ntfy.triggers } } }), 'restore the admin triggers')
    }
  })

  test('POST /api/account/notifications/test reports what the ntfy server answered', { tag: ['@NOTIF-003'] }, async ({ freshApi, request }) => {
    test.setTimeout(60_000)
    expectError(await freshApi.call('testNotification'), 409, 'invalidState')

    // A protected topic without the token: the fake answers 403 like a reserved topic on a real server.
    const topic = `protected-${unique('n')}`
    ok(await freshApi.call('updateNotificationSettings', { body: { ntfy: { topic } } }), 'save the topic')
    const rejected = ok(await freshApi.call<NotificationTestResult>('testNotification'), 'testNotification')
    expect(rejected).toEqual({ delivered: false, status: 403, message: 'the ntfy server answered 403: forbidden' })
    const afterReject = ok(await freshApi.call<NotificationSettings>('getNotificationSettings'), 'getNotificationSettings')
    expect(afterReject.ntfy.lastDelivery).toMatchObject({ ok: false, status: 403, message: 'the ntfy server answered 403: forbidden' })
    const rejectedAt = Date.now()

    // A new token forgets the last delivery; one test every 10 s.
    const withToken = ok(await freshApi.call<NotificationSettings>('updateNotificationSettings', { body: { ntfy: { token: NTFY_TOKEN } } }), 'save the token')
    expect(withToken.ntfy.lastDelivery).toBeNull()
    const tooSoon = expectError(await freshApi.call('testNotification'), 429, 'tooManyRequests')
    expect(tooSoon.details?.retryAfterMs).toEqual(expect.any(Number))
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, TEST_COOLDOWN_MS - (Date.now() - rejectedAt)) + 500))

    const delivered = ok(await freshApi.call<NotificationTestResult>('testNotification'), 'testNotification')
    expect(delivered).toEqual({ delivered: true, status: 200, message: null })
    expect(ok(await freshApi.call<NotificationSettings>('getNotificationSettings'), 'getNotificationSettings').ntfy.lastDelivery).toMatchObject({
      ok: true,
      status: 200,
    })
    const messages = await ntfyMessages(request, topic)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      title: 'scantor test notification',
      priority: 3,
      tags: ['bell', 'scantor'],
      click: stackValue('SCANTOR_PUBLIC_URL'),
      authorized: true,
      userAgent: expect.stringMatching(/^scantor\//),
    })
  })

  test('revision builds and finished scans notify the subscribed owner', { tag: ['@NOTIF-004'] }, async ({ api, tasks, scans, request }) => {
    test.setTimeout(300_000)
    const topic = unique('notif')
    const publicUrl = stackValue('SCANTOR_PUBLIC_URL')
    ok(await api.call('updateNotificationSettings', { body: { ntfy: { topic, enabled: true, triggers: ['scanFinished', 'revisionBuilt'] } } }), 'subscribe')
    try {
      const echo = await tasks.example('echo')
      const scan = await scans.start({ revision: echo.revision.id })
      await scans.wait(scan.id)
      await expect
        .poll(async () => (await ntfyMessages(request, topic)).map((message) => message.title).sort(), { timeout: 60_000 })
        .toEqual(['Revision ready', `Scan ${scan.id.slice(0, 8)} completed`].sort())
      const messages = await ntfyMessages(request, topic)
      expect(messages.find((message) => message.title === 'Revision ready')).toMatchObject({
        message: expect.stringContaining(`@${echo.revision.number} is ready`),
        tags: ['package', 'scantor'],
        click: `${publicUrl}/tasks/${echo.task.id}/revisions/${echo.revision.number}`,
        authorized: false,
      })
      expect(messages.find((message) => message.title.startsWith('Scan '))).toMatchObject({
        message: '1 succeeded, 0 failed.',
        priority: 3,
        tags: ['white_check_mark', 'scantor'],
        click: `${publicUrl}/scans/${scan.id}`,
      })
      const settings = ok(await api.call<NotificationSettings>('getNotificationSettings'), 'getNotificationSettings')
      expect(settings.ntfy.lastDelivery).toMatchObject({ ok: true, status: 200 })
    } finally {
      ok(await api.call('updateNotificationSettings', { body: { ntfy: { enabled: false } } }), 'unsubscribe')
    }
  })
})
