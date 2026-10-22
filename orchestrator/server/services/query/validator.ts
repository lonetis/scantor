import { apiError, type ApiError } from '../../utils/errors'

/*
 * The recursive query allowlist of docs/api.md §5.2 and security.md Q-1/Q-2. Every user-supplied filter,
 * projection, sort and aggregation pipeline (queryAnalyses, aggregateAnalyses, inline and background exports)
 * passes through here before it reaches MongoDB:
 *
 *   - pipelines may only use the allowlisted stages, checked recursively inside `$facet` sub-pipelines (a `$facet`
 *     inside a `$facet` is refused, as MongoDB itself refuses it);
 *   - the denylisted operators are rejected as a key at any depth of any input;
 *   - `$sample` sizes are capped, sorts are bounded, nesting depth is bounded.
 *
 * Failures are 400 `queryRejected` with `details.path` naming the offending element (`pipeline.0.$facet.a.0`).
 * The scope (`scanId`, owner) is added afterwards by server/services/query/scope.ts and can never be overridden.
 */

export const ALLOWED_STAGES: ReadonlySet<string> = new Set([
  '$match',
  '$project',
  '$addFields',
  '$set',
  '$unset',
  '$group',
  '$sort',
  '$limit',
  '$skip',
  '$count',
  '$unwind',
  '$bucket',
  '$bucketAuto',
  '$sortByCount',
  '$facet',
  '$replaceRoot',
  '$replaceWith',
  '$sample',
])

export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  '$where',
  '$function',
  '$accumulator',
  '$lookup',
  '$graphLookup',
  '$unionWith',
  '$out',
  '$merge',
  '$documents',
  '$collStats',
  '$indexStats',
  '$currentOp',
  '$listSessions',
  '$planCacheStats',
  '$changeStream',
  '$search',
  '$vectorSearch',
])

export const MAX_SAMPLE_SIZE = 10_000
/** Deepest nesting of objects and arrays in any query input (also bounds recursion). */
export const MAX_NESTING_DEPTH = 48
export const MAX_SORT_KEYS = 8

function rejected(path: string, message: string): ApiError {
  return apiError('queryRejected', message, { path })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function join(path: string, segment: string | number): string {
  return path ? `${path}.${segment}` : String(segment)
}

/** Rejects denylisted keys anywhere in `value`, keys with NUL bytes and excessive nesting. */
function checkValue(value: unknown, path: string, depth: number): void {
  if (depth > MAX_NESTING_DEPTH) throw rejected(path, `nested deeper than ${MAX_NESTING_DEPTH} levels`)
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkValue(item, join(path, index), depth + 1))
    return
  }
  if (!isPlainObject(value)) return
  for (const key of Object.keys(value)) {
    const keyPath = join(path, key)
    if (key.includes('\0')) throw rejected(keyPath, 'keys must not contain NUL characters')
    if (FORBIDDEN_KEYS.has(key)) throw rejected(keyPath, `${key} is not allowed`)
    checkValue(value[key], keyPath, depth + 1)
  }
}

function checkSample(body: unknown, path: string): void {
  if (!isPlainObject(body) || Object.keys(body).length !== 1 || !('size' in body)) {
    throw rejected(path, '$sample takes exactly {size: <integer>}')
  }
  const size = body.size
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > MAX_SAMPLE_SIZE) {
    throw rejected(join(path, 'size'), `$sample size must be an integer from 1 to ${MAX_SAMPLE_SIZE}`)
  }
}

function checkStages(pipeline: unknown, path: string, depth: number, insideFacet = false): void {
  if (depth > MAX_NESTING_DEPTH) throw rejected(path, `nested deeper than ${MAX_NESTING_DEPTH} levels`)
  if (!Array.isArray(pipeline)) throw rejected(path, 'a pipeline must be an array of stages')
  pipeline.forEach((stage, index) => {
    const stagePath = join(path, index)
    if (!isPlainObject(stage)) throw rejected(stagePath, 'a stage must be an object')
    const keys = Object.keys(stage)
    if (keys.length !== 1) throw rejected(stagePath, 'a stage must have exactly one key')
    const name = keys[0]!
    const namePath = join(stagePath, name)
    if (FORBIDDEN_KEYS.has(name) || !ALLOWED_STAGES.has(name)) throw rejected(namePath, `stage ${name} is not allowed`)
    const body = stage[name]
    if (name === '$facet') {
      if (insideFacet) throw rejected(namePath, '$facet is not allowed inside a $facet sub-pipeline')
      if (!isPlainObject(body)) throw rejected(namePath, '$facet takes an object of sub-pipelines')
      for (const [facet, subPipeline] of Object.entries(body)) {
        const facetPath = join(namePath, facet)
        if (facet.includes('\0')) throw rejected(facetPath, 'keys must not contain NUL characters')
        checkStages(subPipeline, facetPath, depth + 2, true)
      }
      return
    }
    if (name === '$sample') checkSample(body, namePath)
    checkValue(body, namePath, depth + 2)
  })
}

/** A `queryAnalyses` or export filter. */
export function validateFilter(filter: Record<string, unknown>, path = 'filter'): void {
  checkValue(filter, path, 0)
}

/** A `queryAnalyses` projection. */
export function validateProjection(projection: Record<string, unknown>, path = 'projection'): void {
  checkValue(projection, path, 0)
}

/** A `queryAnalyses` sort: dot-path keys with 1/-1 values (checked by the request schema), at most MAX_SORT_KEYS. */
export function validateSort(sort: Record<string, unknown>, path = 'sort'): void {
  if (Object.keys(sort).length > MAX_SORT_KEYS) throw rejected(path, `a sort may name at most ${MAX_SORT_KEYS} fields`)
  checkValue(sort, path, 0)
}

/** An `aggregateAnalyses` pipeline. */
export function validatePipeline(pipeline: unknown, path = 'pipeline'): void {
  checkStages(pipeline, path, 0)
}
