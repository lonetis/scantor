import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationTrigger } from '#shared/utils/notifications'
import type { EventDoc, NotificationSettingsDoc, ScanDoc } from '../../../server/types/documents'
import type { CreateJobInput } from '../../../server/utils/jobs'
import { FakeCollection } from '../../helpers/fake-collection'

// From events to pushes (docs/architecture.md §11.6): the event sink creates one `notification` job per subscribed
// recipient, and the job delivers to the recipient's current channel, skipping what was disabled meanwhile.

vi.mock('../../../server/utils/mongo', () => ({ useCollections: vi.fn() }))
vi.mock('../../../server/utils/user-cache', () => ({ getCachedUser: vi.fn() }))
vi.mock('../../../server/utils/keys', async (original) => {
  const actual = await original<typeof import('../../../server/utils/keys')>()
  const keyring = actual.createKeyring('test-secret-for-notification-delivery')
  return { ...actual, useKeys: () => keyring }
})

const { deliverNotification, enqueueNotifications, notificationEventSink } = await import('../../../server/services/notifications/delivery')
const { ntfyTokenAad } = await import('../../../server/services/notifications/settings')
const { encryptSecret } = await import('../../../server/utils/secrets')
const { FatalJobError } = await import('../../../server/utils/jobs')
type DeliveryDeps = import('../../../server/services/notifications/delivery').DeliveryDeps

const alice = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const admin = '1b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c12'
const scanId = '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f'

function event(overrides: Partial<EventDoc>): EventDoc {
  return {
    _id: 'e1',
    at: new Date('2026-11-07T10:00:00.000Z'),
    type: 'scan.stateChanged',
    level: 'info',
    userId: alice,
    scanId,
    message: 'scan running → completed (completed)',
    data: { from: 'running', to: 'completed', reason: 'completed' },
    ...overrides,
  }
}

describe('enqueueNotifications', () => {
  const subscriptions = new Map<string, { enabled: boolean; triggers: NotificationTrigger[] }>()
  let jobs: CreateJobInput[]
  const deps = {
    subscription: async (userId: string) => subscriptions.get(userId) ?? null,
    adminSubscribers: async (trigger: NotificationTrigger) => (trigger === 'nodeAvailability' ? [admin] : []),
    createJob: async (input: CreateJobInput) => {
      jobs.push(input)
    },
  }

  beforeEach(() => {
    jobs = []
    subscriptions.clear()
    subscriptions.set(alice, { enabled: true, triggers: ['scanFinished', 'revisionBuilt'] })
    subscriptions.set(admin, { enabled: true, triggers: ['nodeAvailability'] })
  })

  it('creates one job per subscribed recipient with the trigger and an event snapshot', async () => {
    const created = await enqueueNotifications(
      [
        event({}),
        event({ _id: 'e2', type: 'scan.conditionRaised', level: 'error', data: { type: 'crashLoop' } }), // not subscribed
        event({ _id: 'e3', type: 'worker.started' }), // no trigger
        event({
          _id: 'e4',
          type: 'node.offline',
          level: 'warning',
          userId: null,
          scanId: undefined,
          nodeId: 'n1',
          message: 'node edge-1 offline',
          data: undefined,
        }),
      ],
      deps,
    )
    expect(created).toBe(2)
    expect(jobs.map((job) => [job.kind, job.userId, job.subject.kind, (job.params as { trigger: string }).trigger])).toEqual([
      ['notification', alice, 'notification', 'scanFinished'],
      ['notification', admin, 'notification', 'nodeAvailability'],
    ])
    expect(jobs[0]!.params).toEqual({
      trigger: 'scanFinished',
      event: {
        id: 'e1',
        type: 'scan.stateChanged',
        level: 'info',
        message: 'scan running → completed (completed)',
        scanId,
        data: { from: 'running', to: 'completed', reason: 'completed' },
      },
    })
    // Every job gets its own subject, so two deliveries never collide in the one-active-job index.
    expect(jobs[0]!.subject.id).not.toBe(jobs[1]!.subject.id)
  })

  it('skips disabled channels and recipients without settings', async () => {
    subscriptions.set(alice, { enabled: false, triggers: ['scanFinished'] })
    expect(await enqueueNotifications([event({})], deps)).toBe(0)
    subscriptions.delete(alice)
    expect(await enqueueNotifications([event({})], deps)).toBe(0)
  })

  it('filters in the sink without I/O and only while notifications are on', async () => {
    let on = true
    const sink = notificationEventSink(() => on, deps)
    expect(sink.accept(event({}))).toBe(true)
    expect(sink.accept(event({ type: 'worker.started' }))).toBe(false)
    on = false
    expect(sink.accept(event({}))).toBe(false)
    await sink.consume([event({})])
    expect(jobs).toHaveLength(1)
  })
})

describe('deliverNotification', () => {
  const settings = new FakeCollection<NotificationSettingsDoc>('notificationSettings')
  const scans = new FakeCollection<ScanDoc>('scans')
  const publish = vi.fn()
  const roles = new Map<string, 'admin' | 'user'>()
  const params = { trigger: 'scanFinished', event: { id: 'e1', type: 'scan.stateChanged', level: 'info', message: 'done', scanId, data: { to: 'completed' } } }

  function deps(overrides: Partial<DeliveryDeps> = {}): DeliveryDeps {
    return {
      config: { ntfyUrl: 'https://ntfy.example.com', publicUrl: 'https://scantor.example.com' },
      settings: settings.asCollection(),
      scans: scans.asCollection(),
      userRole: async (userId) => roles.get(userId) ?? null,
      publish,
      now: () => new Date('2026-11-07T10:00:00.000Z'),
      ...overrides,
    }
  }

  function channel(userId: string, overrides: Partial<NonNullable<NotificationSettingsDoc['ntfy']>> = {}) {
    const now = new Date()
    settings.docs.push({
      _id: userId,
      ntfy: {
        enabled: true,
        topic: 'alice-topic',
        tokenEnc: encryptSecret('tk_alice', 'credentials', ntfyTokenAad(userId)),
        triggers: ['scanFinished'],
        lastDelivery: null,
        ...overrides,
      },
      createdAt: now,
      updatedAt: now,
    })
  }

  beforeEach(() => {
    settings.docs.length = 0
    scans.docs.length = 0
    publish.mockReset()
    publish.mockResolvedValue({ ok: true, status: 200, message: null, retryable: false })
    roles.clear()
    roles.set(alice, 'user')
    roles.set(admin, 'admin')
    scans.docs.push({ _id: scanId, userId: alice, name: 'nightly', stats: { succeeded: 5, failed: 1, lost: 0, cancelled: 0 } })
  })

  it('publishes to the current channel with the decrypted token and records the outcome', async () => {
    channel(alice)
    const result = await deliverNotification(alice, params, deps())
    expect(result).toEqual({ delivered: true, ok: true, status: 200, message: null, retryable: false })
    expect(publish).toHaveBeenCalledOnce()
    const [target, message] = publish.mock.calls[0]!
    expect(target).toEqual({ server: 'https://ntfy.example.com', topic: 'alice-topic', token: 'tk_alice' })
    expect(message).toMatchObject({
      title: 'Scan "nightly" completed',
      message: '5 succeeded, 1 failed.',
      click: `https://scantor.example.com/scans/${scanId}`,
    })
    expect((settings.docs[0] as unknown as NotificationSettingsDoc).ntfy!.lastDelivery).toEqual({
      at: new Date('2026-11-07T10:00:00.000Z'),
      ok: true,
      status: 200,
      message: null,
    })
  })

  it("never reads another user's scan for the message", async () => {
    channel(admin, { triggers: ['scanFinished'] })
    await deliverNotification(admin, params, deps())
    expect(publish.mock.calls[0]![1]).toMatchObject({ title: 'Scan 5e1f0c2d completed', message: 'The scan completed.' })
  })

  it('skips what changed since the event: disabled channels, unsubscribed triggers, lost admin power, the feature off', async () => {
    channel(alice, { enabled: false })
    expect(await deliverNotification(alice, params, deps())).toMatchObject({ delivered: false, skipped: expect.any(String) })
    settings.docs.length = 0
    channel(alice, { triggers: ['revisionBuilt'] })
    expect(await deliverNotification(alice, params, deps())).toMatchObject({ skipped: expect.any(String) })
    settings.docs.length = 0
    channel(alice, { triggers: ['nodeAvailability'] })
    const nodeParams = { trigger: 'nodeAvailability', event: { id: 'e4', type: 'node.offline', level: 'warning', message: 'offline', nodeId: 'n1' } }
    expect(await deliverNotification(alice, nodeParams, deps())).toMatchObject({ skipped: 'the trigger is for admins only' })
    expect(await deliverNotification(alice, params, deps({ config: { ntfyUrl: null, publicUrl: 'https://scantor.example.com' } }))).toMatchObject({
      skipped: expect.any(String),
    })
    expect(await deliverNotification(admin, params, deps())).toMatchObject({ skipped: expect.any(String) })
    roles.delete(alice)
    settings.docs.length = 0
    channel(alice)
    expect(await deliverNotification(alice, params, deps())).toMatchObject({ skipped: 'the user no longer exists' })
    expect(publish).not.toHaveBeenCalled()
  })

  it('records a rejection and an undecryptable token', async () => {
    channel(alice)
    publish.mockResolvedValue({ ok: false, status: 403, message: 'the ntfy server answered 403: forbidden', retryable: false })
    expect(await deliverNotification(alice, params, deps())).toMatchObject({ delivered: false, status: 403, retryable: false })
    expect((settings.docs[0] as unknown as NotificationSettingsDoc).ntfy!.lastDelivery).toMatchObject({ ok: false, status: 403 })

    settings.docs.length = 0
    channel(alice, { tokenEnc: encryptSecret('tk_alice', 'credentials', ntfyTokenAad(admin)) })
    publish.mockClear()
    expect(await deliverNotification(alice, params, deps())).toMatchObject({
      delivered: false,
      retryable: false,
      message: 'the stored access token cannot be decrypted; save it again',
    })
    expect(publish).not.toHaveBeenCalled()
  })

  it('fails jobs with broken params at once', async () => {
    await expect(deliverNotification(alice, { trigger: 'nope', event: {} }, deps())).rejects.toBeInstanceOf(FatalJobError)
  })
})
