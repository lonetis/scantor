import { useCollections } from '../../utils/mongo'
import type { WorkerPrincipal } from '../../utils/principal'

// POST /api/runtime/analyses/status (docs/api.md §8.4): the stored status of redelivered analyses, confined to the
// worker's own scan. Missing documents answer with nulls; the runtime acks without running when the stored round is
// newer, or the same round is already succeeded or failed.

export interface AnalysisStatusItem {
  seq: number
  status: string | null
  round: number | null
  attempt: number | null
}

export async function analysesStatus(principal: WorkerPrincipal, seqs: number[]): Promise<{ items: AnalysisStatusItem[] }> {
  const scanId = principal.worker.scanId
  const unique = [...new Set(seqs)]
  const docs = await useCollections()
    .analyses.find(
      { _id: { $in: unique.map((seq) => `${scanId}-${seq}`) }, scanId },
      { projection: { seq: 1, status: 1, round: 1, attempt: 1 } },
    )
    .toArray()
  const bySeq = new Map(docs.map((doc) => [doc.seq, doc]))
  return {
    items: seqs.map((seq) => {
      const doc = bySeq.get(seq)
      return doc ? { seq, status: doc.status, round: doc.round, attempt: doc.attempt } : { seq, status: null, round: null, attempt: null }
    }),
  }
}
