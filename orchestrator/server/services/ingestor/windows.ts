/*
 * In-memory windows of the ingestor (docs/queue.md §6.8, §6.10). Both restart empty with the process.
 *
 *  - RateWindow: per scan, five one-minute buckets of applied terminal operations (succeeded + failed); the rate is
 *    their sum divided by the number of minutes covered (1–5). It feeds `stats.ratePerMin` (ETA in the API).
 *  - BreakerWindow: per scan, a sliding window of SCANTOR_BREAKER_WINDOW in 10-second buckets of applied attempt
 *    outcomes: successes are applied succeeded results, failures are applied failed results (any type) plus applied
 *    attempt events. Duplicates never count.
 */

const MINUTE_MS = 60_000
const RATE_MINUTES = 5
export const BREAKER_BUCKET_MS = 10_000

interface RateState {
  /** first minute (epoch minute) with data in this process */
  since: number
  buckets: Map<number, number>
}

export class RateWindow {
  private readonly scans = new Map<string, RateState>()

  record(scanId: string, completed: number, now: number): void {
    if (completed <= 0) return
    const minute = Math.floor(now / MINUTE_MS)
    let state = this.scans.get(scanId)
    if (!state) {
      state = { since: minute, buckets: new Map() }
      this.scans.set(scanId, state)
    }
    state.buckets.set(minute, (state.buckets.get(minute) ?? 0) + completed)
    this.prune(state, minute)
  }

  private prune(state: RateState, minute: number): void {
    for (const key of state.buckets.keys()) if (key <= minute - RATE_MINUTES) state.buckets.delete(key)
  }

  /** Completions per minute over the covered part of the last five minutes; 0 without data. */
  ratePerMin(scanId: string, now: number): number {
    const state = this.scans.get(scanId)
    if (!state) return 0
    const minute = Math.floor(now / MINUTE_MS)
    this.prune(state, minute)
    let sum = 0
    for (const count of state.buckets.values()) sum += count
    const covered = Math.min(RATE_MINUTES, Math.max(1, minute - state.since + 1))
    return Math.round((sum / covered) * 10) / 10
  }

  forget(scanId: string): void {
    this.scans.delete(scanId)
  }

  /** Drops scans without completions in the last five minutes (bounds memory over the process lifetime). */
  sweep(now: number): void {
    const minute = Math.floor(now / MINUTE_MS)
    for (const [scanId, state] of this.scans) {
      this.prune(state, minute)
      if (state.buckets.size === 0) this.scans.delete(scanId)
    }
  }
}

interface BreakerBucket {
  successes: number
  failures: number
}

interface BreakerState {
  /** the scan's `pausedAt` when the window started; a different value means it left `running` meanwhile */
  marker: number | null
  buckets: Map<number, BreakerBucket>
}

export interface BreakerSnapshot {
  attempts: number
  failures: number
  ratio: number
}

export class BreakerWindow {
  private readonly scans = new Map<string, BreakerState>()

  constructor(private readonly windowMs: number) {}

  /**
   * Adds applied outcomes. `marker` is the scan's last pause time: when it differs from the one the window started
   * with, the scan was paused (and resumed) since, so the window starts over (docs/queue.md §6.10).
   */
  record(scanId: string, successes: number, failures: number, now: number, marker: number | null = null): void {
    let state = this.scans.get(scanId)
    if (state && state.marker !== marker) {
      this.scans.delete(scanId)
      state = undefined
    }
    if (successes <= 0 && failures <= 0) return
    if (!state) {
      state = { marker, buckets: new Map() }
      this.scans.set(scanId, state)
    }
    const bucketKey = Math.floor(now / BREAKER_BUCKET_MS)
    const bucket = state.buckets.get(bucketKey) ?? { successes: 0, failures: 0 }
    bucket.successes += Math.max(0, successes)
    bucket.failures += Math.max(0, failures)
    state.buckets.set(bucketKey, bucket)
  }

  snapshot(scanId: string, now: number): BreakerSnapshot {
    const state = this.scans.get(scanId)
    if (!state) return { attempts: 0, failures: 0, ratio: 0 }
    const oldest = Math.floor((now - this.windowMs) / BREAKER_BUCKET_MS)
    let successes = 0
    let failures = 0
    for (const [key, bucket] of state.buckets) {
      if (key <= oldest) {
        state.buckets.delete(key)
        continue
      }
      successes += bucket.successes
      failures += bucket.failures
    }
    const attempts = successes + failures
    return { attempts, failures, ratio: attempts === 0 ? 0 : failures / attempts }
  }

  /** True when the breaker trips (SCANTOR_BREAKER_MIN_ATTEMPTS = 0 disables it). */
  trips(scanId: string, now: number, minAttempts: number, ratio: number): BreakerSnapshot | null {
    if (minAttempts <= 0) return null
    const snapshot = this.snapshot(scanId, now)
    return snapshot.attempts >= minAttempts && snapshot.ratio >= ratio ? snapshot : null
  }

  clear(scanId: string): void {
    this.scans.delete(scanId)
  }

  /** Drops scans whose window holds no recent bucket. */
  sweep(now: number): void {
    for (const scanId of this.scanIds()) if (this.snapshot(scanId, now).attempts === 0) this.scans.delete(scanId)
  }

  /** Scans with a window (to clear those that left `running`). */
  scanIds(): string[] {
    return [...this.scans.keys()]
  }
}
