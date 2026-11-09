import { z } from 'zod'
import { aggregateAnalysesBody, ANALYSIS_ID_PATTERN, isFieldPath, jsonObject, MAX_FIELD_PATHS, MAX_SEQ } from '#shared/schemas/analyses'
import { ANALYSIS_STATUSES, SCRIPT_REPORTED_ERROR_TYPES } from '#shared/utils/enums'

// Request schemas of the script runtime API (`/api/script-runtime/*`, docs/scripts.md, docs/api.md), strict like every
// request schema (docs/api.md §1.5). Sizes that depend on the configuration (SCANTOR_MAX_RESULT_BYTES) or that answer
// 413 instead of 400 (checkpoint state, result) are checked by the routes with jsonByteLength.

/** Largest serialized checkpoint state (413 above it). */
export const SCRIPT_CHECKPOINT_MAX_BYTES = 1024 ** 2
/** Largest serialized config or result schema of `describe`. */
export const SCRIPT_DESCRIBE_SCHEMA_MAX_BYTES = 256 * 1024
export const SCRIPT_PROGRESS_MESSAGE_MAX = 256
export const SCRIPT_ERROR_MESSAGE_MAX = 16 * 1024
export const SCRIPT_ERROR_STACK_MAX = 64 * 1024
export const SCRIPT_OUTPUT_NAME_MAX = 255
/** S3 multipart limits: part numbers and the largest part. */
export const SCRIPT_OUTPUT_MAX_PARTS = 10_000
export const SCRIPT_OUTPUT_MAX_PART_BYTES = 5 * 1024 ** 3

/** UTF-8 bytes of a value serialized as JSON (0 for undefined). */
export function jsonByteLength(value: unknown): number {
  const text = JSON.stringify(value)
  return text === undefined ? 0 : Buffer.byteLength(text, 'utf8')
}

const required = <T extends z.ZodType>(schema: T, what: string) => schema.refine((value) => value !== undefined, `${what} is required`)

const boundedSchema = () =>
  jsonObject()
    .nullable()
    .refine((value) => jsonByteLength(value) <= SCRIPT_DESCRIBE_SCHEMA_MAX_BYTES, `must be at most ${SCRIPT_DESCRIBE_SCHEMA_MAX_BYTES} bytes of JSON`)

const mimeType = () =>
  z
    .string()
    .max(255)
    .regex(/^[\w.+-]+\/[\w.+-]+(\s*;[\x20-\x7e]*)?$/, 'must be a MIME type')

const fieldPath = () => z.string().refine(isFieldPath, 'must be a dot path such as result.title')

// ── params ──────────────────────────────────────────────────────────────────

export const scriptRuntimeScanParams = z.strictObject({ scanId: z.uuid() })

export const scriptRuntimeFileParams = z.strictObject({ analysisId: z.string().regex(ANALYSIS_ID_PATTERN), fileId: z.uuid() })

export const scriptRuntimeOutputParams = z.strictObject({ outputId: z.uuid() })

// ── reading scans ───────────────────────────────────────────────────────────

/**
 * `scriptRuntimeStreamAnalyses`: the analyses of one scan as NDJSON, in seq order after `afterSeq` (and up to `untilSeq`).
 * `fields` absent = the default projection, `'all'` = the full representation; the filter and the fields pass the export
 * rules (allowlist, secret paths).
 */
export const streamAnalysesBody = z
  .strictObject({
    status: z.array(z.enum(ANALYSIS_STATUSES)).min(1).max(ANALYSIS_STATUSES.length).optional(),
    filter: jsonObject().optional(),
    fields: z.union([z.literal('all'), z.array(fieldPath()).min(1).max(MAX_FIELD_PATHS)]).optional(),
    afterSeq: z.number().int().min(-1).max(MAX_SEQ).optional(),
    untilSeq: z.number().int().min(0).max(MAX_SEQ).optional(),
    fileUrls: z.boolean().default(true),
  })
  .refine((body) => body.afterSeq === undefined || body.untilSeq === undefined || body.untilSeq > body.afterSeq, {
    message: 'untilSeq must be greater than afterSeq',
    path: ['untilSeq'],
  })
export type StreamAnalysesBody = z.infer<typeof streamAnalysesBody>

/** `scriptRuntimeAggregate`: the body of aggregateAnalyses. */
export const scriptRuntimeAggregateBody = aggregateAnalysesBody
export type ScriptRuntimeAggregateBody = z.infer<typeof scriptRuntimeAggregateBody>

// ── reporting ───────────────────────────────────────────────────────────────

export const scriptProgressBody = z.strictObject({
  done: z.number().min(0).max(Number.MAX_SAFE_INTEGER),
  total: z.number().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  message: z.string().max(SCRIPT_PROGRESS_MESSAGE_MAX).nullable().optional(),
})
export type ScriptProgressBody = z.infer<typeof scriptProgressBody>

/** `scriptRuntimeCheckpoint`: any JSON value; above SCRIPT_CHECKPOINT_MAX_BYTES serialized the route answers 413. */
export const scriptCheckpointBody = z.strictObject({ state: required(z.unknown(), 'state') })
export type ScriptCheckpointBody = z.infer<typeof scriptCheckpointBody>

export const scriptDescribeBody = z.strictObject({
  configSchema: boundedSchema(),
  resultSchema: boundedSchema(),
})
export type ScriptDescribeBody = z.infer<typeof scriptDescribeBody>

/**
 * `scriptRuntimeFinish`: exactly one of a result (any JSON value, null included; above SCANTOR_MAX_RESULT_BYTES the
 * route answers 413) or the error the script reports itself.
 */
export const scriptFinishBody = z.union([
  z.strictObject({ result: required(z.unknown(), 'result') }),
  z.strictObject({
    error: z.strictObject({
      type: z.enum(SCRIPT_REPORTED_ERROR_TYPES),
      message: z.string().max(SCRIPT_ERROR_MESSAGE_MAX),
      stack: z.string().max(SCRIPT_ERROR_STACK_MAX).optional(),
    }),
  }),
])
export type ScriptFinishBody = z.infer<typeof scriptFinishBody>

// ── outputs ─────────────────────────────────────────────────────────────────

const outputName = () =>
  z
    .string()
    .min(1)
    .max(SCRIPT_OUTPUT_NAME_MAX)
    .refine((name) => !/[\0/\\]/.test(name), 'must not contain NUL, "/" or "\\"')

export const createScriptOutputBody = z.strictObject({
  name: outputName(),
  contentType: mimeType().optional(),
})
export type CreateScriptOutputBody = z.infer<typeof createScriptOutputBody>

const partNumber = () => z.number().int().min(1).max(SCRIPT_OUTPUT_MAX_PARTS)

export const createScriptOutputPartBody = z.strictObject({
  partNumber: partNumber(),
  size: z.number().int().min(1).max(SCRIPT_OUTPUT_MAX_PART_BYTES),
})
export type CreateScriptOutputPartBody = z.infer<typeof createScriptOutputPartBody>

export const completeScriptOutputBody = z
  .strictObject({
    parts: z
      .array(z.strictObject({ partNumber: partNumber(), etag: z.string().min(1).max(256) }))
      .min(1)
      .max(SCRIPT_OUTPUT_MAX_PARTS),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex SHA-256'),
    /** stores the output under this name instead (an interrupted `outputs.open` completes as `<name>.partial`) */
    name: outputName().optional(),
  })
  .refine((body) => new Set(body.parts.map((part) => part.partNumber)).size === body.parts.length, {
    message: 'part numbers must be unique',
    path: ['parts'],
  })
export type CompleteScriptOutputBody = z.infer<typeof completeScriptOutputBody>
