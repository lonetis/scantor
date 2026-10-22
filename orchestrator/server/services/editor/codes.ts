import { randomBytes } from 'node:crypto'

/*
 * One-time codes of the editor handoff (docs/editor.md §8.3, docs/auth.md §12): `sec_` + base64url(32 random
 * bytes), bound to {userId, open}, valid 60 s, single use. They live in memory in the `api` component: the editor
 * listener of the same process redeems them. A minute timer sweeps expired entries.
 */

export const EDITOR_CODE_PREFIX = 'sec_'
export const EDITOR_CODE_TTL_MS = 60_000
export const EDITOR_CODE_PATTERN = /^sec_[A-Za-z0-9_-]{43}$/

export interface EditorCodeEntry {
  userId: string
  /** the task folder to open, or null for the workspace root */
  open: string | null
  expiresAt: number
}

export class EditorCodeStore {
  private readonly codes = new Map<string, EditorCodeEntry>()

  issue(userId: string, open: string | null, now = Date.now()): { code: string; expiresAt: Date } {
    const code = `${EDITOR_CODE_PREFIX}${randomBytes(32).toString('base64url')}`
    const expiresAt = now + EDITOR_CODE_TTL_MS
    this.codes.set(code, { userId, open, expiresAt })
    return { code, expiresAt: new Date(expiresAt) }
  }

  /** Redeems a code: it is deleted on first use whatever the outcome; null when unknown, malformed or expired. */
  consume(code: string, now = Date.now()): EditorCodeEntry | null {
    if (!EDITOR_CODE_PATTERN.test(code)) return null
    const entry = this.codes.get(code)
    if (!entry) return null
    this.codes.delete(code)
    return entry.expiresAt > now ? entry : null
  }

  /** Drops every pending code of a user (ban, deletion, editor stop). */
  revokeUser(userId: string): void {
    for (const [code, entry] of this.codes) if (entry.userId === userId) this.codes.delete(code)
  }

  /** Removes expired codes; returns how many were removed. */
  sweep(now = Date.now()): number {
    let removed = 0
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt > now) continue
      this.codes.delete(code)
      removed++
    }
    return removed
  }

  get size(): number {
    return this.codes.size
  }
}

/**
 * Failed `/_auth` redemptions per client IP (docs/editor.md §8.2): more than `limit` failures within `windowMs`
 * block the IP (429) until old failures leave the window.
 */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>()

  constructor(
    readonly limit = 30,
    readonly windowMs = 60_000,
  ) {}

  private recent(key: string, now: number): number[] {
    const kept = (this.failures.get(key) ?? []).filter((at) => at > now - this.windowMs)
    if (kept.length > 0) this.failures.set(key, kept)
    else this.failures.delete(key)
    return kept
  }

  isBlocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.limit
  }

  recordFailure(key: string, now = Date.now()): void {
    const kept = this.recent(key, now)
    kept.push(now)
    // Only the newest `limit` timestamps matter for the decision.
    this.failures.set(key, kept.slice(-this.limit))
  }

  sweep(now = Date.now()): void {
    for (const key of [...this.failures.keys()]) this.recent(key, now)
  }
}
