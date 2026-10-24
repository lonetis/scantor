import type { Document } from 'mongodb'

// `workers.runtime` is null until the first bootstrap (docs/data-model.md §4.7), and MongoDB cannot `$set` a field
// inside null. Updates of runtime fields therefore use this aggregation expression, which starts from an empty
// runtime object.

const EMPTY_RUNTIME = { version: null, protocolVersion: null, bootstrappedAt: null, lastSeenAt: null, lastError: null, scheduler: null }

/**
 * Pipeline expression: the current `runtime` (or an empty one) with `fields` merged in. Every value is wrapped in
 * `$literal`, because values come from runtime requests (a version header, an error report) and a string starting
 * with "$" would otherwise be read as a field path inside the pipeline.
 */
export function mergeRuntime(fields: Record<string, unknown>): Document {
  const literal = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { $literal: value }]))
  return { $mergeObjects: [{ $ifNull: ['$runtime', EMPTY_RUNTIME] }, literal] }
}
