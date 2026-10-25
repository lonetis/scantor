import type { Collection, Document } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { BatchProcessor, type FlushResult } from '../../../server/services/ingestor/processor'
import type { CachedScan, ScanStateCache } from '../../../server/services/ingestor/scan-cache'
import type { ScanDoc } from '../../../server/types/documents'
import type { Logger } from '../../../server/utils/logger'

// The rate of a scan (docs/queue.md §6.8): a flush writes it with the hint counters, and between flushes the
// processor writes the decaying rate of scans whose results stopped, down to 0, so the API's ETA does not keep the
// last value. At start the rates an earlier process stored are reset, because the window starts empty.

const SCAN = '0b6c2f4e-7d1a-4e8b-9c3f-5a2d1e0f9b8c'
const T0 = Date.parse('2026-10-24T10:00:00.000Z')
const MINUTE = 60_000

interface Write {
  op: 'findOneAndUpdate' | 'updateOne' | 'updateMany'
  filter: Record<string, unknown>
  set: Record<string, unknown>
}

function scansCollection(options: { failing?: boolean } = {}) {
  const writes: Write[] = []
  const record = (op: Write['op'], filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
    if (options.failing) throw new Error('MongoDB is unavailable')
    writes.push({ op, filter, set: update.$set })
  }
  const collection = {
    async findOneAndUpdate(filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) {
      record('findOneAndUpdate', filter, update)
      return { _id: SCAN, state: 'running', round: 1, scheduling: { state: 'running', confirmed: 0 }, stats: {} }
    },
    async updateOne(filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) {
      record('updateOne', filter, update)
      return { matchedCount: 1, modifiedCount: 1 }
    },
    async updateMany(filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) {
      record('updateMany', filter, update)
      return { matchedCount: 2, modifiedCount: 2 }
    },
  }
  return { scans: collection as unknown as Collection<ScanDoc>, writes }
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log } as unknown as Logger

function processor(scans: Collection<ScanDoc>) {
  return new BatchProcessor({
    analyses: {} as Collection<Document>,
    scans,
    cache: { get: () => undefined, invalidate: () => undefined } as unknown as ScanStateCache,
    config: { maxResultBytes: 1024, breakerMinAttempts: 1000, breakerRatio: 0.9, breakerWindowMs: 60_000 },
    hooks: {
      async pauseScanBySystem() {},
      async tryCompleteScan() {
        return false
      },
    },
    log,
  })
}

function flush(succeeded: number, atMs: number): FlushResult {
  const scan = {
    id: SCAN,
    exists: true,
    state: 'running',
    round: 1,
    userId: 'u',
    schedulingState: 'running',
    confirmed: 0,
    pausedAt: null,
    stats: { succeeded: 0, failed: 0, lost: 0, cancelled: 0 },
    fetchedAt: 0,
  }
  return {
    outcomes: [],
    tallies: new Map([[SCAN, { succeeded, failed: 0, retrying: 0 }]]),
    scans: new Map([[SCAN, scan as CachedScan]]),
    now: new Date(atMs),
  }
}

describe('the rate refresh of the ingestor', () => {
  it('writes the decaying rate of a scan whose results stopped, down to 0, and nothing once it is 0', async () => {
    const { scans, writes } = scansCollection()
    const batch = processor(scans)
    await batch.finish(flush(60, T0))
    expect(writes).toEqual([{ op: 'findOneAndUpdate', filter: { _id: SCAN }, set: expect.objectContaining({ 'stats.ratePerMin': 60 }) }])

    await batch.refreshRates(T0 + 30_000)
    expect(writes).toHaveLength(1)

    for (const at of [T0 + MINUTE, T0 + 5 * MINUTE, T0 + 6 * MINUTE, T0 + 7 * MINUTE]) await batch.refreshRates(at)
    // Only the rate changes: no updatedAt, which would make the reconciler recount a paused scan.
    expect(writes.slice(1)).toEqual([
      { op: 'updateOne', filter: { _id: SCAN }, set: { 'stats.ratePerMin': 30 } },
      { op: 'updateOne', filter: { _id: SCAN }, set: { 'stats.ratePerMin': 0 } },
    ])
  })

  it('resets the rates an earlier process stored when it starts, and keeps going when that fails', async () => {
    const { scans, writes } = scansCollection()
    const batch = processor(scans)
    await batch.start()
    batch.stop()
    expect(writes).toEqual([{ op: 'updateMany', filter: { 'stats.ratePerMin': { $gt: 0 } }, set: { 'stats.ratePerMin': 0 } }])

    const failing = processor(scansCollection({ failing: true }).scans)
    await expect(failing.start()).resolves.toBeUndefined()
    failing.stop()
    expect(log.warn).toHaveBeenCalledWith('resetting the rates an earlier process stored failed', expect.anything())
  })

  it('logs a failed rate write and writes it again at the next refresh', async () => {
    const healthy = scansCollection()
    const batch = processor(healthy.scans)
    await batch.finish(flush(60, T0))
    const failingUpdate = vi.spyOn(healthy.scans, 'updateOne').mockRejectedValueOnce(new Error('MongoDB is unavailable'))

    await batch.refreshRates(T0 + MINUTE)
    expect(log.warn).toHaveBeenCalledWith('updating the rate of a scan failed', expect.objectContaining({ scanId: SCAN }))
    failingUpdate.mockRestore()
    await batch.refreshRates(T0 + MINUTE + 1_000)
    expect(healthy.writes.at(-1)).toEqual({ op: 'updateOne', filter: { _id: SCAN }, set: { 'stats.ratePerMin': 30 } })
  })
})
