import type { Collection } from 'mongodb'
import type { LockDoc, LockName } from '../types/documents'
import { instanceId } from './instance'
import type { Logger } from './logger'

// Lease locks in the `locks` collection (docs/data-model.md §4.13): they make singleton loops safe if a second
// orchestrator ever runs. A lease lasts 30 s and is renewed every 10 s; acquiring a held, unexpired lock fails.

export const LOCK_LEASE_MS = 30_000
export const LOCK_RENEW_MS = 10_000

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000
}

/** Acquires or renews `name` for `owner`. Returns false when another owner holds an unexpired lease. */
export async function tryAcquireLock(
  locks: Collection<LockDoc>,
  name: LockName,
  owner: string = instanceId,
  leaseMs = LOCK_LEASE_MS,
): Promise<boolean> {
  const now = new Date()
  try {
    await locks.findOneAndUpdate(
      { _id: name, $or: [{ expiresAt: { $lt: now } }, { owner }] },
      { $set: { owner, expiresAt: new Date(now.getTime() + leaseMs) }, $setOnInsert: { acquiredAt: now } },
      { upsert: true },
    )
    return true
  } catch (error) {
    if (isDuplicateKey(error)) return false
    throw error
  }
}

export async function releaseLock(locks: Collection<LockDoc>, name: LockName, owner: string = instanceId): Promise<void> {
  await locks.deleteOne({ _id: name, owner })
}

export interface WithLockOptions {
  /** How long to wait for the lock before failing (default: 5 minutes). */
  waitMs?: number
  /** Poll interval while waiting (default: 1 s). */
  pollMs?: number
  logger?: Logger
}

/**
 * Runs `fn` while holding `name`, renewing the lease in the background. Waits for the lock when another
 * instance holds it and throws when it cannot be acquired in time.
 */
export async function withLock<T>(
  locks: Collection<LockDoc>,
  name: LockName,
  fn: () => Promise<T>,
  options: WithLockOptions = {},
): Promise<T> {
  const deadline = Date.now() + (options.waitMs ?? 5 * 60_000)
  while (!(await tryAcquireLock(locks, name))) {
    if (Date.now() > deadline) throw new Error(`lock ${name} is held by another orchestrator`)
    options.logger?.info(`waiting for lock ${name}`)
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1000))
  }
  const renew = setInterval(() => {
    tryAcquireLock(locks, name).then(
      (held) => {
        if (!held) options.logger?.error(`lost lock ${name} while holding it`)
      },
      (error: unknown) => options.logger?.warn(`renewing lock ${name} failed`, { err: error }),
    )
  }, LOCK_RENEW_MS)
  try {
    return await fn()
  } finally {
    clearInterval(renew)
    await releaseLock(locks, name)
  }
}

export interface LeaseLockOptions {
  logger?: Logger
  /** called when this instance acquires the lock */
  onAcquired?: () => void
  /** called when this instance loses a lock it held (renewal failed or another owner took it) */
  onLost?: () => void
}

/**
 * A long-lived lease for singleton loops (reconciler, gc): `start()` keeps trying to acquire and then renew the
 * lock every LOCK_RENEW_MS; `held` tells the loop whether it may act. `stop()` releases it.
 */
export class LeaseLock {
  private timer: NodeJS.Timeout | null = null
  private heldFlag = false

  constructor(
    private readonly locks: Collection<LockDoc>,
    readonly name: LockName,
    private readonly options: LeaseLockOptions = {},
  ) {}

  get held(): boolean {
    return this.heldFlag
  }

  start(): void {
    if (this.timer) return
    const tick = async () => {
      try {
        const held = await tryAcquireLock(this.locks, this.name)
        if (held && !this.heldFlag) this.options.onAcquired?.()
        if (!held && this.heldFlag) this.options.onLost?.()
        this.heldFlag = held
      } catch (error) {
        if (this.heldFlag) this.options.onLost?.()
        this.heldFlag = false
        this.options.logger?.warn(`lock ${this.name} renewal failed`, { err: error })
      }
    }
    void tick()
    this.timer = setInterval(() => void tick(), LOCK_RENEW_MS)
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.heldFlag) {
      this.heldFlag = false
      await releaseLock(this.locks, this.name)
    }
  }
}
