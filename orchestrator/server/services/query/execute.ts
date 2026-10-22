import type { Collection, Document, FindCursor, AggregationCursor } from 'mongodb'
import type { AggregateAnalysesBody, QueryAnalysesBody } from '#shared/schemas/analyses'
import type { AnalysisAggregateResult, AnalysisQueryResult } from '#shared/types/analyses'
import type { ScanDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import { COLLECTION_NAMES, useQueryMongo } from '../../utils/mongo'
import { analysisMaskPatterns, analysisSecretSegments } from '../analyses/masking'
import { toApiDocument } from '../analyses/representation'
import { mapQueryError } from './errors'
import { assertNoSecretReference, secretUnsetPaths } from './secrets'
import { scopedFilter, scopeStage } from './scope'
import { validateFilter, validatePipeline, validateProjection, validateSort } from './validator'

/*
 * queryAnalyses and aggregateAnalyses (docs/api.md §4.14, §5.2, security.md Q-1…Q-6). Inputs pass the allowlist and
 * the secret-reference check, are scoped to the scan and its owner, and run on the read-only `scantor_query`
 * client with maxTimeMS = SCANTOR_QUERY_MAX_TIME, no disk use, at most SCANTOR_QUERY_MAX_DOCS documents and a
 * streamed byte cap. Query results are masked; aggregations drop secret paths before user stages run.
 */

/** Streamed response cap of one query or aggregation (serialized JSON of the returned items). */
export const QUERY_MAX_RESPONSE_BYTES = 16 * 1024 * 1024

export type QueryLimits = Pick<Config, 'queryMaxTimeMs' | 'queryMaxDocs'>

export type QueryScan = Pick<ScanDoc, '_id' | 'userId' | 'secretPaths'>

/** The analyses collection of the `scantor_query` client. */
export async function queryAnalysesCollection(): Promise<Collection<Document>> {
  const { db } = await useQueryMongo()
  return db.collection(COLLECTION_NAMES.analyses)
}

function seqOfId(id: unknown): number | null {
  if (typeof id !== 'string') return null
  const seq = Number(id.slice(id.lastIndexOf('-') + 1))
  return Number.isSafeInteger(seq) ? seq : null
}

/**
 * The projection to run: the client's projection with `_id` kept, because `nextCursor` comes from the seq in `_id`.
 * `excludeId` tells whether `id` must be removed from the items again.
 */
export function cursorProjection(projection: Record<string, unknown> | undefined): { projection?: Document; excludeId: boolean } {
  if (!projection) return { excludeId: false }
  const idValue = projection._id
  if (idValue !== 0 && idValue !== false) return { projection, excludeId: false }
  const rest: Document = {}
  for (const [key, value] of Object.entries(projection)) if (key !== '_id') rest[key] = value
  return Object.keys(rest).length === 0 ? { excludeId: true } : { projection: rest, excludeId: true }
}

async function closeQuietly(cursor: FindCursor | AggregationCursor): Promise<void> {
  await cursor.close().catch(() => undefined)
}

/** The allowlist and secret-reference checks of a queryAnalyses body (400 queryRejected with `details.path`). */
export function checkQueryInput(scan: Pick<QueryScan, 'secretPaths'>, body: Pick<QueryAnalysesBody, 'filter' | 'projection' | 'sort'>): void {
  validateFilter(body.filter)
  if (body.projection) validateProjection(body.projection)
  if (body.sort) validateSort(body.sort)
  const secrets = analysisSecretSegments(scan.secretPaths)
  assertNoSecretReference(body.filter, secrets, { keysAreReferences: true }, 'filter')
  if (body.sort) assertNoSecretReference(body.sort, secrets, { keysAreReferences: true }, 'sort')
  if (body.projection) assertNoSecretReference(body.projection, secrets, { keysAreReferences: false }, 'projection')
}

/** The allowlist and secret-reference checks of an aggregateAnalyses pipeline (400 queryRejected). */
export function checkPipelineInput(scan: Pick<QueryScan, 'secretPaths'>, pipeline: unknown): void {
  validatePipeline(pipeline)
  assertNoSecretReference(pipeline, analysisSecretSegments(scan.secretPaths), { keysAreReferences: true }, 'pipeline')
}

/** The pipeline that runs for a user pipeline: scope first, internal and secret fields removed, a final $limit. */
export function scopedPipeline(scan: QueryScan, pipeline: readonly Document[], limit: number): Document[] {
  const secrets = analysisSecretSegments(scan.secretPaths)
  return [scopeStage(scan), { $unset: ['files.key', ...secretUnsetPaths(secrets)] }, ...pipeline, { $limit: limit + 1 }]
}

export async function queryAnalyses(
  scan: QueryScan,
  body: QueryAnalysesBody,
  limits: QueryLimits,
  collection?: Collection<Document>,
): Promise<AnalysisQueryResult> {
  checkQueryInput(scan, body)

  const clauses: Document[] = [body.filter]
  if (body.afterSeq !== undefined) clauses.push({ seq: { $gt: body.afterSeq } })
  const limit = Math.min(body.limit, limits.queryMaxDocs)
  const { projection, excludeId } = cursorProjection(body.projection)
  const patterns = analysisMaskPatterns(scan.secretPaths)
  const analyses = collection ?? (await queryAnalysesCollection())

  const items: Record<string, unknown>[] = []
  let lastSeq: number | null = null
  let more = false
  let bytes = 0
  const cursor = analyses.find(scopedFilter(scan, ...clauses), {
    projection,
    sort: body.sort ?? { seq: 1 },
    limit: limit + 1,
    maxTimeMS: limits.queryMaxTimeMs,
    allowDiskUse: false,
  })
  try {
    for await (const doc of cursor) {
      if (items.length >= limit) {
        more = true
        break
      }
      const item = toApiDocument(doc, patterns)
      bytes += Buffer.byteLength(JSON.stringify(item))
      if (bytes > QUERY_MAX_RESPONSE_BYTES && items.length > 0) {
        more = true
        break
      }
      lastSeq = seqOfId(doc._id)
      if (excludeId) delete item.id
      items.push(item)
    }
  } catch (error) {
    throw mapQueryError(error, 'filter')
  } finally {
    await closeQuietly(cursor)
  }
  const nextCursor = !body.sort && more && lastSeq !== null ? String(lastSeq) : null
  return { items, nextCursor }
}

export async function aggregateAnalyses(
  scan: QueryScan,
  body: AggregateAnalysesBody,
  limits: QueryLimits,
  collection?: Collection<Document>,
): Promise<AnalysisAggregateResult> {
  checkPipelineInput(scan, body.pipeline)
  const limit = Math.min(body.limit ?? limits.queryMaxDocs, limits.queryMaxDocs)
  const pipeline = scopedPipeline(scan, body.pipeline, limit)
  const analyses = collection ?? (await queryAnalysesCollection())
  const items: Record<string, unknown>[] = []
  let truncated = false
  let bytes = 0
  const cursor = analyses.aggregate(pipeline, { maxTimeMS: limits.queryMaxTimeMs, allowDiskUse: false })
  try {
    for await (const doc of cursor) {
      if (items.length >= limit) {
        truncated = true
        break
      }
      bytes += Buffer.byteLength(JSON.stringify(doc))
      if (bytes > QUERY_MAX_RESPONSE_BYTES && items.length > 0) {
        truncated = true
        break
      }
      items.push(doc as Record<string, unknown>)
    }
  } catch (error) {
    throw mapQueryError(error, 'pipeline')
  } finally {
    await closeQuietly(cursor)
  }
  return { items, truncated }
}
