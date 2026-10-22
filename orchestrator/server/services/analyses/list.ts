import type { Collection, Document, Filter } from 'mongodb'
import type { ListAnalysesQuery } from '#shared/schemas/analyses'
import { LIST_ANALYSES_DEFAULT_LIMIT } from '#shared/schemas/analyses'
import type { Page } from '#shared/types/common'
import type { AnalysisDoc, ScanDoc } from '../../types/documents'
import { useCollections } from '../../utils/mongo'
import { normalizeFieldPaths, inclusionProjection } from './fields'
import { analysisMaskPatterns } from './masking'
import { toApiAnalysis, toApiDocument } from './representation'

// listAnalyses (docs/api.md §4.14, §1.8): the analyses of one scan in seq order, filtered by status, resumable with
// `afterSeq`; `nextCursor` is the decimal string of the last returned seq. With `fields` only those dot paths (plus
// `id` and `seq`) are loaded, so large results never reach a results table. The filter is built by the server only.

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

  const docs = await analyses
    .find({ $and: clauses }, { projection: fields ? inclusionProjection(fields) : undefined })
    .sort({ seq: 1 })
    .limit(limit + 1)
    .toArray()
  const hasMore = docs.length > limit
  const page = hasMore ? docs.slice(0, limit) : docs
  const items = page.map((doc) =>
    fields ? toApiDocument(doc as Document, patterns) : (toApiAnalysis(doc, patterns) as unknown as Record<string, unknown>),
  )
  const last = page.at(-1)
  return { items, nextCursor: hasMore && last ? String(last.seq) : null }
}
