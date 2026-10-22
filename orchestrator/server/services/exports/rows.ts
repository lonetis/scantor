import type { Collection, Document } from 'mongodb'
import { DEFAULT_CSV_COLUMNS } from '#shared/schemas/analyses'
import type { AnalysisStatus, ExportFormat } from '#shared/utils/enums'
import type { AnalysisDoc } from '../../types/documents'
import { inclusionProjection, pickPaths, valueAtPath } from '../analyses/fields'
import { analysisMaskPatterns } from '../analyses/masking'
import { toApiAnalysis, toApiDocument } from '../analyses/representation'
import { mapQueryError } from '../query/errors'
import type { QueryLimits, QueryScan } from '../query/execute'
import { scopedFilter } from '../query/scope'
import { csvRow } from './csv'

/*
 * Export rows (docs/api.md §4.15, security.md DL-2, Q-8). Both the inline export and the background export job read
 * the scan's analyses in seq order from the `scantor_query` client, in seq ranges of EXPORT_SEQ_RANGE so every
 * query touches a bounded slice of the `{scanId, seq}` index and stays within SCANTOR_QUERY_MAX_TIME no matter how
 * selective the filter is. JSONL rows are whole (masked) analysis representations or the `fields` projection;
 * CSV rows hold the `fields` columns (default columns otherwise).
 */

export const EXPORT_SEQ_RANGE = 10_000

export const EXPORT_CONTENT_TYPES: Record<ExportFormat, string> = {
  jsonl: 'application/x-ndjson',
  csv: 'text/csv; charset=utf-8',
}

export interface ExportSelection {
  scan: QueryScan
  /** the user filter, already validated by the query allowlist */
  filter: Record<string, unknown>
  status?: AnalysisStatus[]
  /** start after this seq (-1 or null: from the beginning) */
  afterSeq: number | null
  /** normalized representation paths, or null for whole documents / default CSV columns */
  fields: string[] | null
}

export interface ExportProgress {
  afterSeq: number
  maxSeq: number
}

/** The highest seq of the scan's analyses, or null when it has none. */
async function highestSeq(collection: Collection<Document>, scan: QueryScan, limits: QueryLimits): Promise<number | null> {
  const doc = await collection.findOne(scopedFilter(scan), {
    sort: { seq: -1 },
    projection: { seq: 1 },
    maxTimeMS: limits.queryMaxTimeMs,
  })
  return typeof doc?.seq === 'number' ? doc.seq : null
}

function projectionFor(format: ExportFormat, fields: string[] | null): Document | undefined {
  if (fields) return inclusionProjection(fields)
  return format === 'csv' ? inclusionProjection([...DEFAULT_CSV_COLUMNS]) : undefined
}

/**
 * The analyses of a selection in seq order. `onRange` runs after each completed seq range (progress, cursors,
 * cancellation checks).
 */
export async function* exportDocuments(
  selection: ExportSelection,
  format: ExportFormat,
  collection: Collection<Document>,
  limits: QueryLimits,
  onRange?: (progress: ExportProgress) => Promise<void> | void,
): AsyncGenerator<Document> {
  let maxSeq: number | null
  try {
    maxSeq = await highestSeq(collection, selection.scan, limits)
  } catch (error) {
    throw mapQueryError(error, 'filter')
  }
  if (maxSeq === null) return
  const projection = projectionFor(format, selection.fields)
  let after = selection.afterSeq ?? -1
  while (after < maxSeq) {
    const upper = Math.min(after + EXPORT_SEQ_RANGE, maxSeq)
    const clauses: Document[] = [selection.filter, { seq: { $gt: after, $lte: upper } }]
    if (selection.status && selection.status.length > 0) clauses.push({ status: { $in: selection.status } })
    const cursor = collection.find(scopedFilter(selection.scan, ...clauses), {
      projection,
      sort: { seq: 1 },
      maxTimeMS: limits.queryMaxTimeMs,
      allowDiskUse: false,
    })
    try {
      for await (const doc of cursor) yield doc
    } catch (error) {
      throw mapQueryError(error, 'filter')
    } finally {
      await cursor.close().catch(() => undefined)
    }
    after = upper
    await onRange?.({ afterSeq: after, maxSeq })
  }
}

export interface RowFormatter {
  /** the first line of the file (CSV header), or null */
  header(): string | null
  row(doc: Document): string
}

export function createRowFormatter(format: ExportFormat, fields: string[] | null, scan: QueryScan): RowFormatter {
  const patterns = analysisMaskPatterns(scan.secretPaths)
  if (format === 'jsonl') {
    return {
      header: () => null,
      row: (doc) => {
        const value = fields ? pickPaths(toApiDocument(doc, patterns), fields) : toApiAnalysis(doc as AnalysisDoc, patterns)
        return `${JSON.stringify(value)}\n`
      },
    }
  }
  const columns = fields ?? [...DEFAULT_CSV_COLUMNS]
  return {
    header: () => csvRow(columns),
    row: (doc) => {
      const representation = toApiDocument(doc, patterns)
      return csvRow(columns.map((column) => valueAtPath(representation, column)))
    },
  }
}

export interface ExportCounters {
  rows: number
  bytes: number
}

/** The lines of an export file; `counters` are updated as lines are produced. */
export async function* exportLines(
  documents: AsyncIterable<Document>,
  formatter: RowFormatter,
  counters: ExportCounters,
): AsyncGenerator<string> {
  const header = formatter.header()
  if (header !== null) {
    counters.bytes += Buffer.byteLength(header)
    yield header
  }
  for await (const doc of documents) {
    const line = formatter.row(doc)
    counters.rows += 1
    counters.bytes += Buffer.byteLength(line)
    yield line
  }
}
