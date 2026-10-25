import type { Collection, Document, Filter } from 'mongodb'
import type { ListAnalysesQuery } from '#shared/schemas/analyses'
import { LIST_ANALYSES_DEFAULT_LIMIT } from '#shared/schemas/analyses'
import type { Page } from '#shared/types/common'
import type { AnalysisDoc, ScanDoc } from '../../types/documents'
import { useCollections } from '../../utils/mongo'
import { normalizeFieldPaths, inclusionProjection } from './fields'
import { analysisMaskPatterns } from './masking'
import { ANALYSES_PAGE_MAX_BYTES, toApiAnalysis, toApiDocument } from './representation'

// listAnalyses (docs/api.md §4.14, §1.8): the analyses of one scan in seq order, filtered by status, resumable with
// `afterSeq`; `nextCursor` is the decimal string of the last returned seq. With `fields` only those dot paths (plus
// `id` and `seq`) are loaded, so large results never reach a results table. The filter is built by the server only.
// The cursor is streamed and a page ends early at ANALYSES_PAGE_MAX_BYTES (with `nextCursor` set), so a page of large
// results never holds the whole `limit` in memory nor exceeds what one response can serialize.

export type ListScan = Pick<ScanDoc, '_id' | 'userId' | 'secretPaths'>

export async function listAnalyses(
  scan: ListScan,
  query: ListAnalysesQuery,
  analyses: Collection<AnalysisDoc> = useCollections().analyses,
): Promise<Page<Record<string, unknown>>> {
  const limit = query.limit ?? LIST_ANALYSES_DEFAULT_LIMIT
  const clauses: Filter<AnalysisDoc>[] = [{ scanId: scan._id }, { userId: scan.userId }]
  if (query.status && query.status.length > 0) clauses.push({ status: { $in: query.status } })
  if (query.afterSeq !== undefined) clauses.push({ seq: { $gt: query.afterSeq } })
  const fields = query.fields ? normalizeFieldPaths(query.fields) : null
  const patterns = analysisMaskPatterns(scan.secretPaths)

  const items: Record<string, unknown>[] = []
  let lastSeq: number | null = null
  let hasMore = false
  let bytes = 0
  const cursor = analyses.find({ $and: clauses }, { projection: fields ? inclusionProjection(fields) : undefined, sort: { seq: 1 }, limit: limit + 1 })
  try {
    for await (const doc of cursor) {
      if (items.length >= limit) {
        hasMore = true
        break
      }
      const item = fields ? toApiDocument(doc as Document, patterns) : (toApiAnalysis(doc, patterns) as unknown as Record<string, unknown>)
      bytes += Buffer.byteLength(JSON.stringify(item))
      if (bytes > ANALYSES_PAGE_MAX_BYTES && items.length > 0) {
        hasMore = true
        break
      }
      items.push(item)
      lastSeq = doc.seq
    }
  } finally {
    await cursor.close()
  }
  return { items, nextCursor: hasMore && lastSeq !== null ? String(lastSeq) : null }
}
