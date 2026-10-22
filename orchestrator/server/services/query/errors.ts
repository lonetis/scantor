import { BSON, MongoNetworkError, MongoServerError, MongoServerSelectionError } from 'mongodb'
import { ApiError, apiError } from '../../utils/errors'

// Maps failures of user queries onto the API error model (docs/api.md §1.7): MaxTimeMSExpired is 504
// queryTimeout, memory limits of a sort without disk use are 400 queryRejected at `sort`, other server-side
// rejections of the query (unknown operators, bad expressions, path collisions) are 400 queryRejected, and
// connectivity problems are 503 unavailable.

const MAX_TIME_MS_EXPIRED = 50
const SORT_MEMORY_CODES = new Set([292, 16819, 16820])
/** Server errors that say nothing about the query itself: not primary, interrupted, shutting down, network. */
const TRANSIENT_CODES = new Set([6, 7, 89, 91, 189, 262, 9001, 10107, 11600, 11602, 13435, 13436])
const AUTH_CODES = new Set([13, 18])

export function mapQueryError(error: unknown, inputPath: string): unknown {
  if (error instanceof ApiError) return error
  if (error instanceof MongoNetworkError || error instanceof MongoServerSelectionError) {
    return apiError('unavailable', 'the database is not reachable; retry later')
  }
  if (error instanceof BSON.BSONError) {
    return apiError('queryRejected', `the query cannot be encoded: ${error.message}`, { path: inputPath })
  }
  if (error instanceof MongoServerError) {
    const code = typeof error.code === 'number' ? error.code : -1
    if (code === MAX_TIME_MS_EXPIRED) return apiError('queryTimeout', 'the query exceeded SCANTOR_QUERY_MAX_TIME')
    if (SORT_MEMORY_CODES.has(code)) {
      return apiError('queryRejected', 'the sort exceeds the memory limit; filter further or sort by seq', { path: 'sort', mongoCode: code })
    }
    if (TRANSIENT_CODES.has(code)) return apiError('unavailable', 'the database is temporarily unavailable; retry later')
    if (AUTH_CODES.has(code)) return error
    return apiError('queryRejected', `MongoDB rejected the query: ${error.errmsg ?? error.message}`, { path: inputPath, mongoCode: code })
  }
  return error
}
