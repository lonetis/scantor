import type { Document } from 'mongodb'
import { validationError } from '../../utils/errors'

// `fields` projections of listAnalyses and exports (docs/api.md §4.14, §4.15): dot paths into the Analysis
// representation. The first segment must name a representation field; `id` maps to `_id`; the internal
// `files[].key` can never be selected. Paths inside another selected path are dropped, because MongoDB rejects
// overlapping projections ("path collision").

export const ANALYSIS_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'scanId',
  'userId',
  'seq',
  'round',
  'status',
  'attempt',
  'config',
  'result',
  'error',
  'attempts',
  'files',
  'logTail',
  'timings',
  'workerId',
  'nodeId',
  'executionId',
  'createdAt',
  'updatedAt',
])

/** Validates and de-duplicates representation field paths (400 validationFailed at `issuePath`). */
export function normalizeFieldPaths(paths: readonly string[], issuePath = 'fields'): string[] {
  const issues: { path: string; message: string }[] = []
  for (const path of paths) {
    const segments = path.split('.')
    if (!ANALYSIS_FIELDS.has(segments[0]!)) {
      issues.push({ path: issuePath, message: `unknown field "${segments[0]}"; use one of ${[...ANALYSIS_FIELDS].join(', ')}` })
    } else if (segments[0] === 'files' && segments.slice(1).includes('key')) {
      issues.push({ path: issuePath, message: 'files[].key is internal and cannot be selected' })
    } else if (segments[0] === 'id' && segments.length > 1) {
      issues.push({ path: issuePath, message: 'id has no sub-fields' })
    }
  }
  if (issues.length > 0) throw validationError(issues)
  const unique = [...new Set(paths)]
  return unique.filter((path) => !unique.some((other) => other !== path && path.startsWith(`${other}.`)))
}

/** The MongoDB field path of a representation path (`id` → `_id`). */
export function documentPath(path: string): string {
  return path === 'id' ? '_id' : path
}

/**
 * An inclusion projection for normalized representation paths, always including `_id` and `seq` (row ids, cursors).
 * Selecting `files` keeps the internal keys in the document; toApiDocument removes them.
 */
export function inclusionProjection(paths: readonly string[]): Document {
  const projection: Document = { _id: 1, seq: 1 }
  for (const path of paths) {
    const field = documentPath(path)
    const root = field.split('.')[0]
    if (root === '_id' || root === 'seq') continue
    projection[field] = 1
  }
  return projection
}

/** The value at a dot path of a plain representation object (arrays are addressed by index segments). */
export function valueAtPath(value: unknown, path: string): unknown {
  let node = value
  for (const segment of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

/** A copy of `value` restricted to `paths`, nested like a MongoDB inclusion projection. */
export function pickPaths(value: Record<string, unknown>, paths: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const path of paths) {
    const picked = valueAtPath(value, path)
    if (picked === undefined) continue
    const segments = path.split('.')
    let target = result
    for (const segment of segments.slice(0, -1)) {
      const next = target[segment]
      if (next === null || typeof next !== 'object' || Array.isArray(next)) target[segment] = {}
      target = target[segment] as Record<string, unknown>
    }
    target[segments.at(-1)!] = picked
  }
  return result
}
