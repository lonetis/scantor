import type { Collection } from 'mongodb'
import type { NotificationSettings, NtfyChannelSettings } from '#shared/types/notifications'
import type { UpdateNotificationSettingsBody } from '#shared/schemas/notifications'
import { DEFAULT_NOTIFICATION_TRIGGERS, NOTIFICATION_TRIGGER_INFO, type NotificationTrigger } from '#shared/utils/notifications'
import type { NotificationSettingsDoc, NtfyChannelDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import { validationError } from '../../utils/errors'
import { useCollections } from '../../utils/mongo'
import { decryptSecret, encryptSecret } from '../../utils/secrets'
import { isoDate } from '../../utils/serialize'
import { getCachedUser } from '../../utils/user-cache'
import type { DeliveryOutcome } from './ntfy'

/*
 * Notification settings (docs/data-model.md §4.17): one document per user (`_id` = userId) with one object per channel
 * kind (`ntfy` today). The access token is stored encrypted (HKDF label `credentials`) and never returned. The event
 * sink reads settings through a 30 s cache that saves and purges invalidate in-process, so the event writers never wait
 * for MongoDB; the delivery job reads them fresh.
 */

export const SETTINGS_CACHE_TTL_MS = 30_000

type SettingsCollection = Collection<NotificationSettingsDoc>

const settingsCollection = (): SettingsCollection => useCollections().notificationSettings

export function ntfyTokenAad(userId: string): string {
  return `notificationSettings:${userId}:/ntfy/token`
}

export function emptyNtfyChannel(): NtfyChannelDoc {
  return { enabled: false, topic: null, tokenEnc: null, triggers: [...DEFAULT_NOTIFICATION_TRIGGERS], lastDelivery: null }
}

export async function findNotificationSettings(userId: string, collection = settingsCollection()): Promise<NotificationSettingsDoc | null> {
  return collection.findOne({ _id: userId })
}

export function toApiNotificationSettings(doc: NotificationSettingsDoc | null, config: Pick<Config, 'ntfyUrl'>): NotificationSettings {
  const ntfy = doc?.ntfy ?? emptyNtfyChannel()
  const channel: NtfyChannelSettings = {
    server: config.ntfyUrl,
    enabled: ntfy.enabled,
    topic: ntfy.topic,
    tokenSet: ntfy.tokenEnc !== null,
    triggers: [...ntfy.triggers],
    lastDelivery: ntfy.lastDelivery
      ? { at: isoDate(ntfy.lastDelivery.at), ok: ntfy.lastDelivery.ok, status: ntfy.lastDelivery.status, message: ntfy.lastDelivery.message }
      : null,
  }
  return { available: config.ntfyUrl !== null, ntfy: channel }
}

/**
 * Merges a PATCH into the stored settings: omitted fields keep their value, `token: null` removes the token. Admin-only
 * triggers need an admin, and enabling needs a topic (400 validationFailed at the field).
 */
export async function updateNotificationSettings(
  userId: string,
  body: UpdateNotificationSettingsBody,
  options: { isAdmin: boolean; now?: Date },
  collection = settingsCollection(),
): Promise<NotificationSettingsDoc> {
  const now = options.now ?? new Date()
  const current = await findNotificationSettings(userId, collection)
  if (body.ntfy === undefined) return current ?? { _id: userId, ntfy: null, createdAt: now, updatedAt: now }
  const ntfy: NtfyChannelDoc = { ...(current?.ntfy ?? emptyNtfyChannel()) }
  const patch = body.ntfy
  if (patch.enabled !== undefined) ntfy.enabled = patch.enabled
  if (patch.topic !== undefined) ntfy.topic = patch.topic
  if (patch.triggers !== undefined) {
    const forbidden = options.isAdmin ? [] : patch.triggers.filter((trigger) => NOTIFICATION_TRIGGER_INFO[trigger].adminOnly)
    if (forbidden.length > 0) throw validationError([{ path: 'ntfy.triggers', message: `${forbidden.join(', ')} is for admins only` }])
    ntfy.triggers = patch.triggers
  }
  if (patch.token !== undefined) ntfy.tokenEnc = patch.token === null ? null : encryptSecret(patch.token, 'credentials', ntfyTokenAad(userId))
  if (ntfy.enabled && ntfy.topic === null) throw validationError([{ path: 'ntfy.topic', message: 'a topic is required to enable notifications' }])
  // A new topic or token makes the last delivery meaningless.
  if (patch.topic !== undefined || patch.token !== undefined) ntfy.lastDelivery = null
  const updated = await collection.findOneAndUpdate(
    { _id: userId },
    { $set: { ntfy, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true, returnDocument: 'after' },
  )
  invalidateCachedNotificationSettings(userId)
  return updated ?? { _id: userId, ntfy, createdAt: now, updatedAt: now }
}

/** The stored access token in clear text (null when none is stored); throws SecretDecryptionError after a secret change. */
export function ntfyToken(userId: string, ntfy: Pick<NtfyChannelDoc, 'tokenEnc'>): string | null {
  return ntfy.tokenEnc === null ? null : decryptSecret(ntfy.tokenEnc, 'credentials', ntfyTokenAad(userId))
}

/** Records the outcome of a delivery (or test) on the user's ntfy channel. */
export async function recordNtfyDelivery(
  userId: string,
  outcome: Pick<DeliveryOutcome, 'ok' | 'status' | 'message'>,
  now = new Date(),
  collection = settingsCollection(),
): Promise<void> {
  await collection.updateOne(
    { _id: userId, ntfy: { $ne: null } },
    { $set: { 'ntfy.lastDelivery': { at: now, ok: outcome.ok, status: outcome.status, message: outcome.message } } },
  )
}

/** Deletes a user's settings (userPurge step, docs/data-model.md §5). */
export async function deleteNotificationSettings(userId: string, collection = settingsCollection()): Promise<void> {
  await collection.deleteOne({ _id: userId })
  invalidateCachedNotificationSettings(userId)
}

// ── cache of the event sink ─────────────────────────────────────────────────

/** What the event sink needs to decide on a recipient. */
export interface Subscription {
  enabled: boolean
  triggers: readonly NotificationTrigger[]
}

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

const subscriptions = new Map<string, CacheEntry<Subscription | null>>()
const adminSubscribers = new Map<NotificationTrigger, CacheEntry<string[]>>()

function toSubscription(doc: NotificationSettingsDoc | null): Subscription | null {
  return doc?.ntfy ? { enabled: doc.ntfy.enabled && doc.ntfy.topic !== null, triggers: doc.ntfy.triggers } : null
}

/** The user's subscription, from the cache when fresh. */
export async function cachedSubscription(userId: string, now = Date.now(), collection = settingsCollection()): Promise<Subscription | null> {
  const entry = subscriptions.get(userId)
  if (entry && entry.expiresAt > now) return entry.value
  const value = toSubscription(await collection.findOne({ _id: userId }, { projection: { ntfy: 1 } }))
  subscriptions.set(userId, { value, expiresAt: now + SETTINGS_CACHE_TTL_MS })
  if (subscriptions.size > 10_000) {
    for (const [id, stale] of subscriptions) if (stale.expiresAt <= now) subscriptions.delete(id)
  }
  return value
}

/** The admins with an enabled channel subscribed to `trigger` (events without an owner), from the cache when fresh. */
export async function cachedAdminSubscribers(trigger: NotificationTrigger, now = Date.now(), collection = settingsCollection()): Promise<string[]> {
  const entry = adminSubscribers.get(trigger)
  if (entry && entry.expiresAt > now) return entry.value
  const docs = await collection.find({ 'ntfy.enabled': true, 'ntfy.triggers': trigger, 'ntfy.topic': { $ne: null } }, { projection: { _id: 1 } }).toArray()
  const admins: string[] = []
  for (const doc of docs) {
    const user = await getCachedUser(doc._id)
    if (user?.role === 'admin') admins.push(doc._id)
  }
  adminSubscribers.set(trigger, { value: admins, expiresAt: now + SETTINGS_CACHE_TTL_MS })
  return admins
}

export function invalidateCachedNotificationSettings(userId: string): void {
  subscriptions.delete(userId)
  adminSubscribers.clear()
}

/** Test seam. */
export function resetNotificationSettingsCache(): void {
  subscriptions.clear()
  adminSubscribers.clear()
}
