import type { ApiKeyConfigId, UserRole } from '#shared/utils/enums'
import { useAuth, useAuthContext } from './auth'
import { resolveMcpConfig } from './auth-policy'
import { useConfig } from './config'
import { apiError } from './errors'
import { type Logger, useLogger } from './logger'
import { invalidateCachedUser } from './user-cache'

/*
 * Typed wrappers around better-auth for user, account, API key and OAuth app management (docs/auth.md §2.3,
 * §5.7, §6.3, §8). Every write to better-auth data goes through better-auth (`auth.api.*`, `internalAdapter`,
 * `adapter`); scantor reads `user` and `apikey` directly only for listings.
 *
 * Lockout hooks (extension seam): domain areas register what must happen when a user loses access (ban, deletion):
 *
 *   registerUserLockoutHook({ name: 'editor', order: 50, run: async (userId, { cancelScans, reason }) => … })
 *
 * The editor area stops the user's editor (which deletes its editor key, order 50); the scans area cancels the user's
 * non-terminal scans when `cancelScans` is true (order 60). Hooks run after sessions, API keys and OAuth grants are
 * gone, every one of them even when an earlier one failed.
 */

export interface LockoutOptions {
  /** ban: the admin chose "cancel all scans"; deletion: false (the purge job cancels scans) */
  cancelScans: boolean
  reason: 'ban' | 'delete'
}

export interface UserLockoutHook {
  name: string
  order: number
  run(userId: string, options: LockoutOptions): Promise<void>
}

const globalKey = '__scantorUserLockoutHooks'
type GlobalWithHooks = typeof globalThis & { [globalKey]?: UserLockoutHook[] }

function lockoutHooks(): UserLockoutHook[] {
  const global = globalThis as GlobalWithHooks
  global[globalKey] ??= []
  return global[globalKey]
}

export function registerUserLockoutHook(hook: UserLockoutHook): void {
  if (lockoutHooks().some((existing) => existing.name === hook.name)) throw new Error(`lockout hook ${hook.name} is registered twice`)
  lockoutHooks().push(hook)
  lockoutHooks().sort((a, b) => a.order - b.order)
}

export function resetUserLockoutHooks(): void {
  lockoutHooks().length = 0
}

// ── reading ─────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string
  email: string
  name: string
  role: UserRole
  banned: boolean
  banReason: string | null
  banExpires: Date | null
  canRunPrivileged: boolean
  maxWorkers: number
  createdAt: Date
  updatedAt: Date
}

export function toAuthUser(raw: Record<string, unknown>): AuthUser {
  return {
    id: String(raw.id ?? raw._id),
    email: String(raw.email ?? ''),
    name: String(raw.name ?? ''),
    role: raw.role === 'admin' ? 'admin' : 'user',
    banned: raw.banned === true,
    banReason: typeof raw.banReason === 'string' ? raw.banReason : null,
    banExpires: raw.banExpires ? new Date(raw.banExpires as string) : null,
    canRunPrivileged: raw.canRunPrivileged === true,
    maxWorkers: typeof raw.maxWorkers === 'number' ? raw.maxWorkers : 0,
    createdAt: new Date(raw.createdAt as string),
    updatedAt: new Date(raw.updatedAt as string),
  }
}

export async function findAuthUser(userId: string): Promise<AuthUser | null> {
  const ctx = await useAuthContext()
  const raw = (await ctx.internalAdapter.findUserById(userId)) as Record<string, unknown> | null
  return raw ? toAuthUser(raw) : null
}

export async function findAuthUserByEmail(email: string): Promise<AuthUser | null> {
  const ctx = await useAuthContext()
  const found = (await ctx.internalAdapter.findUserByEmail(email.toLowerCase())) as { user: Record<string, unknown> } | null
  return found ? toAuthUser(found.user) : null
}

export interface CredentialSummary {
  hasPassword: boolean
  passkeyCount: number
}

export async function credentialSummary(userId: string): Promise<CredentialSummary> {
  const ctx = await useAuthContext()
  const accounts = (await ctx.internalAdapter.findAccounts(userId)) as { providerId: string; password?: string | null }[]
  const hasPassword = accounts.some((account) => account.providerId === 'credential' && !!account.password)
  const passkeyCount = ctx.options.plugins?.some((plugin: { id?: string }) => plugin.id === 'passkey')
    ? ((await ctx.adapter.count({ model: 'passkey', where: [{ field: 'userId', value: userId }] })) as number)
    : 0
  return { hasPassword, passkeyCount }
}

// ── user management (admin) ─────────────────────────────────────────────────

export interface CreateUserInput {
  email: string
  name: string
  password?: string
  role: UserRole
  canRunPrivileged: boolean
  maxWorkers?: number
}

export async function createUserAccount(input: CreateUserInput): Promise<AuthUser> {
  const email = input.email.toLowerCase()
  if (await findAuthUserByEmail(email)) throw apiError('alreadyExists', `a user with email ${email} already exists`)
  const result = (await useAuth().api.createUser({
    body: {
      email,
      name: input.name,
      ...(input.password ? { password: input.password } : {}),
      role: input.role,
      data: { canRunPrivileged: input.canRunPrivileged, maxWorkers: input.maxWorkers ?? useConfig().userMaxWorkers },
    },
  })) as { user: Record<string, unknown> }
  return toAuthUser(result.user)
}

export interface UpdateUserInput {
  name?: string
  email?: string
  role?: UserRole
  canRunPrivileged?: boolean
  maxWorkers?: number
}

export async function updateUserAccount(userId: string, input: UpdateUserInput): Promise<AuthUser> {
  const ctx = await useAuthContext()
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) if (value !== undefined) patch[key] = value
  if (typeof patch.email === 'string') {
    patch.email = patch.email.toLowerCase()
    const other = await findAuthUserByEmail(patch.email as string)
    if (other && other.id !== userId) throw apiError('alreadyExists', `a user with email ${patch.email} already exists`)
  }
  const raw = (await ctx.internalAdapter.updateUser(userId, { ...patch, updatedAt: new Date() })) as Record<string, unknown>
  invalidateCachedUser(userId)
  return toAuthUser(raw)
}

/** Sets a user's password (creating the credential account when missing) and revokes their sessions. */
export async function setUserPassword(userId: string, password: string, options: { revokeSessions?: boolean } = {}): Promise<void> {
  const ctx = await useAuthContext()
  const hash = await ctx.password.hash(password)
  const credential = await ctx.internalAdapter.findCredentialAccount(userId)
  if (credential) await ctx.internalAdapter.updatePassword(userId, hash)
  else await ctx.internalAdapter.createAccount({ userId, providerId: 'credential', accountId: userId, password: hash })
  if (options.revokeSessions ?? true) await ctx.internalAdapter.deleteUserSessions(userId)
  invalidateCachedUser(userId)
}

/** Deletes every session, API key (both configurations) and OAuth token/consent of a user (docs/auth.md §5.7). */
export async function revokeUserAccess(userId: string): Promise<void> {
  const ctx = await useAuthContext()
  await ctx.internalAdapter.deleteUserSessions(userId)
  await ctx.adapter.deleteMany({ model: 'apikey', where: [{ field: 'referenceId', value: userId }] })
  if (resolveMcpConfig(useConfig()).oauth) {
    for (const model of ['oauthAccessToken', 'oauthRefreshToken', 'oauthConsent']) {
      await ctx.adapter.deleteMany({ model, where: [{ field: 'userId', value: userId }] })
    }
  }
}

/** Thrown after every lockout hook ran when at least one of them failed. */
export class LockoutHooksError extends AggregateError {
  constructor(
    readonly hooks: string[],
    errors: unknown[],
  ) {
    super(errors, `user lockout hooks failed: ${hooks.join(', ')}`)
    this.name = 'LockoutHooksError'
  }
}

/**
 * Runs every lockout hook in order, also after one failed (a failed editor stop must not leave the scans running, and
 * the other way round). Throws LockoutHooksError at the end when any of them failed; each failure is logged.
 */
export async function runLockoutHooks(userId: string, options: LockoutOptions, log: Logger): Promise<void> {
  const failed: string[] = []
  const errors: unknown[] = []
  for (const hook of lockoutHooks()) {
    try {
      await hook.run(userId, options)
    } catch (error) {
      log.error('user lockout hook failed', { hook: hook.name, userId, reason: options.reason, err: error })
      failed.push(hook.name)
      errors.push(error)
    }
  }
  if (errors.length > 0) throw new LockoutHooksError(failed, errors)
}

/** Ban effects in order (docs/auth.md §5.7); a failed lockout hook throws after all of them ran (a repeated ban retries). */
export async function banUserAccount(
  userId: string,
  options: { reason: string | null; cancelScans: boolean },
  log: Logger = useLogger('users'),
): Promise<AuthUser> {
  const ctx = await useAuthContext()
  const raw = (await ctx.internalAdapter.updateUser(userId, {
    banned: true,
    banReason: options.reason,
    banExpires: null,
    updatedAt: new Date(),
  })) as Record<string, unknown>
  invalidateCachedUser(userId)
  await revokeUserAccess(userId)
  await runLockoutHooks(userId, { cancelScans: options.cancelScans, reason: 'ban' }, log)
  return toAuthUser(raw)
}

/** Clears the ban flag only; keys, sessions and OAuth grants stay deleted. */
export async function unbanUserAccount(userId: string): Promise<AuthUser> {
  const ctx = await useAuthContext()
  const raw = (await ctx.internalAdapter.updateUser(userId, {
    banned: false,
    banReason: null,
    banExpires: null,
    updatedAt: new Date(),
  })) as Record<string, unknown>
  invalidateCachedUser(userId)
  return toAuthUser(raw)
}

/**
 * The immediate part of `deleteUser`: lock the user out (ban steps 1–5 with reason "deleted"). The ban flag and the
 * revoked credentials must succeed (else it throws and no purge job starts). A failed lockout hook does not stop the
 * deletion: it is logged, and the `userPurge` job's steps 10 and 20 cancel the scans and stop the editor again.
 */
export async function lockOutDeletedUser(userId: string, log: Logger = useLogger('users')): Promise<void> {
  const ctx = await useAuthContext()
  await ctx.internalAdapter.updateUser(userId, { banned: true, banReason: 'deleted', banExpires: null, updatedAt: new Date() })
  invalidateCachedUser(userId)
  await revokeUserAccess(userId)
  try {
    await runLockoutHooks(userId, { cancelScans: false, reason: 'delete' }, log)
  } catch (error) {
    if (!(error instanceof LockoutHooksError)) throw error
    log.warn('deleting the user although lockout hooks failed; the purge job repeats them', { userId, hooks: error.hooks })
  }
}

/** Final step of the userPurge job: removes the better-auth user and every remaining credential row. */
export async function deleteAuthUser(userId: string): Promise<void> {
  const ctx = await useAuthContext()
  await revokeUserAccess(userId)
  await ctx.internalAdapter.deleteAccounts(userId)
  if (ctx.options.plugins?.some((plugin: { id?: string }) => plugin.id === 'passkey')) {
    await ctx.adapter.deleteMany({ model: 'passkey', where: [{ field: 'userId', value: userId }] })
  }
  if (await ctx.internalAdapter.findUserById(userId)) await ctx.internalAdapter.deleteUser(userId)
  invalidateCachedUser(userId)
}

// ── own account ─────────────────────────────────────────────────────────────

/** `setAccountPassword`: only when the user has no password yet (409 alreadyExists). */
export async function setOwnPassword(userId: string, newPassword: string): Promise<void> {
  const summary = await credentialSummary(userId)
  if (summary.hasPassword) throw apiError('alreadyExists', 'a password is already set; use change-password')
  await setUserPassword(userId, newPassword, { revokeSessions: false })
}

/** `removeAccountPassword`: only when a passkey remains (409 lastCredential). */
export async function removeOwnPassword(userId: string): Promise<void> {
  const summary = await credentialSummary(userId)
  if (summary.passkeyCount === 0) throw apiError('lastCredential', 'cannot remove the password: no passkey is registered')
  const ctx = await useAuthContext()
  await ctx.adapter.deleteMany({
    model: 'account',
    where: [
      { field: 'userId', value: userId },
      { field: 'providerId', value: 'credential' },
    ],
  })
}

// ── API keys (docs/auth.md §8) ──────────────────────────────────────────────

export interface ApiKeyRecord {
  id: string
  name: string | null
  start: string | null
  configId: ApiKeyConfigId
  enabled: boolean
  createdAt: Date
  expiresAt: Date | null
  lastRequest: Date | null
}

function toApiKeyRecord(raw: Record<string, unknown>): ApiKeyRecord {
  return {
    id: String(raw.id ?? raw._id),
    name: typeof raw.name === 'string' ? raw.name : null,
    start: typeof raw.start === 'string' ? raw.start : null,
    configId: raw.configId === 'editor' ? 'editor' : 'default',
    enabled: raw.enabled !== false,
    createdAt: new Date(raw.createdAt as string),
    expiresAt: raw.expiresAt ? new Date(raw.expiresAt as string) : null,
    lastRequest: raw.lastRequest ? new Date(raw.lastRequest as string) : null,
  }
}

export async function listUserApiKeys(userId: string, configId?: ApiKeyConfigId): Promise<ApiKeyRecord[]> {
  const ctx = await useAuthContext()
  const where: { field: string; value: string }[] = [{ field: 'referenceId', value: userId }]
  if (configId) where.push({ field: 'configId', value: configId })
  const rows = (await ctx.adapter.findMany({ model: 'apikey', where, sortBy: { field: 'createdAt', direction: 'desc' } })) as Record<string, unknown>[]
  return rows.map(toApiKeyRecord)
}

/** Creates a key server-side (no headers); the plain key appears only in this result. */
export async function createUserApiKey(
  userId: string,
  input: { name: string; configId: ApiKeyConfigId; expiresInDays?: number },
): Promise<{ apiKey: ApiKeyRecord; key: string }> {
  const result = (await useAuth().api.createApiKey({
    body: {
      userId,
      name: input.name,
      configId: input.configId,
      ...(input.expiresInDays !== undefined ? { expiresIn: input.expiresInDays * 86_400 } : {}),
    },
  })) as Record<string, unknown> & { key: string }
  return { apiKey: toApiKeyRecord(result), key: result.key }
}

/** Deletes one of the user's keys; false when the user has no such key. */
export async function deleteUserApiKey(userId: string, keyId: string): Promise<boolean> {
  const ctx = await useAuthContext()
  const key = (await ctx.adapter.findOne({
    model: 'apikey',
    where: [
      { field: 'id', value: keyId },
      { field: 'referenceId', value: userId },
    ],
  })) as Record<string, unknown> | null
  if (!key) return false
  await ctx.adapter.delete({ model: 'apikey', where: [{ field: 'id', value: keyId }] })
  return true
}

/** Deletes every key of one configuration of a user (editor key rotation). */
export async function deleteUserApiKeysOf(userId: string, configId: ApiKeyConfigId): Promise<void> {
  const ctx = await useAuthContext()
  await ctx.adapter.deleteMany({
    model: 'apikey',
    where: [
      { field: 'referenceId', value: userId },
      { field: 'configId', value: configId },
    ],
  })
}

// ── OAuth applications (MCP clients) ────────────────────────────────────────

export interface OAuthAppRecord {
  clientId: string
  name: string | null
  uri: string | null
  scopes: string[]
  createdAt: Date
}

function oauthAvailable(): boolean {
  return resolveMcpConfig(useConfig()).oauth
}

function scopeList(scopes: unknown): string[] {
  if (Array.isArray(scopes)) return scopes.map(String)
  return String(scopes ?? '')
    .split(/\s+/)
    .filter(Boolean)
}

export async function listOAuthApps(userId: string): Promise<OAuthAppRecord[]> {
  if (!oauthAvailable()) return []
  const ctx = await useAuthContext()
  const consents = (await ctx.adapter.findMany({ model: 'oauthConsent', where: [{ field: 'userId', value: userId }] })) as Record<string, unknown>[]
  return Promise.all(
    consents.map(async (consent) => {
      const clientId = String(consent.clientId)
      const client = (await ctx.adapter.findOne({ model: 'oauthClient', where: [{ field: 'clientId', value: clientId }] })) as Record<
        string,
        unknown
      > | null
      return {
        clientId,
        name: typeof client?.name === 'string' ? client.name : null,
        uri: typeof client?.uri === 'string' ? client.uri : null,
        scopes: scopeList(consent.scopes),
        createdAt: new Date((consent.createdAt as string | undefined) ?? Date.now()),
      }
    }),
  )
}

function byUserAndClient(userId: string, clientId: string) {
  return [
    { field: 'userId', value: userId },
    { field: 'clientId', value: clientId },
  ]
}

export async function hasOAuthConsent(userId: string, clientId: string): Promise<boolean> {
  if (!oauthAvailable()) return false
  const ctx = await useAuthContext()
  return !!(await ctx.adapter.findOne({ model: 'oauthConsent', where: byUserAndClient(userId, clientId) }))
}

/** Deletes the consent and the tokens of one client; false when the user never authorised it. */
export async function revokeOAuthApp(userId: string, clientId: string): Promise<boolean> {
  if (!(await hasOAuthConsent(userId, clientId))) return false
  const ctx = await useAuthContext()
  const where = byUserAndClient(userId, clientId)
  await ctx.adapter.deleteMany({ model: 'oauthRefreshToken', where })
  await ctx.adapter.deleteMany({ model: 'oauthAccessToken', where })
  await ctx.adapter.deleteMany({ model: 'oauthConsent', where })
  return true
}
