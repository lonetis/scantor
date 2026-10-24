import { describe, expect, it } from 'vitest'
import { OFFLINE_GRACE_MIN_MS, OfflineDetector } from '../../../server/services/nodes/offline'
import { recordingLogger } from './helpers'

// When node silence counts (docs/nodes.md §7.4): the detection runs only once the detector has watched for its grace,
// max(SCANTOR_NODE_OFFLINE_AFTER, the time a live node needs to reach a restarted orchestrator). The watch starts when the reconciler
// lock is acquired and starts again after the lock was lost, after a late tick (the process did not run) and after a
// detection pass that failed or was still waiting for MongoDB at the next tick. So an orchestrator restart, a failover
// or an outage gives every node a full window and one retry to report again.

const TICK = 10_000

interface Harness {
  detector: OfflineDetector
  /** times (ms since the start) at which a detection pass ran */
  passes: number[]
  /** advances the clock to `t` without ticking */
  at(t: number): void
  /** advances the clock to `t` and ticks */
  tickAt(t: number): void
  /** ticks every TICK after `from` up to `to` (inclusive) */
  ticks(from: number, to: number): void
  /** makes the next passes hang until the returned function is called */
  hang(): () => void
  /** makes the next pass fail */
  failNext(): void
  settle(): Promise<void>
}

function harness(offlineAfterMs: number): Harness {
  let now = 0
  const passes: number[] = []
  let pending: Promise<void> | null = null
  let failing = false
  const detector = new OfflineDetector({
    offlineAfterMs,
    tickMs: TICK,
    log: recordingLogger(),
    now: () => now,
    detect: async () => {
      passes.push(now)
      if (failing) {
        failing = false
        throw new Error('no primary')
      }
      await pending
    },
  })
  const h: Harness = {
    detector,
    passes,
    at(t) {
      now = t
    },
    tickAt(t) {
      now = t
      detector.tick()
    },
    ticks(from, to) {
      for (let t = from + TICK; t <= to; t += TICK) h.tickAt(t)
    },
    hang() {
      let release!: () => void
      pending = new Promise((resolve) => (release = resolve))
      return () => {
        pending = null
        release()
      }
    },
    failNext() {
      failing = true
    },
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
  }
  return h
}

describe('OfflineDetector', () => {
  it('waits for SCANTOR_NODE_OFFLINE_AFTER after the lock was acquired when that window is the longer one', async () => {
    const h = harness(90_000)
    expect(h.detector.graceMs).toBe(90_000)
    h.detector.acquired()
    h.ticks(0, 80_000)
    expect(h.passes).toEqual([])
    for (const t of [90_000, 100_000, 110_000]) {
      h.tickAt(t)
      await h.settle()
    }
    expect(h.passes).toEqual([90_000, 100_000, 110_000])
  })

  it('waits until a live node can have reached the orchestrator again when the window is shorter than that', async () => {
    const h = harness(20_000)
    expect(h.detector.graceMs).toBe(OFFLINE_GRACE_MIN_MS)
    // The daemon's longest retry delay (30 s + 20 % jitter) plus one Traefik health check interval (10 s).
    expect(OFFLINE_GRACE_MIN_MS).toBeGreaterThan(30_000 * 1.2 + 10_000)
    h.detector.acquired()
    h.ticks(0, 50_000)
    expect(h.passes).toEqual([])
    h.tickAt(60_000)
    await h.settle()
    expect(h.passes).toEqual([60_000])
  })

  it('starts the grace again after the lock was lost and acquired again', async () => {
    const h = harness(60_000)
    h.detector.acquired()
    h.ticks(0, 60_000)
    expect(h.passes).toEqual([60_000])
    await h.settle()
    // A MongoDB outage: the lock renewal fails (onLost), and the loop does not tick until the lock is acquired again.
    h.detector.lost()
    h.at(100_000)
    h.detector.acquired()
    h.ticks(100_000, 150_000)
    await h.settle()
    expect(h.passes).toEqual([60_000])
    h.tickAt(160_000)
    await h.settle()
    expect(h.passes).toEqual([60_000, 160_000])
  })

  it('starts the grace again when a tick comes late, because the process did not run meanwhile', async () => {
    const h = harness(60_000)
    h.detector.acquired()
    for (const t of [10_000, 20_000, 30_000, 40_000, 50_000, 60_000]) h.tickAt(t)
    await h.settle()
    expect(h.passes).toEqual([60_000])
    // `docker pause` for 25 s: the next tick runs 35 s after the previous one, and no status could arrive meanwhile.
    h.tickAt(95_000)
    h.ticks(95_000, 145_000)
    await h.settle()
    expect(h.passes).toEqual([60_000])
    h.tickAt(155_000)
    await h.settle()
    expect(h.passes).toEqual([60_000, 155_000])
  })

  it('tolerates a tick that is merely a little late', async () => {
    const h = harness(60_000)
    h.detector.acquired()
    h.ticks(0, 60_000)
    await h.settle()
    h.tickAt(78_000)
    await h.settle()
    expect(h.passes).toEqual([60_000, 78_000])
  })

  it('starts the grace again when a pass is still waiting for MongoDB at the next tick', async () => {
    const h = harness(60_000)
    h.detector.acquired()
    const release = h.hang()
    h.ticks(0, 60_000)
    expect(h.passes).toEqual([60_000])
    // MongoDB is paused: the pass hangs over the next ticks, and the statuses of the nodes wait as well.
    h.ticks(60_000, 90_000)
    release()
    await h.settle()
    // The watch starts again at the first tick after the pass ended.
    h.ticks(90_000, 150_000)
    await h.settle()
    expect(h.passes).toEqual([60_000])
    h.tickAt(160_000)
    await h.settle()
    expect(h.passes).toEqual([60_000, 160_000])
  })

  it('starts the grace again after a failed pass', async () => {
    const h = harness(60_000)
    h.detector.acquired()
    h.failNext()
    h.ticks(0, 60_000)
    await h.settle()
    expect(h.passes).toEqual([60_000])
    h.ticks(60_000, 120_000)
    await h.settle()
    expect(h.passes).toEqual([60_000])
    h.tickAt(130_000)
    await h.settle()
    expect(h.passes).toEqual([60_000, 130_000])
  })

  it('starts watching at the first tick when the lock was held before the detector knew', async () => {
    const h = harness(60_000)
    h.tickAt(5_000)
    h.ticks(5_000, 55_000)
    await h.settle()
    expect(h.passes).toEqual([])
    h.tickAt(65_000)
    await h.settle()
    expect(h.passes).toEqual([65_000])
  })

  it('runs no pass once stopped and waits for the pass in flight', async () => {
    const h = harness(60_000)
    h.detector.acquired()
    const release = h.hang()
    h.ticks(0, 60_000)
    let stopped = false
    const stopping = h.detector.stop().then(() => (stopped = true))
    await h.settle()
    expect(stopped).toBe(false)
    release()
    await stopping
    h.ticks(60_000, 200_000)
    await h.settle()
    expect(h.passes).toEqual([60_000])
  })
})
