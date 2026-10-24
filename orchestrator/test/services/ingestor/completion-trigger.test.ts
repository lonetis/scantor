import type { Collection, Document } from 'mongodb'
import { describe, expect, it } from 'vitest'
import { BatchProcessor, COMPLETION_TRIGGER_INTERVAL_MS, type FlushResult, type IngestorHooks } from '../../../server/services/ingestor/processor'
import type { CachedScan, ScanStateCache } from '../../../server/services/ingestor/scan-cache'
import type { ScanDoc } from '../../../server/types/documents'
import { useLogger } from '../../../server/utils/logger'

// The ingestor's completion trigger after a flush (docs/queue.md §6.8–§6.9): it reads the hint counters its own
// increment returned, and it throttles per scan and round.

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
  it('counts the results of earlier flushes that the cached scan does not show yet', async () => {
    const doc = storedScan({ stats: { succeeded: 2, failed: 0, retrying: 0, lost: 0, cancelled: 0 } })
    const { batch, triggers } = processor(scansCollection(doc))
    // The cache was filled before the increments of the two earlier flushes reached the change stream.
    await batch.finish(flush(cached(doc, { succeeded: 0 }), { succeeded: 1 }, 1_000_000))
    expect(doc.stats.succeeded).toBe(3)
    expect(triggers).toEqual([SCAN])
  })

  it('does not trigger while the hints are short of the confirmed analyses, or for a scan that is not running', async () => {
    const doc = storedScan()
    const { batch, triggers } = processor(scansCollection(doc))
    await batch.finish(flush(cached(doc), { succeeded: 2 }, 1_000_000))
    expect(triggers).toEqual([])
    doc.state = 'paused'
    await batch.finish(flush(cached(doc), { failed: 1 }, 1_001_000))
    expect(doc.stats.failed).toBe(1)
    expect(triggers).toEqual([])
  })

  it('throttles a round to one trigger per interval, but never holds back the first trigger of a retry round', async () => {
    const doc = storedScan()
    const { batch, triggers } = processor(scansCollection(doc))
    // The cache is up to date here, so only the throttle decides.
    const fresh = () => cached(doc, { ...doc.stats })
    const start = 1_000_000
    await batch.finish(flush(fresh(), { failed: 3 }, start))
    expect(triggers).toHaveLength(1)
    // The same round within the interval: no second recount.
    await batch.finish(flush(fresh(), { succeeded: 1 }, start + 1_000))
    expect(triggers).toHaveLength(1)

    // retry-failed reset the failures and published them in round 2; their results arrive 3 s after the last trigger.
    Object.assign(doc, { round: 2, stats: { succeeded: 1, failed: 0, retrying: 0, lost: 0, cancelled: 0 } })
    doc.scheduling.confirmed = 4
    await batch.finish(flush(fresh(), { failed: 3 }, start + 3_000))
    expect(triggers).toHaveLength(2)
    await batch.finish(flush(fresh(), { failed: 1 }, start + 3_000 + COMPLETION_TRIGGER_INTERVAL_MS - 1))
    expect(triggers).toHaveLength(2)
    await batch.finish(flush(fresh(), { failed: 1 }, start + 3_000 + COMPLETION_TRIGGER_INTERVAL_MS))
    expect(triggers).toHaveLength(3)
  })

  it('falls back to the cached scan and the flush’s own results when the hint update fails', async () => {
    const doc = storedScan()
    const { batch, triggers } = processor(scansCollection(doc, { failing: true }))
    await batch.finish(flush(cached(doc, { succeeded: 1 }), { succeeded: 1 }, 1_000_000))
    expect(triggers).toEqual([])
    await batch.finish(flush(cached(doc, { succeeded: 2 }), { failed: 1 }, 1_001_000))
    expect(triggers).toEqual([SCAN])
  })
})
