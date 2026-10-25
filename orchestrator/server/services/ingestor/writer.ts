import {
  type AnyBulkWriteOperation,
  type Collection,
  type Document,
  MongoBulkWriteError,
  MongoError,
  MongoNetworkError,
  MongoNotConnectedError,
  MongoOperationTimeoutError,
  MongoServerClosedError,
  MongoServerSelectionError,
  MongoTopologyClosedError,
  MongoWriteConcernError,
  type WriteError,
} from 'mongodb'
import type { Logger } from '../../utils/logger'
import type { AnalysisWrite } from './build-document'

/*
 * bulkWrite outcome handling (docs/queue.md §6.6):
 *
 *  - one unordered bulkWrite (w: majority) of every guarded upsert;
 *  - per operation, E11000 is a duplicate candidate and any other write error (BSONObjectTooLarge, document too large
 *    after update, BadValue, …) is replaced by the item's minimal failed document;
 *  - one follow-up bulkWrite with the E11000 operations again (unchanged) and the minimal documents: a second E11000
 *    is a final duplicate (this makes the guards correct when two writers race on a missing document), any other
 *    error is logged, counted and acknowledged so the queue never blocks;
 *  - anything that is not a per-operation write error (network, no primary, write concern, timeouts, driver errors)
 *    fails the whole batch: BatchWriteError, and the consumer nacks and backs off. Replays are absorbed by the guards.
 *    The driver reports these wrapped in a MongoBulkWriteError without write errors; `transient` comes from the
 *    wrapped error, and a per-operation error with an availability code (an interrupted write) makes the batch
 *    transient as well.
 */

export interface WriteItem {
  write: AnalysisWrite
  /** the minimal failed document for this item (§6.5), used when its write fails with another error */
  fallback: (reason: string) => AnalysisWrite
}

function storeFailure(message: string): string {
  return `result could not be stored: ${message}`
}

export type ItemResult =
  | { status: 'applied'; write: AnalysisWrite }
  | { status: 'duplicate' }
  | { status: 'writeFailed'; error: string }

/** A failure of the whole bulk write; `transient` tells whether MongoDB itself is unavailable. */
export class BatchWriteError extends Error {
  constructor(
    readonly transient: boolean,
    cause: unknown,
  ) {
    super(`analysis batch write failed: ${(cause as Error | undefined)?.message ?? String(cause)}`, { cause })
    this.name = 'BatchWriteError'
  }
}

const TRANSIENT_CODES = new Set([6, 7, 50, 64, 89, 91, 189, 262, 9001, 10107, 11600, 11602, 13435, 13436])
const TRANSIENT_LABELS = ['RetryableWriteError', 'TransientTransactionError', 'ResetPool', 'SystemOverloadedError']
const DUPLICATE_KEY = 11000

/** The driver types `writeErrors` as one error or a list (OneOrMore), and Array.isArray narrows no readonly list. */
function isList<T>(value: T | readonly T[]): value is readonly T[] {
  return Array.isArray(value)
}

function writeErrorList(error: MongoBulkWriteError): readonly WriteError[] {
  const writeErrors = error.writeErrors
  return isList(writeErrors) ? writeErrors : [writeErrors]
}

/** True when an error says that MongoDB is unavailable rather than that the data is bad. */
export function isTransientMongoError(error: unknown): boolean {
  if (
    error instanceof MongoNetworkError ||
    error instanceof MongoServerSelectionError ||
    error instanceof MongoNotConnectedError ||
    error instanceof MongoTopologyClosedError ||
    error instanceof MongoServerClosedError ||
    error instanceof MongoOperationTimeoutError ||
    error instanceof MongoWriteConcernError
  ) {
    return true
  }
  if (error instanceof MongoBulkWriteError) {
    if (error.result?.getWriteConcernError()) return true
    const writeErrors = writeErrorList(error)
    // bulk.execute wraps every error of the operation itself (server selection, network, timeouts, driver errors) in a
    // MongoBulkWriteError without write errors and keeps the original as errorResponse; classify that one.
    if (writeErrors.length === 0 && error.errorResponse instanceof Error && error.errorResponse !== error) {
      return isTransientMongoError(error.errorResponse)
    }
    // An operation interrupted by a stepdown or shutdown fails per operation, and only the first code is copied up.
    if (writeErrors.some((writeError) => TRANSIENT_CODES.has(writeError.code))) return true
  }
  if (error instanceof MongoError) {
    if (TRANSIENT_LABELS.some((label) => error.hasErrorLabel(label))) return true
    if (typeof error.code === 'number' && TRANSIENT_CODES.has(error.code)) return true
  }
  return false
}

function toOperation(write: AnalysisWrite): AnyBulkWriteOperation<Document> {
  return { updateOne: { filter: write.filter, update: write.update, upsert: true } }
}

/** Per-operation write errors by operation index, or null when the error concerns the whole batch. */
function writeErrorsOf(error: unknown): Map<number, { code: number; message: string }> | null {
  if (!(error instanceof MongoBulkWriteError) || isTransientMongoError(error)) return null
  const errors = writeErrorList(error)
  if (errors.length === 0) return null
  return new Map(errors.map((writeError) => [writeError.index, { code: writeError.code, message: writeError.errmsg ?? 'write error' }]))
}

async function bulkWrite(collection: Collection<Document>, writes: AnalysisWrite[]): Promise<Map<number, { code: number; message: string }>> {
  try {
    await collection.bulkWrite(writes.map(toOperation), { ordered: false, writeConcern: { w: 'majority' } })
    return new Map()
  } catch (error) {
    const perOperation = writeErrorsOf(error)
    if (!perOperation) throw new BatchWriteError(isTransientMongoError(error), error)
    return perOperation
  }
}

/** Writes a batch with the follow-up rules above; throws BatchWriteError for whole-batch failures. */
export async function writeBatch(collection: Collection<Document>, items: readonly WriteItem[], log: Logger): Promise<ItemResult[]> {
  const results: ItemResult[] = items.map((item) => ({ status: 'applied', write: item.write }))
  if (items.length === 0) return results
  const firstErrors = await bulkWrite(collection, items.map((item) => item.write))
  if (firstErrors.size === 0) return results

  // Follow-up: E11000 operations again unchanged, every other failed operation as its minimal failed document.
  const followUp: { index: number; write: AnalysisWrite }[] = []
  for (const [index, error] of firstErrors) {
    const item = items[index]!
    followUp.push({ index, write: error.code === DUPLICATE_KEY ? item.write : item.fallback(storeFailure(error.message)) })
  }
  const secondErrors = await bulkWrite(collection, followUp.map((entry) => entry.write))
  for (const [position, entry] of followUp.entries()) {
    const error = secondErrors.get(position)
    if (!error) {
      results[entry.index] = { status: 'applied', write: entry.write }
    } else if (error.code === DUPLICATE_KEY) {
      results[entry.index] = { status: 'duplicate' }
    } else {
      log.error('analysis write failed in the follow-up; acknowledged without a document', {
        analysisId: entry.write.id,
        code: error.code,
        problem: error.message.slice(0, 500),
      })
      results[entry.index] = { status: 'writeFailed', error: error.message }
    }
  }
  return results
}

/**
 * Isolation mode (docs/queue.md §6.6): one item per bulkWrite. A non-transient failure of the item's own write is
 * recorded with its minimal failed document; if even that fails, the item is acknowledged and logged.
 * Transient failures still fail the batch.
 */
export async function writeIsolated(collection: Collection<Document>, item: WriteItem, log: Logger): Promise<ItemResult> {
  let reason: string
  try {
    return (await writeBatch(collection, [item], log))[0]!
  } catch (error) {
    if (!(error instanceof BatchWriteError) || error.transient) throw error
    log.warn('isolated analysis write failed; recording a minimal failed document', { analysisId: item.write.id, err: error.cause })
    reason = storeFailure((error.cause as Error | undefined)?.message ?? 'write failed')
  }
  const fallback = item.fallback(reason)
  try {
    return (await writeBatch(collection, [{ write: fallback, fallback: () => fallback }], log))[0]!
  } catch (error) {
    if (!(error instanceof BatchWriteError) || error.transient) throw error
    log.error('minimal failed document could not be written; acknowledged without a document', { analysisId: item.write.id, err: error.cause })
    return { status: 'writeFailed', error: (error.cause as Error | undefined)?.message ?? 'write failed' }
  }
}
