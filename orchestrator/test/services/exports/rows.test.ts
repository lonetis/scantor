import { describe, expect, it } from 'vitest'
import { EXPORT_SEQ_RANGE, exportDocuments, type ExportProgress } from '../../../server/services/exports/rows'
import { analysis, scan, streamableAnalyses } from '../script-runtime/helpers'

// exportDocuments (docs/api.md §4.15, docs/scripts.md): seq windows of EXPORT_SEQ_RANGE between afterSeq and the newest
// analysis, clamped to untilSeq when given (script analysis streams), with onRange after every window.

async function run(afterSeq: number | null, untilSeq?: number | null) {
  const analyses = streamableAnalyses()
  for (const seq of [0, 3, EXPORT_SEQ_RANGE + 2, 2 * EXPORT_SEQ_RANGE + 7]) await analyses.fake.insertOne(analysis(seq))
  const ranges: ExportProgress[] = []
  const seqs: number[] = []
  const selection = { scan: scan(), filter: {}, afterSeq, untilSeq, fields: ['seq'] }
  for await (const doc of exportDocuments(selection, 'jsonl', analyses.collection, { queryMaxTimeMs: 1000, queryMaxDocs: 10 }, (range) => {
    ranges.push(range)
  })) {
    seqs.push(doc.seq as number)
  }
  return { seqs, ranges, finds: analyses.finds.length, closed: analyses.closed }
}

describe('exportDocuments', () => {
  it('reads every analysis after afterSeq in windows up to the newest seq', async () => {
    const all = await run(null)
    expect(all.seqs).toEqual([0, 3, EXPORT_SEQ_RANGE + 2, 2 * EXPORT_SEQ_RANGE + 7])
    expect(all.ranges.map((range) => range.afterSeq)).toEqual([EXPORT_SEQ_RANGE - 1, 2 * EXPORT_SEQ_RANGE - 1, 2 * EXPORT_SEQ_RANGE + 7])
    expect(all.closed).toBe(all.finds)
    expect((await run(3)).seqs).toEqual([EXPORT_SEQ_RANGE + 2, 2 * EXPORT_SEQ_RANGE + 7])
  })

  it('ends with untilSeq when it lies before the newest seq', async () => {
    const until = await run(0, EXPORT_SEQ_RANGE + 2)
    expect(until.seqs).toEqual([3, EXPORT_SEQ_RANGE + 2])
    expect(until.ranges.map((range) => range).at(-1)).toEqual({ afterSeq: EXPORT_SEQ_RANGE + 2, maxSeq: EXPORT_SEQ_RANGE + 2 })
    expect((await run(null, 10 * EXPORT_SEQ_RANGE)).seqs).toHaveLength(4)
    expect((await run(5, 5)).seqs).toEqual([])
  })
})
