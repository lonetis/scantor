import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { APIError } from 'better-auth/api'
import { useAuth, useAuthContext } from './auth'
import { useConfig } from './config'
import { apiError } from './errors'
import { type Logger, useLogger } from './logger'

// First admin (docs/auth.md §7): from SCANTOR_ADMIN_EMAIL / SCANTOR_ADMIN_PASSWORD, or through a per-boot setup token
// `sst_…` that is logged at boot and every 10 minutes while no user exists. The passkey-first admin uses a
// single-use `spk_…` token and is created only after a successful WebAuthn ceremony. Everything is in memory and
// serialised by one mutex.

export const SETUP_REMINDER_MS = 10 * 60_000
export const PASSKEY_SETUP_TTL_MS = 5 * 60_000

interface PasskeySetupEntry {
  email: string
  name: string
  handle: string
  expiresAt: number
}

const state: {
  tokenHash: Buffer | null
  reminder: NodeJS.Timeout | null
  passkeyTokens: Map<string, PasskeySetupEntry>
  mutex: Promise<unknown>
} = { tokenHash: null, reminder: null, passkeyTokens: new Map(), mutex: Promise.resolve() }

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/** Runs `fn` exclusively among setup operations. */
export function withSetupMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = state.mutex.then(fn, fn)
  state.mutex = run.catch(() => undefined)
  return run
}

export async function anyUserExists(): Promise<boolean> {
  const ctx = await useAuthContext()
  return (await ctx.internalAdapter.countTotalUsers()) > 0
}

function setupLink(token: string): string {
  return `${useConfig().publicUrl}/setup?token=${token}`
}

/** Discards the setup token and stops the reminder (after the first user exists). */
export function discardSetupToken(): void {
  state.tokenHash = null
  state.passkeyTokens.clear()
  if (state.reminder) clearInterval(state.reminder)
  state.reminder = null
}

/** True while a setup token is active (no user exists in this boot). */
export function setupTokenActive(): boolean {
  return state.tokenHash !== null
}

/**
 * Boot step 3: does nothing when a user exists; creates the first admin from the environment when both variables
 * are set; otherwise generates the setup token and logs the setup link.
 */
export async function ensureFirstAdmin(log: Logger = useLogger('setup')): Promise<void> {
  const config = useConfig()
  if (await anyUserExists()) {
    if (config.adminEmail) log.info('[setup] users exist; SCANTOR_ADMIN_EMAIL and SCANTOR_ADMIN_PASSWORD are ignored')
    discardSetupToken()
    return
  }
  if (config.adminEmail && config.adminPassword) {
    await withSetupMutex(async () => {
      if (await anyUserExists()) return
      await useAuth().api.createUser({
        body: { email: config.adminEmail, password: config.adminPassword, name: config.adminEmail!.split('@')[0], role: 'admin' },
      })
      log.info(`[setup] created first admin ${config.adminEmail}`)
    })
    return
  }
  const token = `sst_${randomBytes(32).toString('base64url')}`
  state.tokenHash = sha256(token)
  const message = `[setup] no users exist; open ${setupLink(token)} to create the first admin`
  log.warnUnredacted(message)
  state.reminder = setInterval(() => {
    anyUserExists().then(
      (exists) => {
        if (exists) discardSetupToken()
        else log.warnUnredacted(message)
      },
      (error: unknown) => log.warn('[setup] checking for users failed', { err: error }),
    )
  }, SETUP_REMINDER_MS)
  state.reminder.unref()
}

export type SetupTokenCheck = 'ok' | 'invalid' | 'completed'

/** Order of docs/auth.md §7.2: 409 when a user exists, then the constant-time token comparison. */
export async function checkSetupToken(header: string | undefined | null): Promise<SetupTokenCheck> {
  if (await anyUserExists()) return 'completed'
  if (!header || !state.tokenHash) return 'invalid'
  return timingSafeEqual(sha256(header), state.tokenHash) ? 'ok' : 'invalid'
}

/** Throws 409 setupCompleted when a user exists (re-check under the mutex). */
export async function assertNoUsers(): Promise<void> {
  if (await anyUserExists()) throw apiError('setupCompleted', 'setup is already completed')
}

// ── passkey-first admin (docs/auth.md §7.3) ─────────────────────────────────

export function createPasskeySetupToken(email: string, name: string, now = Date.now()): { token: string; expiresIn: number } {
  for (const [token, entry] of state.passkeyTokens) if (entry.expiresAt <= now) state.passkeyTokens.delete(token)
  const token = `spk_${randomBytes(32).toString('base64url')}`
  state.passkeyTokens.set(token, { email, name, handle: randomUUID(), expiresAt: now + PASSKEY_SETUP_TTL_MS })
  return { token, expiresIn: PASSKEY_SETUP_TTL_MS / 1000 }
}

function setupCompletedError(): APIError {
  return new APIError('CONFLICT', { code: 'setupCompleted', message: 'setup is already completed' })
}

function passkeyEntry(context: string | null | undefined): PasskeySetupEntry | null {
  if (!context) return null
  const entry = state.passkeyTokens.get(context)
  if (!entry || entry.expiresAt <= Date.now()) return null
  return entry
}

/**
 * better-auth passkey `registration.resolveUser`: runs at generate-register-options without a session. The `spk_`
 * token must exist and be unexpired (not consumed here) and no user may exist yet.
 */
export async function resolvePasskeySetupUser({ context }: { context?: string | null }) {
  const entry = passkeyEntry(context)
  if (!entry) throw new APIError('UNAUTHORIZED', { code: 'setupTokenInvalid', message: 'unknown or expired passkey setup token' })
  if (await anyUserExists()) throw setupCompletedError()
  return { id: entry.handle, name: entry.email, displayName: entry.name }
}

/**
 * better-auth passkey `registration.afterVerification`: after the attestation is verified, consumes the `spk_`
 * token, re-checks under the setup mutex that no user exists, creates the admin and discards the setup token. A
 * registration of a signed-in user (no context) is left untouched.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function completePasskeySetupUser({ ctx, context }: { ctx: any; context?: string | null }) {
  if (!context) return
  const entry = passkeyEntry(context)
  state.passkeyTokens.delete(context)
  if (!entry) throw new APIError('UNAUTHORIZED', { code: 'setupTokenInvalid', message: 'unknown or expired passkey setup token' })
  return withSetupMutex(async () => {
    if (await anyUserExists()) throw setupCompletedError()
    const user = await ctx.context.internalAdapter.createUser(
      {
        email: entry.email,
        name: entry.name,
        emailVerified: false,
        role: 'admin',
        canRunPrivileged: false,
        maxWorkers: useConfig().userMaxWorkers,
      },
      { method: 'passkey' },
    )
    discardSetupToken()
    useLogger('setup').info(`[setup] created first admin ${entry.email} with a passkey`)
    return { userId: user.id as string }
  })
}
