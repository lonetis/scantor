import { apiError, validationError } from '../../utils/errors'
import { SCRIPT_CHECKPOINT_MAX_BYTES } from './schemas'

// Fixed limits and intervals of the script runtime API (docs/scripts.md). The configurable ones
// (SCANTOR_MAX_RESULT_BYTES, SCANTOR_SCRIPT_RUN_MAX_OUTPUTS, SCANTOR_SCRIPT_RUN_MAX_OUTPUT_BYTES) come from the
// configuration; bootstrap hands all of them to the script.

/**
 * Validity of the presigned GETs of stored files and outputs. They are signed for SCANTOR_S3_INTERNAL_URL, which only
 * the master's containers reach (security.md), and a consumer may lag behind the stream by many minutes.
 */
export const FILE_URL_TTL_SECONDS = 3600
/** Recommended part size of output uploads (S3 requires at least 5 MiB for every part but the last). */
export const OUTPUT_PART_BYTES = 16 * 1024 ** 2
/** Analysis streams and aggregations one run may have open at once in one orchestrator process (429 beyond). */
export const MAX_READS_PER_RUN = 4
/** At most one progress write per run per interval; the latest value in between is held in memory. */
export const PROGRESS_WRITE_INTERVAL_MS = 1000
/** At most one checkpoint write per run per interval; the latest value in between is held in memory. */
export const CHECKPOINT_WRITE_INTERVAL_MS = 10_000
/** Longest silence of an analysis stream: a checkpoint line keeps the connection alive and marks the resume point. */
export const STREAM_KEEPALIVE_MS = 10_000
/** Nesting depth of a stored checkpoint or result (BSON allows 100 levels including the run document's own). */
export const MAX_STORED_JSON_DEPTH = 64

export { SCRIPT_CHECKPOINT_MAX_BYTES }

/** 413 payloadTooLarge when a serialized value exceeds `limit` bytes. */
export function assertJsonSize(bytes: number, limit: number, what: string): void {
  if (bytes > limit) throw apiError('payloadTooLarge', `${what} is ${bytes} bytes of JSON; at most ${limit} are allowed`, { limit, size: bytes })
}

/**
 * 400 validationFailed when a JSON value cannot be stored in MongoDB as it is: keys that start with `$` or contain
 * NUL, or nesting deeper than MAX_STORED_JSON_DEPTH.
 */
export function assertStorableJson(value: unknown, path: string): void {
  const problem = storageProblem(value, 0)
  if (problem) throw validationError([{ path, message: problem }])
}

function storageProblem(value: unknown, depth: number): string | null {
  if (value === null || typeof value !== 'object') return null
  if (depth >= MAX_STORED_JSON_DEPTH) return `must be nested at most ${MAX_STORED_JSON_DEPTH} levels deep`
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = storageProblem(item, depth + 1)
      if (problem) return problem
    }
    return null
  }
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith('$')) return `object keys must not start with "$" (found "${key.slice(0, 64)}")`
    if (key.includes('\0')) return 'object keys must not contain NUL'
    const problem = storageProblem(item, depth + 1)
    if (problem) return problem
  }
  return null
}
