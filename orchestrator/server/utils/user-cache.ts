import type { UserRole } from '#shared/utils/enums'
import { useAuthContext } from './auth'
import { toUserRole } from './principal'

// 30 s user cache (docs/auth.md §5.7) for principals that do not read the user fresh: internal capabilities,
// tools and editor cookies, the MCP endpoint and placement (`maxWorkers`). Every user mutation done by scantor
// invalidates the entry in-process, so a role or ban change applies to every user principal within 30 s.

export const USER_CACHE_TTL_MS = 30_000

export interface CachedUser {
  id: string
  email: string
  name: string
  role: UserRole
  banned: boolean
  banExpires: Date | null
  canRunPrivileged: boolean
  maxWorkers: number
}

interface Entry {
  user: CachedUser | null
  expiresAt: number
}

const cache = new Map<string, Entry>()

/** Maps a better-auth user record onto the cached shape. */
export function toCachedUser(raw: Record<string, unknown>): CachedUser {
  const banExpires = raw.banExpires ? new Date(raw.banExpires as string | Date) : null
  return {
    id: String(raw.id ?? raw._id),
    email: String(raw.email ?? ''),
    name: String(raw.name ?? ''),
    role: toUserRole(raw.role),
    banned: raw.banned === true,
    banExpires,
    canRunPrivileged: raw.canRunPrivileged === true,
    maxWorkers: typeof raw.maxWorkers === 'number' ? raw.maxWorkers : 0,
  }
}

/** A user is banned while `banned` is set and `banExpires` is unset or in the future. */
export function isUserBanned(user: Pick<CachedUser, 'banned' | 'banExpires'>, now = new Date()): boolean {
  return user.banned && (user.banExpires === null || user.banExpires > now)
}

/** The user (null when it does not exist), from the cache when fresh. */
export async function getCachedUser(userId: string, now = Date.now()): Promise<CachedUser | null> {
  const entry = cache.get(userId)
  if (entry && entry.expiresAt > now) return entry.user
  const ctx = await useAuthContext()
  const raw = (await ctx.internalAdapter.findUserById(userId)) as Record<string, unknown> | null
  const user = raw ? toCachedUser(raw) : null
  cache.set(userId, { user, expiresAt: now + USER_CACHE_TTL_MS })
  if (cache.size > 10_000) {
    for (const [id, stale] of cache) if (stale.expiresAt <= now) cache.delete(id)
  }
  return user
}

export function invalidateCachedUser(userId: string): void {
  cache.delete(userId)
}
