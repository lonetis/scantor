import { z } from 'zod'
import { SCANTOR_ERROR_PHASES, SCANTOR_ERROR_TYPES } from '#shared/utils/enums'
import type { ScantorErrorDoc } from '../../types/documents'

// Request schemas of the runtime API (docs/api.md §8), strict like every request schema (docs/api.md §1.5). They
// mirror the Go wire types of internal/api (types_runtime.go). Sizes follow docs/data-model.md §8.

const SEQ = () => z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const ROUND = () => z.number().int().min(1).max(1_000_000)
const TAIL_HASH = /^sha256:[0-9a-f]{64}$/
const isoTime = () => z.iso.datetime({ offset: true })

/** JSON objects of bounded serialized size (configs, provenance, details). */
const boundedObject = (maxBytes: number) =>
  z.record(z.string(), z.unknown()).refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes, `must be at most ${maxBytes} bytes of JSON`)

export const scantorErrorSchema = z
  .strictObject({
    type: z.enum(SCANTOR_ERROR_TYPES),
    message: z.string().max(4096),
    retryable: z.boolean(),
    phase: z.enum(SCANTOR_ERROR_PHASES),
    attempt: z.number().int().min(0).max(1_000_000),
    stack: z.string().max(16_384).optional(),
    details: boundedObject(4096).optional(),
    at: isoTime(),
  })
  .transform((error): ScantorErrorDoc => ({ ...error, at: new Date(error.at) }))

const busyItem = z.strictObject({
  seq: SEQ(),
  round: ROUND(),
  attempt: z.number().int().min(0).max(1_000_000),
  executionId: z.uuid(),
  startedAt: isoTime(),
  progress: z
    .unknown()
    .optional()
    .refine((value) => value === undefined || Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') <= 4096, 'progress is too large'),
})

export const runtimeStateBody = z.strictObject({
  processes: z.strictObject({ running: z.number().int().min(0).max(100_000), busy: z.number().int().min(0).max(100_000) }),
  busy: z.array(busyItem).max(1024).nullable().transform((value) => (value ?? []).map((item) => ({ ...item, progress: item.progress ?? null }))),
  consuming: z.boolean(),
  clockOffsetMs: z.number().int(),
  tmpFreeBytes: z.number().int().min(0),
  counters: z.record(z.string(), z.number()).optional(),
  scheduler: z
    .strictObject({ published: z.number().int().min(0), confirmed: z.number().int().min(0), nacked: z.number().int().min(0), backpressure: z.boolean() })
    .nullable()
    .optional(),
})

export const presignBody = z.strictObject({
  seq: SEQ(),
  round: ROUND(),
  attempt: z.number().int().min(1).max(1_000_000),
  executionId: z.uuid(),
  files: z
    .array(
      z.strictObject({
        fileId: z.string().max(64),
        name: z
          .string()
          .min(1)
          .max(255)
          .refine((name) => !/[\0/\\]/.test(name), 'must not contain NUL, "/" or "\\"'),
        size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex SHA-256'),
        contentType: z.string().max(255).regex(/^[\w.+-]+\/[\w.+-]+(\s*;[\x20-\x7e]*)?$/, 'must be a MIME type'),
      }),
    )
    .max(100_000),
})

export const analysesStatusBody = z.strictObject({ seqs: z.array(SEQ()).max(1000) })

/** `schedule` for an unwrapped template, `call:<n>` for the n-th wrapped template call (docs/data-model.md §4.5.2). */
const RESOLUTION_KEY = /^(schedule|call:(0|[1-9]\d{0,5}))$/

export const schedulerResolvedBody = z.strictObject({
  epoch: z.number().int().min(0),
  key: z.string().regex(RESOLUTION_KEY, 'must be "schedule" or "call:<n>"'),
  template: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'must be a template name'),
  scanConfig: boundedObject(1024 * 1024),
  provenance: boundedObject(8192),
  expectedTotal: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
})

const checkpointFields = {
  epoch: z.number().int().min(0),
  confirmed: SEQ(),
  tailHash: z.string().regex(TAIL_HASH, 'must be "sha256:<64 hex>"').nullable(),
}

const prefixRule = (value: { confirmed: number; tailHash: string | null }) => (value.confirmed === 0) === (value.tailHash === null)
const PREFIX_MESSAGE = { message: 'tailHash is null exactly when confirmed is 0', path: ['tailHash'] }

export const schedulerCheckpointBody = z.strictObject(checkpointFields).refine(prefixRule, PREFIX_MESSAGE)

export const schedulerDoneBody = z
  .strictObject({
    ...checkpointFields,
    outcome: z.enum(['done', 'failed']),
    error: scantorErrorSchema.nullable().optional(),
  })
  .refine(prefixRule, PREFIX_MESSAGE)
  .refine((value) => value.outcome === 'done' || Boolean(value.error), { message: 'a failed outcome needs an error', path: ['error'] })

export const runtimeErrorBody = z.strictObject({
  fatal: z.boolean(),
  error: scantorErrorSchema,
  context: z.strictObject({ stderrTail: z.string().max(8192).optional() }).nullable().optional(),
})
