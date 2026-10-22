import { Readable } from 'node:stream'
import { type H3Event, sendStream, setResponseHeader } from 'h3'
import type { Document } from 'mongodb'
import type { ExportInlineQuery } from '#shared/schemas/analyses'
import type { ScanDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import { apiError, validationError } from '../../utils/errors'
import { contentDisposition } from '../../utils/s3'
import { useLogger } from '../../utils/logger'
import { mapQueryError } from '../query/errors'
import { queryAnalysesCollection } from '../query/execute'
import { acquireQuerySlot } from '../query/limiter'
import { scopedFilter } from '../query/scope'
import { createRowFormatter, EXPORT_CONTENT_TYPES, exportDocuments, exportLines } from './rows'
import { assertExportable, validateExportSelection } from './service'

// exportScanInline (docs/api.md §4.15): the selected analyses streamed in seq order as JSONL or CSV, at most
// SCANTOR_EXPORT_INLINE_MAX analyses (409 exportTooLarge above; use exportScan). It holds one of the caller's query
// slots until the stream ends or the client disconnects. Errors after the first byte abort the connection.

const log = useLogger('exports')

function parseFilterParameter(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw === '') return {}
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw validationError([{ path: 'filter', message: 'must be a URL-encoded JSON object' }], 'query validation failed')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw validationError([{ path: 'filter', message: 'must be a JSON object' }], 'query validation failed')
  }
  return value as Record<string, unknown>
}

export async function streamInlineExport(
  event: H3Event,
  scan: ScanDoc,
  query: ExportInlineQuery,
  callerId: string,
  config: Pick<Config, 'exportInlineMax' | 'queryMaxTimeMs' | 'queryMaxDocs' | 'userMaxConcurrentQueries'>,
): Promise<void> {
  assertExportable(scan)
  const filter = parseFilterParameter(query.filter)
  const fields = validateExportSelection(scan, filter, query.fields)
  const limits = { queryMaxTimeMs: config.queryMaxTimeMs, queryMaxDocs: config.queryMaxDocs }
  const selection = { scan, filter, status: query.status, afterSeq: query.afterSeq ?? null, fields }

  const release = acquireQuerySlot(callerId, config.userMaxConcurrentQueries)
  let stream: Readable
  try {
    const collection = await queryAnalysesCollection()
    const clauses: Document[] = [filter]
    if (selection.afterSeq !== null) clauses.push({ seq: { $gt: selection.afterSeq } })
    if (query.status && query.status.length > 0) clauses.push({ status: { $in: query.status } })
    const count = await collection
      .countDocuments(scopedFilter(scan, ...clauses), { limit: config.exportInlineMax + 1, maxTimeMS: config.queryMaxTimeMs })
      .catch((error: unknown) => {
        throw mapQueryError(error, 'filter')
      })
    if (count > config.exportInlineMax) {
      throw apiError('exportTooLarge', `more than ${config.exportInlineMax} analyses match; use exportScan for a background export`, {
        limit: config.exportInlineMax,
      })
    }
    const formatter = createRowFormatter(query.format, fields, scan)
    stream = Readable.from(exportLines(exportDocuments(selection, query.format, collection, limits), formatter, { rows: 0, bytes: 0 }))
    // 'close' follows the end of the stream as well as a destroy (client gone, error), even before the first read.
    stream.once('close', release)
  } catch (error) {
    release()
    throw error
  }

  setResponseHeader(event, 'Content-Type', EXPORT_CONTENT_TYPES[query.format])
  setResponseHeader(event, 'Content-Disposition', contentDisposition('attachment', `scantor-${scan._id}.${query.format}`))
  event.node.res.once('close', () => {
    if (!stream.destroyed) stream.destroy()
  })
  try {
    await sendStream(event, stream)
  } catch (error) {
    log.error('inline export failed after the response started', { scanId: scan._id, err: error })
    event.node.res.destroy()
  }
}
