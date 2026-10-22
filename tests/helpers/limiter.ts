import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { env } from './env'

// Cross-worker sliding-window limiter for the rate-limited better-auth endpoints (docs/testing.md §7.8, §9).
// better-auth allows 10 sign-ins and 10 dynamic registrations per minute per client IP (docs/auth.md §2.7) and the
// whole suite reaches Traefik from one IP, so every Playwright worker (a separate process) reserves a slot in a
// timestamp log per path under .auth/limiter/, guarded by an exclusive lock file. The budgets stay below the
// server limits, leaving room for window-boundary effects and the runner's own remote-node sign-in.

export const LIMITED_PATHS = {
  '/sign-in/email': 8,
  '/oauth2/register': 8,
  '/passkey/verify-authentication': 16,
} as const satisfies Record<string, number>

export type LimitedPath = keyof typeof LIMITED_PATHS

const WINDOW_MS = 60_000
/** A lock older than this belongs to a crashed worker. */
const STALE_LOCK_MS = 10_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function files(path: LimitedPath): { log: string; lock: string } {
  const name = path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
  return { log: join(env.paths.limiter, `${name}.json`), lock: join(env.paths.limiter, `${name}.lock`) }
}

async function withLock<T>(lock: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const handle = await open(lock, 'wx')
      await handle.close()
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const info = await stat(lock).catch(() => null)
      if (info && Date.now() - info.mtimeMs > STALE_LOCK_MS) await rm(lock, { force: true })
      if (Date.now() > deadline) throw new Error(`limiter lock ${lock} is held for more than 30 s`, { cause: error })
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
    if (!Array.isArray(parsed) || !parsed.every((t) => typeof t === 'number')) throw new Error(`limiter log ${log} is corrupt`)
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Blocks until a request to `path` fits the suite's budget, then records it. Call right before the request. */
export async function reserve(path: LimitedPath): Promise<void> {
  const limit = LIMITED_PATHS[path]
  const { log, lock } = files(path)
  await mkdir(env.paths.limiter, { recursive: true })
  for (;;) {
    const waitMs = await withLock(lock, async () => {
      const now = Date.now()
      const recent = (await readLog(log)).filter((t) => t > now - WINDOW_MS)
      if (recent.length < limit) {
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

/** Removes stale lock files (global setup). The timestamp logs stay, so back-to-back runs share the budget. */
export async function resetLocks(): Promise<void> {
  await mkdir(env.paths.limiter, { recursive: true })
  for (const path of Object.keys(LIMITED_PATHS) as LimitedPath[]) await rm(files(path).lock, { force: true })
}
