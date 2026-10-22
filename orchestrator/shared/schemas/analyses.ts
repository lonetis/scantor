import { z } from 'zod'
import { ANALYSIS_STATUSES, EXPORT_FORMATS, JOB_KINDS, JOB_STATES } from '../utils/enums'
import { pageQueryShape, qBoolean, qInt, qList, userIdFilterShape, waitQueryShape } from './common'

// Request schemas of the results area: tags `analyses`, `exports`/`files` and `jobs` (docs/api.md §4.14–§4.16,
// §5.2). Query documents (filters, projections, pipelines) are accepted as plain JSON objects here and checked by
// the recursive allowlist of server/services/query/validator.ts before they reach MongoDB.

/** Largest analysis seq: 0 ≤ seq < 2^53 (docs/data-model.md §4.6). */
export const MAX_SEQ = Number.MAX_SAFE_INTEGER

export const LIST_ANALYSES_DEFAULT_LIMIT = 50
export const LIST_ANALYSES_MAX_LIMIT = 1000
export const QUERY_DEFAULT_LIMIT = 20
export const QUERY_MAX_LIMIT = 1000
export const MAX_PIPELINE_STAGES = 100
export const MAX_FIELD_PATHS = 64
export const FIELD_PATH_MAX_LENGTH = 256

/** CSV columns when an export names no `fields` (docs/api.md §4.15). */
export const DEFAULT_CSV_COLUMNS = [
  'id',
  'seq',
  'status',
  'attempt',
  'round',
  'error.type',
  'error.message',
  'timings.durationMs',
  'config',
  'result',
] as const

/** `<scanId>-<seq>` (docs/api.md §1.4). */
export const ANALYSIS_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-(0|[1-9]\d{0,15})$/

/**
 * A dot path into an analysis (`result.title`, `error.type`): non-empty segments that do not start with `$` and
 * contain no NUL. Segments are otherwise free-form, because result property names come from user code.
 */
export function isFieldPath(value: string): boolean {
  if (value.length === 0 || value.length > FIELD_PATH_MAX_LENGTH || value.includes('\0')) return false
  return value.split('.').every((segment) => segment.length > 0 && !segment.startsWith('$'))
}

const fieldPath = () => z.string().refine(isFieldPath, 'must be a dot path such as result.title')

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

/**
 * A JSON object passed through unchanged (no copy), so that the query validator sees exactly the keys the client
 * sent, including unusual ones such as `__proto__`.
 */
export const jsonObject = () => z.custom<Record<string, unknown>>(isPlainObject, 'must be a JSON object')

const seqValue = () => z.number().int().min(-1).max(MAX_SEQ)

// ── analyses ────────────────────────────────────────────────────────────────

export const scanResultsParams = z.strictObject({ scanId: z.uuid() })

export const analysisIdParams = z.strictObject({ analysisId: z.string().regex(ANALYSIS_ID_PATTERN) })

export const listAnalysesQuery = z.strictObject({
  status: qList(z.enum(ANALYSIS_STATUSES), ANALYSIS_STATUSES.length).optional(),
  afterSeq: qInt(-1, MAX_SEQ).optional(),
  limit: qInt(1, LIST_ANALYSES_MAX_LIMIT).optional(),
  fields: qList(fieldPath(), MAX_FIELD_PATHS).optional(),
})
export type ListAnalysesQuery = z.infer<typeof listAnalysesQuery>

export const sortDocument = () => z.record(z.string().refine(isFieldPath, 'sort keys must be dot paths'), z.union([z.literal(1), z.literal(-1)]))

export const queryAnalysesBody = z.strictObject({
  filter: jsonObject(),
  projection: jsonObject().optional(),
  sort: sortDocument().optional(),
  limit: z.number().int().min(1).max(QUERY_MAX_LIMIT).default(QUERY_DEFAULT_LIMIT),
  afterSeq: seqValue().optional(),
})
export type QueryAnalysesBody = z.infer<typeof queryAnalysesBody>

export const aggregateAnalysesBody = z.strictObject({
  pipeline: z.array(jsonObject()).max(MAX_PIPELINE_STAGES),
  /** Clamped to SCANTOR_QUERY_MAX_DOCS by the server. */
  limit: z.number().int().min(1).optional(),
})
export type AggregateAnalysesBody = z.infer<typeof aggregateAnalysesBody>

// ── exports and files ───────────────────────────────────────────────────────

export const fileDownloadParams = z.strictObject({ analysisId: z.string().regex(ANALYSIS_ID_PATTERN), fileId: z.uuid() })

export const fileDownloadQuery = z.strictObject({ redirect: qBoolean().default(false) })

export const exportInlineQuery = z.strictObject({
  format: z.enum(EXPORT_FORMATS).default('jsonl'),
  status: qList(z.enum(ANALYSIS_STATUSES), ANALYSIS_STATUSES.length).optional(),
  /** URL-encoded JSON filter (same allowlist as queryAnalyses). */
  filter: z.string().max(65_536).optional(),
  fields: qList(fieldPath(), MAX_FIELD_PATHS).optional(),
  afterSeq: qInt(-1, MAX_SEQ).optional(),
})
export type ExportInlineQuery = z.infer<typeof exportInlineQuery>

export const exportScanBody = z.strictObject({
  format: z.enum(EXPORT_FORMATS),
  filter: jsonObject().optional(),
  fields: z.array(fieldPath()).min(1).max(MAX_FIELD_PATHS).optional(),
  afterSeq: seqValue().optional(),
})
export type ExportScanBody = z.infer<typeof exportScanBody>

export const exportScanQuery = z.strictObject({ ...waitQueryShape })

export const listExportsQuery = z.strictObject({
  ...pageQueryShape,
  scanId: z.uuid().optional(),
})

export const exportIdParams = z.strictObject({ exportId: z.uuid() })

export const getExportQuery = z.strictObject({ ...waitQueryShape })

// ── jobs ────────────────────────────────────────────────────────────────────

export const listJobsQuery = z.strictObject({
  ...pageQueryShape,
  ...userIdFilterShape,
  kind: z.enum(JOB_KINDS).optional(),
  state: z.enum(JOB_STATES).optional(),
})

export const jobIdParams = z.strictObject({ jobId: z.uuid() })

export const getJobQuery = z.strictObject({ ...waitQueryShape })
