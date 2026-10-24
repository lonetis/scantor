import { describe, expect, it } from 'vitest'
import { INFLIGHT_POLL_MS, settleEarlierRounds, type SettleOptions } from '../../../server/services/scans/retry-failed'

// A retry of a cancelled scan lets the cancelled round settle before it materializes and resets (docs/queue.md §8
// "retry-failed publisher" step 1): no analysis of an earlier round in flight for the ingestor's settle delay, and at
// least that delay after the cancel. Time is simulated: `sleep` advances the clock.

const SETTLE_MS = 12_000

/** Runs settleEarlierRounds on a fake clock; `inflight(t)` gives the rounds in flight at time t. Returns when it ended. */
async function settle(options: { cancelledAt: number; start: number; inflight: (at: number) => number[]; round?: number; signal?: AbortSignal }) {
  let clock = options.start
  const sleeps: number[] = []
  const settings: SettleOptions = {
    round: options.round ?? 2,
    cancelledAt: options.cancelledAt,
    settleMs: SETTLE_MS,
    signal: options.signal ?? new AbortController().signal,
    inflightRounds: () => options.inflight(clock),
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
  }
  await settleEarlierRounds(settings)
  return { endedAt: clock, sleeps }
}

describe('settleEarlierRounds', () => {
  it('returns at once when the cancel is older than the settle delay and nothing runs', async () => {
    const { endedAt, sleeps } = await settle({ cancelledAt: 0, start: 60_000, inflight: () => [] })
    expect(endedAt).toBe(60_000)
    expect(sleeps).toEqual([])
  })

  it('waits until the settle delay after the cancel', async () => {
    const { endedAt, sleeps } = await settle({ cancelledAt: 1_000, start: 3_000, inflight: () => [] })
    expect(endedAt).toBe(1_000 + SETTLE_MS)
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(INFLIGHT_POLL_MS)
  })

  it('waits while a runner reports an analysis of the cancelled round, then the settle delay after the last report', async () => {
    // The runner that survived the cancel reports a round-1 analysis until t = 7 s (its result is confirmed then).
    const { endedAt } = await settle({ cancelledAt: 0, start: 2_000, inflight: (at) => (at < 7_000 ? [1] : []) })
    expect(endedAt).toBe(6_000 + SETTLE_MS)
  })

  it('ignores analyses of the retry round itself', async () => {
    const { endedAt } = await settle({ cancelledAt: 0, start: 2_000, inflight: () => [2, 2] })
    expect(endedAt).toBe(SETTLE_MS)
  })

  it('stops when the job is aborted', async () => {
    const abort = new AbortController()
    abort.abort(new Error('lease lost'))
    await expect(settle({ cancelledAt: 0, start: 0, inflight: () => [1], signal: abort.signal })).rejects.toThrow('lease lost')
  })
})
