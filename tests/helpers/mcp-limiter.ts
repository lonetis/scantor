import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { APIResponse } from '@playwright/test'
import { env } from './env'

// A budget for the OAuth provider's own per-IP rate limits, which SCANTOR_AUTH_RATE_LIMIT_SCALE does not raise:
// better-auth's oauth-provider allows 30 `/oauth2/authorize` and 20 `/oauth2/token` requests per minute and client
// IP, and the whole suite reaches Traefik from one IP (docs/auth.md §2.7). helpers/limiter.ts budgets only sign-ins,
// registrations and passkey authentications, so the mcp writer's specs reserve their authorize and token requests
// here (a sliding window per path under .auth/limiter/, shared by all workers of all runs through a lock file),
// below the server limits to leave room for other specs. A 429 that still happens is waited out and retried.

export const OAUTH_BUDGETS = {
  '/oauth2/authorize': 24,
  '/oauth2/token': 16,
} as const satisfies Record<string, number>

export type OAuthPath = keyof typeof OAUTH_BUDGETS

const WINDOW_MS = 60_000
/** A lock older than this belongs to a crashed worker. */
const STALE_LOCK_MS = 10_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function files(path: OAuthPath): { log: string; lock: string } {
  const name = `mcp-${path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`
  return { log: join(env.paths.limiter, `${name}.json`), lock: join(env.paths.limiter, `${name}.lock`) }
}

async function withLock<T>(lock: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      await (await open(lock, 'wx')).close()
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const info = await stat(lock).catch(() => null)
      if (info && Date.now() - info.mtimeMs > STALE_LOCK_MS) await rm(lock, { force: true })
      if (Date.now() > deadline) throw new Error(`OAuth limiter lock ${lock} is held for more than 30 s`, { cause: error })
      await sleep(20 + Math.random() * 30)
    }
  }
  try {
    return await fn()
  } finally {
    await rm(lock, { force: true })
  }
}

async function readLog(log: string): Promise<number[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(log, 'utf8'))
    if (!Array.isArray(parsed) || !parsed.every((t) => typeof t === 'number')) throw new Error(`OAuth limiter log ${log} is corrupt`)
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Blocks until a request to `path` fits the budget, then records it. Call right before the request. */
export async function reserveOAuth(path: OAuthPath): Promise<void> {
  const { log, lock } = files(path)
  await mkdir(env.paths.limiter, { recursive: true })
  for (;;) {
    const waitMs = await withLock(lock, async () => {
      const now = Date.now()
      const recent = (await readLog(log)).filter((t) => t > now - WINDOW_MS)
      if (recent.length < OAUTH_BUDGETS[path]) {
        recent.push(now)
        await writeFile(log, JSON.stringify(recent))
        return 0
      }
      return Math.min(...recent) + WINDOW_MS - now + 100
    })
    if (waitMs === 0) return
    await sleep(waitMs)
  }
}

/** How long to wait after a better-auth 429: its `X-Retry-After` seconds (1–61, default 10) plus a little jitter. */
export function retryAfterMs(header: string | null | undefined): number {
  const seconds = Number(header ?? '10')
  return (Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), 61) : 10) * 1000 + Math.random() * 1000
}

/**
 * Sends a request to a rate-limited OAuth endpoint within the budget; a 429 (from other specs' traffic) is waited out
 * with better-auth's `X-Retry-After` and retried for up to `timeoutMs`. better-auth counts per IP and resets a
 * counter only after a full window without allowed requests, so on a busy stack a 429 happens despite the budget.
 */
export async function oauthRequest(path: OAuthPath, send: () => Promise<APIResponse>, timeoutMs = 150_000): Promise<APIResponse> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await reserveOAuth(path)
    const response = await send()
    if (response.status() !== 429 || Date.now() >= deadline) return response
    await sleep(Math.min(retryAfterMs(response.headers()['x-retry-after']), Math.max(deadline - Date.now(), 0)))
  }
}
