import type { Collection, Document } from 'mongodb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchProcessor, COMPLETION_TRIGGER_INTERVAL_MS, type FlushResult, type IngestorHooks } from '../../../server/services/ingestor/processor'
import type { CachedScan, ScanStateCache } from '../../../server/services/ingestor/scan-cache'
import type { ScanDoc } from '../../../server/types/documents'
import { useLogger } from '../../../server/utils/logger'

// The ingestor's completion trigger after a flush (docs/queue.md §6.8–§6.9): it reads the hint counters its own
// increment returned, and it throttles per scan and round, running a held-back check when the interval ends.

const SCAN = '0b6c2f4e-7d1a-4e8b-9c3f-5a2d1e0f9b8c'

interface StoredScan {
  _id: string
  state: string
  round: number
  scheduling: { state: string; confirmed: number }
  stats: { succeeded: number; failed: number; retrying: number; lost: number; cancelled: number }
}

function storedScan(overrides: Partial<StoredScan> = {}): StoredScan {
  return {
    _id: SCAN,
    state: 'running',
    round: 1,
    scheduling: { state: 'done', confirmed: 3 },
    stats: { succeeded: 0, failed: 0, retrying: 0, lost: 0, cancelled: 0 },
    ...overrides,
  }
}

/** The scans collection with the one operation `finish` uses, on a single in-memory document. */
function scansCollection(doc: StoredScan, options: { failing?: boolean } = {}): Collection<ScanDoc> {
  return {
    async findOneAndUpdate(filter: { _id: string }, update: { $inc: Record<string, number> }) {
      if (options.failing) throw new Error('MongoDB is unavailable')
      if (filter._id !== doc._id) return null
      for (const [path, by] of Object.entries(update.$inc)) {
        const key = path.replace('stats.', '') as keyof StoredScan['stats']
        doc.stats[key] += by
      }
      return structuredClone(doc)
    },
  } as unknown as Collection<ScanDoc>
}

/** The scan as the flush loaded it from the cache (its counters can lag behind the document). */
function cached(doc: StoredScan, stats: Partial<CachedScan['stats']> = {}): CachedScan {
  return {
    id: doc._id,
    exists: true,
    state: doc.state as CachedScan['state'],
    round: doc.round,
    userId: 'u',
    schedulingState: doc.scheduling.state as CachedScan['schedulingState'],
    confirmed: doc.scheduling.confirmed,
    pausedAt: null,
    stats: { succeeded: 0, failed: 0, lost: 0, cancelled: 0, ...stats },
    fetchedAt: 0,
  }
}

function processor(scans: Collection<ScanDoc>) {
  const triggers: string[] = []
  const hooks: IngestorHooks = {
    async pauseScanBySystem() {},
    async tryCompleteScan(scanId) {
      triggers.push(scanId)
      return false
    },
  }
  const cache = { get: () => undefined, invalidate: () => undefined } as unknown as ScanStateCache
  const batch = new BatchProcessor({
    analyses: {} as Collection<Document>,
    scans,
    cache,
    config: { maxResultBytes: 1024, breakerMinAttempts: 1000, breakerRatio: 0.9, breakerWindowMs: 60_000 },
    hooks,
    log: useLogger('test'),
  })
  return { batch, triggers }
}

function flush(scan: CachedScan, tally: { succeeded?: number; failed?: number }, atMs: number): FlushResult {
  return {
    outcomes: [],
    tallies: new Map([[scan.id, { succeeded: tally.succeeded ?? 0, failed: tally.failed ?? 0, retrying: 0 }]]),
    scans: new Map([[scan.id, scan]]),
    now: new Date(atMs),
  }
}

describe('the completion trigger of a flush', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-24T10:00:00.000Z') }))
  afterEach(() => vi.useRealTimers())

  it('counts the results of earlier flushes that the cached scan does not show yet', async () => {
    const doc = storedScan({ stats: { succeeded: 2, failed: 0, retrying: 0, lost: 0, cancelled: 0 } })
    const { batch, triggers } = processor(scansCollection(doc))
    // The cache was filled before the increments of the two earlier flushes reached the change stream.
    await batch.finish(flush(cached(doc, { succeeded: 0 }), { succeeded: 1 }, Date.now()))
    expect(doc.stats.succeeded).toBe(3)
    expect(triggers).toEqual([SCAN])
  })

  it('does not trigger while the hints are short of the confirmed analyses, or for a scan that is not running', async () => {
    const doc = storedScan()
    const { batch, triggers } = processor(scansCollection(doc))
    await batch.finish(flush(cached(doc), { succeeded: 2 }, Date.now()))
    expect(triggers).toEqual([])
    doc.state = 'paused'
    await batch.finish(flush(cached(doc), { failed: 1 }, Date.now() + 1_000))
    expect(doc.stats.failed).toBe(1)
    expect(triggers).toEqual([])
  })

  it('throttles a round to one check per interval and runs a held-back check once when the interval ends', async () => {
    const doc = storedScan()
    const { batch, triggers } = processor(scansCollection(doc))
    // The cache is up to date here, so only the throttle decides.
    const fresh = () => cached(doc, { ...doc.stats })
    await batch.finish(flush(fresh(), { failed: 3 }, Date.now()))
    expect(triggers).toHaveLength(1)
    // Two more flushes of the same round within the interval: no recount now, one when the interval ends.
    vi.advanceTimersByTime(1_000)
    await batch.finish(flush(fresh(), { succeeded: 1 }, Date.now()))
    vi.advanceTimersByTime(1_000)
    await batch.finish(flush(fresh(), { succeeded: 1 }, Date.now()))
    expect(triggers).toHaveLength(1)
    vi.advanceTimersByTime(COMPLETION_TRIGGER_INTERVAL_MS - 2_001)
    expect(triggers).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(triggers).toHaveLength(2)
    // The held-back check counts as the round's last trigger: a flush 1 s later waits for the interval again.
    vi.advanceTimersByTime(1_000)
    await batch.finish(flush(fresh(), { succeeded: 1 }, Date.now()))
    expect(triggers).toHaveLength(2)
    vi.advanceTimersByTime(COMPLETION_TRIGGER_INTERVAL_MS - 1_000)
    expect(triggers).toHaveLength(3)
    vi.advanceTimersByTime(2 * COMPLETION_TRIGGER_INTERVAL_MS)
    expect(triggers).toHaveLength(3)
    batch.stop()
  })

  it('never holds back the first check of a retry round', async () => {
    const doc = storedScan()
    const { batch, triggers } = processor(scansCollection(doc))
    const fresh = () => cached(doc, { ...doc.stats })
    await batch.finish(flush(fresh(), { failed: 3 }, Date.now()))
    expect(triggers).toHaveLength(1)
    // retry-failed reset the failures and published them in round 2; their results arrive 3 s after the last trigger.
    vi.advanceTimersByTime(3_000)
    Object.assign(doc, { round: 2, stats: { succeeded: 0, failed: 0, retrying: 0, lost: 0, cancelled: 0 } })
    await batch.finish(flush(fresh(), { failed: 3 }, Date.now()))
    expect(triggers).toHaveLength(2)
    batch.stop()
  })

  it('stop drops the checks still waiting for their interval', async () => {
    const doc = storedScan()
    const { batch, triggers } = processor(scansCollection(doc))
    await batch.finish(flush(cached(doc, { ...doc.stats }), { failed: 3 }, Date.now()))
    vi.advanceTimersByTime(1_000)
    await batch.finish(flush(cached(doc, { ...doc.stats }), { failed: 1 }, Date.now()))
    batch.stop()
    vi.advanceTimersByTime(2 * COMPLETION_TRIGGER_INTERVAL_MS)
    expect(triggers).toHaveLength(1)
  })

  it('falls back to the cached scan and the flush’s own results when the hint update fails', async () => {
    const doc = storedScan()
    const { batch, triggers } = processor(scansCollection(doc, { failing: true }))
    await batch.finish(flush(cached(doc, { succeeded: 1 }), { succeeded: 1 }, Date.now()))
    expect(triggers).toEqual([])
    await batch.finish(flush(cached(doc, { succeeded: 2 }), { failed: 1 }, Date.now() + 1_000))
    expect(triggers).toEqual([SCAN])
  })
})
