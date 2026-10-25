import type { Collection } from 'mongodb'
import { describe, expect, it } from 'vitest'
import { listAnalyses, type ListScan } from '../../../server/services/analyses/list'
import { ANALYSES_PAGE_MAX_BYTES } from '../../../server/services/analyses/representation'
import type { AnalysisDoc } from '../../../server/types/documents'
import { matches } from '../../helpers/fake-collection'
import { analysisDoc } from '../scans/fixtures'

// listAnalyses (docs/api.md §1.8, §4.14): the cursor is streamed and a page ends early at the response byte cap with
// `nextCursor` set, so pages of large results never hold `limit` full documents and paging by nextCursor sees every
// analysis exactly once.

const SCAN: ListScan = {
  _id: '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f',
  userId: 'user-a',
  secretPaths: { taskConfig: [], scanConfig: [], analysisConfig: [], result: [] },
}
const MIB = 1024 * 1024

/** The find subset listAnalyses uses: filter, sort by seq, limit, async iteration and close. */
class StreamedAnalyses {
  /** documents each cursor handed out, in call order */
  readonly reads: number[] = []
  closed = 0

  constructor(private readonly docs: AnalysisDoc[]) {}

  find(filter: Record<string, unknown>, options: { sort?: { seq: 1 }; limit?: number }) {
    const selected = this.docs.filter((doc) => matches(doc as unknown as Record<string, unknown>, filter)).sort((a, b) => a.seq - b.seq)
    const limited = options.limit === undefined ? selected : selected.slice(0, options.limit)
    const reads = this.reads
    const call = reads.push(0) - 1
    const onClose = () => {
      this.closed++
    }
    return {
      async *[Symbol.asyncIterator]() {
        for (const doc of limited) {
          reads[call]! += 1
          yield structuredClone(doc)
        }
      },
      async close() {
        onClose()
      },
    }
  }

  asCollection(): Collection<AnalysisDoc> {
    return this as unknown as Collection<AnalysisDoc>
  }
}

function withResult(seq: number, bytes: number): AnalysisDoc {
  return analysisDoc(SCAN._id, seq, 'succeeded', { result: { body: 'x'.repeat(bytes) } })
}

async function pageAll(analyses: StreamedAnalyses, limit: number) {
  const pages: { seqs: number[]; bytes: number; nextCursor: string | null }[] = []
  let afterSeq: number | undefined
  for (;;) {
    const page = await listAnalyses(SCAN, { limit, ...(afterSeq === undefined ? {} : { afterSeq }) }, analyses.asCollection())
    pages.push({
      seqs: page.items.map((item) => item.seq as number),
      bytes: page.items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0),
      nextCursor: page.nextCursor ?? null,
    })
    if (!page.nextCursor) return pages
    afterSeq = Number(page.nextCursor)
  }
}

describe('listAnalyses', () => {
  it('splits large results into pages below the byte cap and pages through every analysis exactly once', async () => {
    const analyses = new StreamedAnalyses(Array.from({ length: 10 }, (_, seq) => withResult(seq, 5 * MIB)))
    const pages = await pageAll(analyses, 1000)

    expect(pages.map((page) => page.seqs)).toEqual([[0, 1, 2], [3, 4, 5], [6, 7, 8], [9]])
    for (const page of pages) expect(page.bytes).toBeLessThanOrEqual(ANALYSES_PAGE_MAX_BYTES)
    expect(pages.map((page) => page.nextCursor)).toEqual(['2', '5', '8', null])
    // A page stops reading at the item that does not fit instead of loading `limit + 1` documents.
    expect(analyses.reads).toEqual([4, 4, 4, 1])
    expect(analyses.closed).toBe(pages.length)
  })

  it('returns an item above the cap alone, so paging always advances', async () => {
    const analyses = new StreamedAnalyses([withResult(0, 1024), withResult(1, ANALYSES_PAGE_MAX_BYTES + MIB), withResult(2, 1024)])
    const pages = await pageAll(analyses, 50)

    expect(pages.map((page) => page.seqs)).toEqual([[0], [1], [2]])
    expect(pages.map((page) => page.nextCursor)).toEqual(['0', '1', null])
  })

  it('applies the limit and the filters to small results', async () => {
    const analyses = new StreamedAnalyses([
      ...Array.from({ length: 5 }, (_, seq) => analysisDoc(SCAN._id, seq, seq % 2 === 0 ? 'succeeded' : 'failed')),
      analysisDoc('other-scan', 1, 'failed'),
    ])

    const first = await listAnalyses(SCAN, { limit: 2 }, analyses.asCollection())
    expect(first.items.map((item) => item.seq)).toEqual([0, 1])
    expect(first.nextCursor).toBe('1')

    const failed = await listAnalyses(SCAN, { status: ['failed'], limit: 2 }, analyses.asCollection())
    expect(failed.items.map((item) => [item.seq, item.status, item.scanId])).toEqual([
      [1, 'failed', SCAN._id],
      [3, 'failed', SCAN._id],
    ])
    expect(failed.nextCursor).toBeNull()

    const rest = await listAnalyses(SCAN, { afterSeq: 2, limit: 50 }, analyses.asCollection())
    expect(rest.items.map((item) => item.seq)).toEqual([3, 4])
    expect(rest.nextCursor).toBeNull()
  })
})
