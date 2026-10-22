import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LifecycleConvergence, RECOUNT_INTERVAL_MS } from '../../../server/services/reconciler/lifecycle'
import type { AnalysisDoc, EventDoc, JobDoc, ScanDoc } from '../../../server/types/documents'
import type { Logger } from '../../../server/utils/logger'
import { FakeCollection, matches } from '../../helpers/fake-collection'
import { analysisDoc, scanDoc } from '../scans/fixtures'

// Periodic recounts of the reconciler's lifecycle convergence (docs/queue.md §6.9): running scans every 60 s,
// paused scans at the same cadence while their hint counters changed since the last recount. The MongoDB
// behaviour of the whole convergence is covered by test/services/scans/broker.integration.test.ts.

/** The fake collection plus the `$match` + `$group by $status` aggregation the recount runs. */
class FakeAnalyses extends FakeCollection<AnalysisDoc> {
  aggregate(pipeline: Record<string, unknown>[]) {
    const match = (pipeline[0]?.$match ?? {}) as Record<string, unknown>
    const counts = new Map<string, number>()
    for (const doc of this.docs.filter((candidate) => matches(candidate, match))) {
      counts.set(doc.status as string, (counts.get(doc.status as string) ?? 0) + 1)
    }
    return { toArray: async () => [...counts].map(([status, n]) => ({ _id: status, n })) }
  }
}

const store = {
  scans: new FakeCollection<ScanDoc>('scans'),
  analyses: new FakeAnalyses('analyses'),
  events: new FakeCollection<EventDoc>('events'),
  jobs: new FakeCollection<JobDoc>('jobs'),
}

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => Object.fromEntries(Object.entries(store).map(([name, collection]) => [name, collection.asCollection()])),
}))

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger
const T0 = new Date('2026-10-21T10:00:00.000Z')
const SCAN_ID = '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f'

function at(ms: number): Date {
  return new Date(T0.getTime() + ms)
}

/** The recount stamps `recountedAt` with the wall clock, so the tests move the (faked) system time. */
function convergence(): LifecycleConvergence {
  return new LifecycleConvergence({ scans: store.scans.asCollection(), analyses: store.analyses.asCollection(), jobs: store.jobs.asCollection(), log })
}

async function stats() {
  return (await store.scans.findOne({ _id: SCAN_ID }))!.stats
}

describe('LifecycleConvergence periodic recounts', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    for (const collection of Object.values(store)) await collection.deleteMany({})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('recounts a paused scan whose hint counters drifted, then leaves it alone until they change again', async () => {
    // Stale hints after a retry-failed round: the job's recount said 3 pending, then 2 failures arrived as hints.
    await store.scans.insertOne(
      scanDoc({
        _id: SCAN_ID,
        state: 'paused',
        updatedAt: at(5_000),
        stats: { pending: 3, retrying: 0, succeeded: 0, failed: 2, lost: 0, cancelled: 0, expectedTotal: null, ratePerMin: 0, recountedAt: T0 },
        scheduling: { state: 'done', confirmed: 3 },
      }),
    )
    for (const [seq, status] of (['failed', 'failed', 'pending'] as const).entries()) await store.analyses.insertOne(analysisDoc(SCAN_ID, seq, status))
    vi.setSystemTime(at(RECOUNT_INTERVAL_MS))
    const lifecycle = convergence()

    await lifecycle.run(null)
    expect(await stats()).toMatchObject({ pending: 1, failed: 2, recountedAt: at(RECOUNT_INTERVAL_MS) })
    expect((await store.scans.findOne({ _id: SCAN_ID }))!.state).toBe('paused')

    // No change since the recount: no further recount even when due.
    vi.setSystemTime(at(3 * RECOUNT_INTERVAL_MS))
    await store.scans.updateOne({ _id: SCAN_ID }, { $set: { 'stats.failed': 99 } })
    await lifecycle.run(null)
    expect((await stats()).failed).toBe(99)

    // A late result moved the hints (and updatedAt): recounted at the next due tick.
    await store.scans.updateOne({ _id: SCAN_ID }, { $set: { updatedAt: at(3 * RECOUNT_INTERVAL_MS + 1) } })
    vi.setSystemTime(at(5 * RECOUNT_INTERVAL_MS))
    await lifecycle.run(null)
    expect((await stats()).failed).toBe(2)
  })

  it('completes a running scan whose scheduling finished at the periodic check', async () => {
    await store.scans.insertOne(scanDoc({ _id: SCAN_ID, state: 'running', scheduling: { state: 'done', confirmed: 2 } }))
    for (const seq of [0, 1]) await store.analyses.insertOne(analysisDoc(SCAN_ID, seq, 'succeeded'))

    vi.setSystemTime(at(RECOUNT_INTERVAL_MS))
    await convergence().run(null)

    const scan = (await store.scans.findOne({ _id: SCAN_ID }))!
    expect(scan.state).toBe('completed')
    expect(scan.stats).toMatchObject({ succeeded: 2 })
  })
})
