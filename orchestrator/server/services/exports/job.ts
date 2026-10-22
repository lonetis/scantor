import { Readable } from 'node:stream'
import type { JobDoc } from '../../types/documents'
import { ApiError } from '../../utils/errors'
import { FatalJobError, type JobContext, type JobKindDefinition } from '../../utils/jobs'
import { useCollections } from '../../utils/mongo'
import { uploadStream } from '../../utils/s3'
import { queryAnalysesCollection } from '../query/execute'
import { createRowFormatter, EXPORT_CONTENT_TYPES, exportDocuments, exportLines, type ExportCounters } from './rows'
import { validateExportSelection } from './service'

/*
 * The `export` job kind (reconciler component; docs/data-model.md §4.12, §6.9; security.md Q-8). It streams the
 * selected analyses from the `scantor_query` client into `exports/<userId>/<exportId>.<format>` (multipart upload)
 * and marks the export `ready` with its row and byte counts. The cursor `{afterSeq, part}` records progress through
 * the scan's seq space; a job restarted after a lease expiry writes the object again from the start (the upload
 * overwrites it), because a partially uploaded object cannot be resumed.
 */

const EXPORT_JOB_CONCURRENCY = 4

function exportIdOf(job: JobDoc): string {
  const id = job.params.exportId
  if (typeof id !== 'string' || id !== job.subject.id) throw new FatalJobError('invalidParams', 'export job without a matching exportId')
  return id
}

/** Query rejections and timeouts cannot succeed on a retry: they end the job at once. */
function asJobError(error: unknown): unknown {
  if (error instanceof ApiError && (error.statusCode < 500 || error.code === 'queryTimeout')) {
    return new FatalJobError(error.code, error.message)
  }
  return error
}

async function runExport(job: JobDoc, ctx: JobContext): Promise<void> {
  const { exports, scans } = useCollections()
  const exportId = exportIdOf(job)
  const doc = await exports.findOne({ _id: exportId })
  if (!doc) throw new FatalJobError('notFound', `export ${exportId} no longer exists`)
  if (doc.state === 'ready') return
  const scan = await scans.findOne({ _id: doc.scanId })
  if (!scan || scan.state === 'deleting' || scan.state === 'deleted') {
    throw new FatalJobError('scanUnavailable', 'the scan of this export was deleted')
  }
  // Re-checked here: the scan's secret paths are authoritative at run time.
  const fields = validateExportSelection(scan, doc.filter, doc.fields ?? undefined)

  const now = new Date()
  await exports.updateOne({ _id: exportId }, { $set: { state: 'running', error: null, updatedAt: now } })
  await ctx.saveCursor({ afterSeq: doc.afterSeq ?? -1, part: 0 }, { done: 0, total: null })

  const limits = { queryMaxTimeMs: ctx.config.queryMaxTimeMs, queryMaxDocs: ctx.config.queryMaxDocs }
  const collection = await queryAnalysesCollection()
  const counters: ExportCounters = { rows: 0, bytes: 0 }
  const selection = { scan, filter: doc.filter, afterSeq: doc.afterSeq, fields }
  const documents = exportDocuments(selection, doc.format, collection, limits, async ({ afterSeq, maxSeq }) => {
    if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('export job aborted')
    await ctx.saveCursor({ afterSeq, part: 0 }, { done: afterSeq + 1, total: maxSeq + 1 })
  })
  const formatter = createRowFormatter(doc.format, fields, scan)
  try {
    await uploadStream(doc.key, Readable.from(exportLines(documents, formatter, counters)), EXPORT_CONTENT_TYPES[doc.format])
  } catch (error) {
    throw asJobError(error)
  }

  const finished = new Date()
  await exports.updateOne(
    { _id: exportId, state: 'running' },
    { $set: { state: 'ready', rows: counters.rows, bytes: counters.bytes, finishedAt: finished, updatedAt: finished } },
  )
  ctx.log.info('export ready', { exportId, scanId: doc.scanId, rows: counters.rows, bytes: counters.bytes })
}

export const exportJobKind: JobKindDefinition = {
  component: 'reconciler',
  concurrency: EXPORT_JOB_CONCURRENCY,
  perUserConcurrency: (config) => config.userMaxConcurrentQueries,
  maxAttempts: 3,
  handler: runExport,
  async onFailed(job, error) {
    const now = new Date()
    await useCollections().exports.updateOne(
      { _id: String(job.params.exportId), state: { $in: ['queued', 'running'] } },
      { $set: { state: 'failed', error, finishedAt: now, updatedAt: now } },
    )
  },
}
