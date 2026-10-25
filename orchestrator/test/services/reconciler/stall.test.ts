import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StallDetector } from '../../../server/services/reconciler/stall'
import type { AnalysisDoc, EventDoc, JobDoc, ScanDoc } from '../../../server/types/documents'
import type { Logger } from '../../../server/utils/logger'
import { FakeCollection, matches } from '../../helpers/fake-collection'
import { analysisDoc, scanDoc } from '../scans/fixtures'

// Stall detection (docs/queue.md §9) decides on the scan read at the start of the tick. A retry-failed that starts
// while the recount and the gap walk run moves the scan to round R + 1 and resets failed analyses to `pending` in
// that round; the stall step must leave them alone. The MongoDB behaviour of the whole step is covered by
// test/services/scans/broker.integration.test.ts.

type Doc = Record<string, unknown>

/** The fake collection plus the recount aggregation, insertMany and the gap walk's sort/map cursor. */
class FakeAnalyses extends FakeCollection<AnalysisDoc> {
  /** runs before every gap-walk read */
  onWalk: (() => Promise<void>) | null = null

  aggregate(pipeline: Doc[]) {
    const match = (pipeline[0]?.$match ?? {}) as Doc
    const counts = new Map<string, number>()
    for (const doc of this.docs.filter((candidate) => matches(candidate, match))) {
      counts.set(doc.status as string, (counts.get(doc.status as string) ?? 0) + 1)
    }
    return { toArray: async () => [...counts].map(([status, n]) => ({ _id: status, n })) }
  }

  async insertMany(docs: AnalysisDoc[]) {
    for (const doc of docs) await this.insertOne(doc)
    return { insertedCount: docs.length }
  }

  override find(filter: Doc = {}, options: { sort?: Record<string, 1 | -1>; projection?: Record<string, 0 | 1> } = {}) {
    const cursor = super.find(filter, options)
    let mapper: ((doc: AnalysisDoc) => unknown) | null = null
    const walk = this.onWalk
    const chain = {
      sort(spec: Record<string, 1 | -1>) {
        cursor.sort(spec)
        return chain
      },
      map(fn: (doc: AnalysisDoc) => unknown) {
        mapper = fn
        return chain
      },
      async toArray() {
        if (walk) await walk()
        const docs = await cursor.toArray()
        return mapper ? docs.map(mapper) : docs
      },
    }
    return chain as unknown as ReturnType<FakeCollection<AnalysisDoc>['find']>
  }
}

/** The fake collection with `$push` (raising a condition) and a hook after each stall-state check (countDocuments). */
class FakeScans extends FakeCollection<ScanDoc> {
  checks = 0
  afterCheck: ((check: number) => Promise<void>) | null = null

  override async countDocuments(filter: Doc = {}): Promise<number> {
    const count = await super.countDocuments(filter)
    this.checks++
    await this.afterCheck?.(this.checks)
    return count
  }

  override async updateOne(filter: Doc, update: Doc | Doc[], options: { upsert?: boolean } = {}) {
    if (Array.isArray(update) || !('$push' in update)) return super.updateOne(filter, update, options)
    const target = this.docs.find((doc) => matches(doc, filter))
    if (!target) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }
    for (const [path, value] of Object.entries(update.$push as Doc)) (target[path] as unknown[]).push(structuredClone(value))
    return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }
  }
}

const store = {
  scans: new FakeScans('scans'),
  analyses: new FakeAnalyses('analyses'),
  events: new FakeCollection<EventDoc>('events'),
  jobs: new FakeCollection<JobDoc>('jobs'),
}

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => Object.fromEntries(Object.entries(store).map(([name, collection]) => [name, collection.asCollection()])),
}))

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger
const SCAN_ID = '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f'
const EMPTY_QUEUE = new Map([[SCAN_ID, { ready: 0, unacked: 0, delayed: 0, consumers: 0 }]])

function detector(): StallDetector {
  return new StallDetector({ scans: store.scans.asCollection(), analyses: store.analyses.asCollection(), stallAfterMs: 0, log })
}

/** What retryFailedAnalyses and the reset phase of its job write (docs/queue.md §8). */
async function startRetryFailed(): Promise<void> {
  await store.scans.updateOne({ _id: SCAN_ID }, { $set: { round: 2, 'scheduling.state': 'retrying', state: 'running' } })
  await store.analyses.updateMany(
    { scanId: SCAN_ID, status: { $in: ['failed', 'lost'] }, round: { $lte: 1 }, config: { $exists: true } },
    { $set: { status: 'pending', round: 2, attempt: 0 } },
  )
}

async function statuses(): Promise<[number, string, number][]> {
  const docs = await store.analyses.find({ scanId: SCAN_ID }).sort({ seq: 1 }).toArray()
  return docs.map((doc) => [doc.seq, doc.status, doc.round])
}

async function scan(): Promise<ScanDoc> {
  return (await store.scans.findOne({ _id: SCAN_ID }))!
}

describe('StallDetector', () => {
  beforeEach(async () => {
    for (const collection of Object.values(store)) await collection.deleteMany({})
    store.analyses.onWalk = null
    store.scans.afterCheck = null
    store.scans.checks = 0
    await store.scans.insertOne(scanDoc({ _id: SCAN_ID, state: 'running', scheduling: { state: 'done', confirmed: 4 } }))
    await store.analyses.insertOne(analysisDoc(SCAN_ID, 0, 'succeeded'))
    await store.analyses.insertOne(analysisDoc(SCAN_ID, 1, 'failed'))
    await store.analyses.insertOne(analysisDoc(SCAN_ID, 2, 'retrying'))
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('gap-fills and converts the analyses of a stalled scan and completes it', async () => {
    await detector().run(EMPTY_QUEUE)

    expect(await statuses()).toEqual([
      [0, 'succeeded', 1],
      [1, 'failed', 1],
      [2, 'lost', 1],
      [3, 'lost', 1],
    ])
    expect(await scan()).toMatchObject({ state: 'completed', stateReason: { code: 'stalled' }, conditions: [{ type: 'stalled', details: { lost: 2 } }] })
    expect(await store.events.countDocuments({ type: 'scan.lostAnalyses' })).toBe(1)
  })

  it('leaves a scan alone whose retry-failed started during the gap walk', async () => {
    store.analyses.onWalk = async () => {
      store.analyses.onWalk = null
      await startRetryFailed()
    }

    await detector().run(EMPTY_QUEUE)

    // The walk that saw round 1 inserted seq 3; the retried analysis stays pending in round 2, and the round-1
    // `retrying` analysis is not converted once the scan is retrying.
    expect(await statuses()).toEqual([
      [0, 'succeeded', 1],
      [1, 'pending', 2],
      [2, 'retrying', 1],
      [3, 'lost', 1],
    ])
    expect(await scan()).toMatchObject({ state: 'running', round: 2, scheduling: { state: 'retrying' }, conditions: [] })
    expect(await store.events.countDocuments({ type: 'scan.lostAnalyses' })).toBe(0)
  })

  it('converts only the earlier round when retry-failed starts right after the last check', async () => {
    store.scans.afterCheck = async (check) => {
      if (check === 2) await startRetryFailed()
    }

    await detector().run(EMPTY_QUEUE)

    expect(store.scans.checks).toBe(2)
    expect(await statuses()).toEqual([
      [0, 'succeeded', 1],
      [1, 'pending', 2],
      [2, 'lost', 1],
      [3, 'lost', 1],
    ])
    // The retry round keeps running: completion requires scheduling done or failed.
    expect(await scan()).toMatchObject({ state: 'running', round: 2, scheduling: { state: 'retrying' } })
  })
})
