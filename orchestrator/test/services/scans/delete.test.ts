import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DELETE_SLICE_MS, deleteScanAnalyses, yieldToWaitingDeletes } from '../../../server/services/scans/delete'
import type { AnalysisDoc, JobDoc } from '../../../server/types/documents'
import { JobDeferredError } from '../../../server/utils/jobs'
import { FakeCollection } from '../../helpers/fake-collection'
import { analysisDoc, T0 } from './fixtures'

// The scanDelete job (docs/data-model.md §4.12, docs/architecture.md §11.3): two slots, and a job that deleted
// analyses for DELETE_SLICE_MS gives its slot to waiting deletions between batches, so a large scan does not hold
// a slot for minutes ahead of them. The whole job against MongoDB, RabbitMQ and S3 is covered by
// test/services/scans/broker.integration.test.ts.

const SCAN_ID = '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f'

/** The analyses subset deleteScanAnalyses uses: the boundary lookup (sort, skip, limit, next) and deleteMany. */
class BatchedAnalyses extends FakeCollection<AnalysisDoc> {
  override find(filter: Record<string, unknown> = {}) {
    const base = super.find(filter)
    let skip = 0
    const chain = {
      sort: (spec: Record<string, 1 | -1>) => (base.sort(spec), chain),
      skip: (count: number) => ((skip = count), chain),
      limit: (count: number) => (base.limit(skip + count), chain),
      next: async () => (await base.toArray())[skip] ?? null,
    }
    return chain as unknown as ReturnType<FakeCollection<AnalysisDoc>['find']>
  }
}

const store = { jobs: new FakeCollection<JobDoc>('jobs'), analyses: new BatchedAnalyses('analyses') }

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => ({ jobs: store.jobs.asCollection(), analyses: store.analyses.asCollection() }),
}))

function job(id: string, overrides: Partial<JobDoc> = {}): JobDoc {
  return {
    _id: id,
    kind: 'scanDelete',
    userId: 'user-a',
    subject: { kind: 'scan', id: SCAN_ID },
    params: {},
    state: 'running',
    active: true,
    cursor: {},
    progress: { done: 0, total: null },
    attempts: 1,
    maxAttempts: 10,
    lease: null,
    error: null,
    notBefore: T0,
    createdAt: T0,
    startedAt: T0,
    finishedAt: null,
    updatedAt: T0,
    ...overrides,
  } as JobDoc
}

describe('yieldToWaitingDeletes', () => {
  beforeEach(async () => {
    await store.jobs.deleteMany({})
  })

  it('keeps the slot within the slice and while no other deletion is due', async () => {
    const self = job('self')
    await store.jobs.insertOne(self)
    await store.jobs.insertOne(job('later', { state: 'queued', notBefore: new Date(T0.getTime() + 60 * DELETE_SLICE_MS) }))
    await store.jobs.insertOne(job('build', { kind: 'revisionBuild', state: 'queued' }))
    const now = T0.getTime() + 2 * DELETE_SLICE_MS

    await expect(yieldToWaitingDeletes(self, T0.getTime(), T0.getTime() + DELETE_SLICE_MS - 1)).resolves.toBeUndefined()
    await expect(yieldToWaitingDeletes(self, T0.getTime(), now)).resolves.toBeUndefined()
  })

  it('defers the job at once after the slice while another deletion is due', async () => {
    const self = job('self')
    await store.jobs.insertOne(self)
    await store.jobs.insertOne(job('waiting', { state: 'queued' }))
    const now = T0.getTime() + DELETE_SLICE_MS

    const deferral = await yieldToWaitingDeletes(self, T0.getTime(), now).then(
      () => null,
      (error: unknown) => error,
    )
    expect(deferral).toBeInstanceOf(JobDeferredError)
    expect((deferral as JobDeferredError).until.getTime()).toBe(now)
  })
})

describe('deleteScanAnalyses', () => {
  beforeEach(async () => {
    await store.analyses.deleteMany({})
    for (let seq = 0; seq < 7; seq++) await store.analyses.insertOne(analysisDoc(SCAN_ID, seq, 'succeeded'))
    await store.analyses.insertOne(analysisDoc('other-scan', 0, 'succeeded'))
  })

  it('deletes in batches by seq and tells whether another batch follows', async () => {
    const batches: [number, number, boolean][] = []
    await deleteScanAnalyses(SCAN_ID, -1, async (afterSeq, deleted, more) => void batches.push([afterSeq, deleted, more]), undefined, 3)
    expect(batches).toEqual([
      [2, 3, true],
      [5, 3, true],
      [5, 1, false],
    ])
    expect(store.analyses.docs.map((doc) => doc.scanId)).toEqual(['other-scan'])
  })

  it('resumes after the saved seq', async () => {
    const batches: [number, number, boolean][] = []
    await deleteScanAnalyses(SCAN_ID, 4, async (afterSeq, deleted, more) => void batches.push([afterSeq, deleted, more]), undefined, 3)
    expect(batches).toEqual([[4, 2, false]])
    expect(store.analyses.docs).toHaveLength(6)
  })
})
