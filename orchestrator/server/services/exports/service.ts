import { randomUUID } from 'node:crypto'
import type { Collection, Filter } from 'mongodb'
import type { ExportScanBody } from '#shared/schemas/analyses'
import type { Page } from '#shared/types/common'
import type { Export } from '#shared/types/exports'
import type { ExportFormat } from '#shared/utils/enums'
import type { ExportDoc, JobDoc, ScanDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import { apiError, invalidState } from '../../utils/errors'
import { cancelActiveJobs, createJob } from '../../utils/jobs'
import { useCollections } from '../../utils/mongo'
import { findPage, type PageOptions } from '../../utils/pagination'
import { deleteObject, isS3NotFound, presignDownload } from '../../utils/s3'
import { isoDate, isoDateOrNull } from '../../utils/serialize'
import { normalizeFieldPaths } from '../analyses/fields'
import { analysisSecretSegments } from '../analyses/masking'
import { assertNoSecretReference } from '../query/secrets'
import { validateFilter } from '../query/validator'

// Background exports (docs/api.md §4.15, docs/data-model.md §4.14, §6.9): an `exports` document plus an `export`
// job that writes `exports/<userId>/<exportId>.<format>` to S3. Exports inherit the owner of their scan. A ready
// export carries a presigned download (10 minutes, attachment), created anew for every representation.

export function exportKey(userId: string, exportId: string, format: ExportFormat): string {
  return `exports/${userId}/${exportId}.${format}`
}

/** The download file name: `scantor-<scanId>-<first 8 of exportId>.<format>`. */
export function exportFileName(doc: Pick<ExportDoc, '_id' | 'scanId' | 'format'>): string {
  return `scantor-${doc.scanId}-${doc._id.slice(0, 8)}.${doc.format}`
}

export async function toApiExport(doc: ExportDoc): Promise<Export> {
  const representation: Export = {
    id: doc._id,
    userId: doc.userId,
    scanId: doc.scanId,
    format: doc.format,
    filter: doc.filter,
    fields: doc.fields,
    afterSeq: doc.afterSeq,
    state: doc.state,
    bytes: doc.bytes,
    rows: doc.rows,
    error: doc.error,
    jobId: doc.jobId,
    createdAt: isoDate(doc.createdAt),
    finishedAt: isoDateOrNull(doc.finishedAt),
    updatedAt: isoDate(doc.updatedAt),
    expiresAt: isoDate(doc.expiresAt),
  }
  if (doc.state === 'ready') {
    const { url, expiresAt } = await presignDownload({
      key: doc.key,
      name: exportFileName(doc),
      contentType: 'application/octet-stream',
    })
    representation.download = { url, expiresAt: isoDate(expiresAt) }
  }
  return representation
}

/** `wait` on exportScan and getExport settles when the export is `ready` or `failed` (docs/api.md §1.9). */
export function exportSettled(doc: Pick<ExportDoc, 'state'>): boolean {
  return doc.state === 'ready' || doc.state === 'failed'
}

/**
 * Re-reads an export during a wait. A document that disappeared meanwhile (deleted, expired by TTL) is 404, like
 * any other export that does not exist.
 */
export async function loadExportForWait(doc: Pick<ExportDoc, '_id'>, exports: Collection<ExportDoc> = useCollections().exports): Promise<ExportDoc> {
  const current = await exports.findOne({ _id: doc._id })
  if (!current) throw apiError('notFound', 'export not found')
  return current
}

/** Validates an export selection against the query allowlist and the scan's secret paths. */
export function validateExportSelection(
  scan: Pick<ScanDoc, 'secretPaths'>,
  filter: Record<string, unknown>,
  fields: readonly string[] | undefined,
): string[] | null {
  validateFilter(filter)
  assertNoSecretReference(filter, analysisSecretSegments(scan.secretPaths), { keysAreReferences: true }, 'filter')
  return fields ? normalizeFieldPaths(fields) : null
}

const UNEXPORTABLE_STATES = ['deleting', 'deleted'] as const

export function assertExportable(scan: Pick<ScanDoc, 'state'>): void {
  if ((UNEXPORTABLE_STATES as readonly string[]).includes(scan.state)) {
    throw invalidState('scan', scan.state, ['creating', 'running', 'paused', 'completed', 'failed', 'cancelled'], 'an export')
  }
}

/** exportScan: inserts the export `queued` and its job. */
export async function createExport(
  scan: ScanDoc,
  body: ExportScanBody,
  config: Pick<Config, 'exportRetentionDays'>,
  exports: Collection<ExportDoc> = useCollections().exports,
): Promise<ExportDoc> {
  assertExportable(scan)
  const filter = body.filter ?? {}
  const fields = validateExportSelection(scan, filter, body.fields)
  const now = new Date()
  const id = randomUUID()
  const doc: ExportDoc = {
    _id: id,
    userId: scan.userId,
    scanId: scan._id,
    format: body.format,
    filter,
    fields,
    afterSeq: body.afterSeq ?? null,
    state: 'queued',
    key: exportKey(scan.userId, id, body.format),
    bytes: 0,
    rows: 0,
    error: null,
    // Set right after the job exists; the job reads only the export id.
    jobId: '',
    createdAt: now,
    finishedAt: null,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + config.exportRetentionDays * 86_400_000),
  }
  await exports.insertOne(doc)
  let job: JobDoc
  try {
    ;({ job } = await createJob({ kind: 'export', userId: scan.userId, subject: { kind: 'export', id }, params: { exportId: id } }))
  } catch (error) {
    // Without its job the export would stay queued forever.
    await exports.deleteOne({ _id: id }).catch(() => undefined)
    throw error
  }
  await exports.updateOne({ _id: id }, { $set: { jobId: job._id } })
  doc.jobId = job._id
  return doc
}

export async function listExports(
  owner: { userId?: string },
  scanId: string | undefined,
  options: PageOptions,
  exports: Collection<ExportDoc> = useCollections().exports,
): Promise<Page<Export>> {
  const clauses: Filter<ExportDoc>[] = [owner]
  if (scanId) clauses.push({ scanId: scanId.toLowerCase() })
  return findPage(exports, { $and: clauses }, options, toApiExport)
}

/** deleteExport: the S3 object (if written), then the document; a running export job is cancelled first. */
export async function deleteExport(doc: ExportDoc, exports: Collection<ExportDoc> = useCollections().exports): Promise<void> {
  await cancelActiveJobs('export', doc._id)
  try {
    await deleteObject(doc.key)
  } catch (error) {
    if (!isS3NotFound(error)) throw error
  }
  const result = await exports.deleteOne({ _id: doc._id })
  if (result.deletedCount === 0) throw apiError('notFound', 'export not found')
}
