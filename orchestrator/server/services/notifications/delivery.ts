import { randomUUID } from 'node:crypto'
import type { Collection } from 'mongodb'
import type { UserRole } from '#shared/utils/enums'
import { NOTIFICATION_TRIGGERS, type NotificationTrigger } from '#shared/utils/notifications'
import type { EventDoc, NotificationSettingsDoc, ScanDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import type { EventSink } from '../../utils/event-sinks'
import { type CreateJobInput, createJob, FatalJobError, type JobKindDefinition } from '../../utils/jobs'
import { useCollections } from '../../utils/mongo'
import { SecretDecryptionError } from '../../utils/secrets'
import { getCachedUser } from '../../utils/user-cache'
import { buildNotificationMessage, type NotificationEvent, type ScanSubject } from './messages'
import { type DeliveryOutcome, publishNtfy } from './ntfy'
import { cachedAdminSubscribers, cachedSubscription, ntfyToken, recordNtfyDelivery } from './settings'
import { isAdminOnlyTrigger, triggerOf } from './triggers'

/*
 * From events to pushes (docs/architecture.md §11.6): the event sink maps every written event onto its trigger
 * (without I/O), finds the subscribed recipients through the settings cache (the owner, or the subscribed admins for
 * events without an owner) and creates one `notification` job per recipient. The job, run by the reconciler component,
 * reads the settings fresh (a channel disabled meanwhile skips), builds the message, publishes it to ntfy and records
 * the outcome; 408, 429, 5xx and unreachable servers are retried with backoff, other answers fail the job at once.
 * Jobs survive restarts and stop with the runner (the publish uses the job's signal).
 */

export interface NotificationJobParams {
  trigger: NotificationTrigger
  event: NotificationEvent
}

function eventSnapshot(event: EventDoc): NotificationEvent {
  const snapshot: NotificationEvent = { id: event._id, type: event.type, level: event.level, message: event.message }
  if (event.scanId) snapshot.scanId = event.scanId
  if (event.taskId) snapshot.taskId = event.taskId
  if (event.revisionId) snapshot.revisionId = event.revisionId
  if (event.nodeId) snapshot.nodeId = event.nodeId
  if (event.data) snapshot.data = event.data
  return snapshot
}

export interface EnqueueDeps {
  subscription(userId: string): Promise<{ enabled: boolean; triggers: readonly NotificationTrigger[] } | null>
  adminSubscribers(trigger: NotificationTrigger): Promise<string[]>
  createJob(input: CreateJobInput): Promise<unknown>
}

const defaultEnqueueDeps = (): EnqueueDeps => ({
  subscription: (userId) => cachedSubscription(userId),
  adminSubscribers: (trigger) => cachedAdminSubscribers(trigger),
  createJob: (input) => createJob(input),
})

/** Creates the notification jobs of written events; returns how many were created. */
export async function enqueueNotifications(events: readonly EventDoc[], deps: EnqueueDeps = defaultEnqueueDeps()): Promise<number> {
  let created = 0
  for (const event of events) {
    const trigger = triggerOf(event)
    if (trigger === null) continue
    const recipients = event.userId !== null ? [event.userId] : isAdminOnlyTrigger(trigger) ? await deps.adminSubscribers(trigger) : []
    for (const userId of recipients) {
      const subscription = await deps.subscription(userId)
      if (!subscription?.enabled || !subscription.triggers.includes(trigger)) continue
      const params: NotificationJobParams = { trigger, event: eventSnapshot(event) }
      await deps.createJob({ kind: 'notification', userId, subject: { kind: 'notification', id: randomUUID() }, params: { ...params } })
      created++
    }
  }
  return created
}

/** The event sink of push notifications (registered by server/plugins/80.notifications.ts). */
export function notificationEventSink(enabled: () => boolean, deps?: EnqueueDeps): EventSink {
  return {
    name: 'notifications',
    accept: (event) => triggerOf(event) !== null && enabled(),
    async consume(events) {
      await enqueueNotifications(events, deps)
    },
  }
}

// ── delivery ────────────────────────────────────────────────────────────────

export interface DeliveryDeps {
  config: Pick<Config, 'ntfyUrl' | 'publicUrl'>
  settings: Collection<NotificationSettingsDoc>
  scans: Collection<ScanDoc>
  userRole(userId: string): Promise<UserRole | null>
  publish: typeof publishNtfy
  signal?: AbortSignal
  now?: () => Date
}

export type DeliveryResult = { delivered: false; skipped: string } | ({ delivered: boolean; skipped?: undefined } & DeliveryOutcome)

function parseParams(raw: Record<string, unknown>): NotificationJobParams {
  const params = raw as Partial<NotificationJobParams>
  const event = params.event
  if (!params.trigger || !NOTIFICATION_TRIGGERS.includes(params.trigger) || !event || typeof event.id !== 'string' || typeof event.message !== 'string') {
    throw new FatalJobError('invalidParams', 'the notification job has no valid trigger and event')
  }
  return { trigger: params.trigger, event }
}

async function scanSubject(event: NotificationEvent, userId: string, scans: Collection<ScanDoc>): Promise<ScanSubject | null> {
  if (!event.scanId) return null
  const scan = await scans.findOne({ _id: event.scanId, userId }, { projection: { name: 1, stats: 1 } })
  if (!scan) return null
  return {
    name: scan.name ?? null,
    stats: { succeeded: scan.stats?.succeeded ?? 0, failed: scan.stats?.failed ?? 0, lost: scan.stats?.lost ?? 0, cancelled: scan.stats?.cancelled ?? 0 },
  }
}

/** Delivers one notification job's message to the recipient's current ntfy channel. */
export async function deliverNotification(userId: string, rawParams: Record<string, unknown>, deps: DeliveryDeps): Promise<DeliveryResult> {
  const { trigger, event } = parseParams(rawParams)
  const server = deps.config.ntfyUrl
  if (server === null) return { delivered: false, skipped: 'notifications are disabled on this instance' }
  const settings = await deps.settings.findOne({ _id: userId })
  const ntfy = settings?.ntfy
  if (!ntfy?.enabled || ntfy.topic === null || !ntfy.triggers.includes(trigger))
    return { delivered: false, skipped: 'the channel is disabled or no longer subscribed' }
  const role = await deps.userRole(userId)
  if (role === null) return { delivered: false, skipped: 'the user no longer exists' }
  if (isAdminOnlyTrigger(trigger) && role !== 'admin') return { delivered: false, skipped: 'the trigger is for admins only' }
  let token: string | null
  try {
    token = ntfyToken(userId, ntfy)
  } catch (error) {
    if (!(error instanceof SecretDecryptionError)) throw error
    const outcome = { ok: false, status: null, message: 'the stored access token cannot be decrypted; save it again', retryable: false }
    await recordNtfyDelivery(userId, outcome, deps.now?.() ?? new Date(), deps.settings)
    return { delivered: false, ...outcome }
  }
  const message = buildNotificationMessage(trigger, event, { publicUrl: deps.config.publicUrl, scan: await scanSubject(event, userId, deps.scans) })
  const outcome = await deps.publish({ server, topic: ntfy.topic, token }, message, { signal: deps.signal })
  await recordNtfyDelivery(userId, outcome, deps.now?.() ?? new Date(), deps.settings)
  return { delivered: outcome.ok, ...outcome }
}

/** The `notification` job kind (docs/data-model.md §4.12). */
export const notificationJobKind: JobKindDefinition = {
  component: 'reconciler',
  concurrency: 4,
  maxAttempts: 5,
  backoff: { initialMs: 10_000, maxMs: 600_000 },
  async handler(job, ctx) {
    if (job.userId === null) throw new FatalJobError('invalidParams', 'a notification job needs a recipient')
    const { notificationSettings, scans } = useCollections()
    const result = await deliverNotification(job.userId, job.params, {
      config: ctx.config,
      settings: notificationSettings,
      scans,
      userRole: async (userId) => (await getCachedUser(userId))?.role ?? null,
      publish: publishNtfy,
      signal: ctx.signal,
    })
    if (result.skipped !== undefined) {
      ctx.log.debug('notification skipped', { jobId: job._id, reason: result.skipped })
      return
    }
    if (result.ok) return
    if (result.retryable) throw new Error(result.message ?? 'the ntfy server did not accept the notification')
    throw new FatalJobError('notificationRejected', result.message ?? 'the ntfy server rejected the notification')
  },
}
