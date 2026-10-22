import type { Filter } from 'mongodb'
import type { Page } from '#shared/types/common'
import type { User, UserUsage } from '#shared/types/users'
import { ACTIVE_WORKER_STATES } from '#shared/utils/enums'
import type { AuthUserDoc } from '../../types/documents'
import { apiError, invalidState } from '../../utils/errors'
import { useCollections } from '../../utils/mongo'
import { findPage } from '../../utils/pagination'
import { isoDate } from '../../utils/serialize'
import { type AuthUser, findAuthUser, toAuthUser } from '../../utils/users'

// User representations and listings for the `users` routes (docs/api.md §2 `User`, §4.4).

const EMPTY_USAGE: UserUsage = { activeWorkers: 0, tasks: 0, scans: 0 }

/** Usage counters of several users in three grouped queries. */
export async function usageOf(userIds: string[]): Promise<Map<string, UserUsage>> {
  const { workers, tasks, scans } = useCollections()
  const usage = new Map<string, UserUsage>(userIds.map((id) => [id, { ...EMPTY_USAGE }]))
  if (userIds.length === 0) return usage
  const count = async (
    collection: typeof workers | typeof tasks | typeof scans,
    filter: Record<string, unknown>,
    field: keyof UserUsage,
  ) => {
    const rows = await (collection as typeof workers)
      .aggregate<{ _id: string; n: number }>([{ $match: { userId: { $in: userIds }, ...filter } }, { $group: { _id: '$userId', n: { $sum: 1 } } }])
      .toArray()
    for (const row of rows) {
      const entry = usage.get(row._id)
      if (entry) entry[field] = row.n
    }
  }
  await Promise.all([
    count(workers, { state: { $in: [...ACTIVE_WORKER_STATES] } }, 'activeWorkers'),
    count(tasks, { deletingAt: null }, 'tasks'),
    count(scans, { state: { $nin: ['deleting', 'deleted'] } }, 'scans'),
  ])
  return usage
}

export function toApiUser(user: AuthUser, usage: UserUsage = EMPTY_USAGE): User {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    banned: user.banned,
    banReason: user.banReason,
    canRunPrivileged: user.canRunPrivileged,
    maxWorkers: user.maxWorkers,
    createdAt: isoDate(user.createdAt),
    updatedAt: isoDate(user.updatedAt),
    usage,
  }
}

/**
 * 409 invalidState while a `userPurge` job deletes the user: the account is locked out and must not be changed or
 * unbanned until the purge has removed it.
 */
export async function assertUserNotBeingDeleted(userId: string): Promise<void> {
  const purge = await useCollections().jobs.findOne({ kind: 'userPurge', 'subject.id': userId, active: true }, { projection: { _id: 1 } })
  if (purge) throw invalidState('user', 'deleting', [], 'this operation')
}

/** One user with usage counters; 404 when it does not exist. */
export async function getApiUser(userId: string): Promise<User> {
  const user = await findAuthUser(userId)
  if (!user) throw apiError('notFound', 'user not found')
  return toApiUser(user, (await usageOf([user.id])).get(user.id))
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Newest-first page of users, optionally filtered by a case-insensitive email or name substring. */
export async function listApiUsers(options: { q?: string; limit?: number; cursor?: string }): Promise<Page<User>> {
  const filter: Filter<AuthUserDoc> = {}
  if (options.q) {
    const pattern = new RegExp(escapeRegex(options.q), 'i')
    filter.$or = [{ email: pattern }, { name: pattern }]
  }
  const page = await findPage(useCollections().authUsers, filter, options, (doc) =>
    toAuthUser({ ...doc, id: doc._id } as unknown as Record<string, unknown>),
  )
  const usage = await usageOf(page.items.map((user) => user.id))
  return { items: page.items.map((user) => toApiUser(user, usage.get(user.id))), nextCursor: page.nextCursor }
}
