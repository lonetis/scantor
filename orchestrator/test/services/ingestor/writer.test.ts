import { type AnyBulkWriteOperation, type Collection, type Document, MongoBulkWriteError, MongoNetworkError } from 'mongodb'
import { describe, expect, it } from 'vitest'
import { buildMinimalFailedWrite, buildSucceededWrite, type WriteTarget } from '../../../server/services/ingestor/build-document'
import type { ResultMessage } from '../../../server/services/ingestor/messages'
import { BatchWriteError, isTransientMongoError, type WriteItem, writeBatch, writeIsolated } from '../../../server/services/ingestor/writer'
import { useLogger } from '../../../server/utils/logger'

// bulkWrite outcome handling (docs/queue.md §6.6): per-operation E11000 retried once in a follow-up, other write
// errors replaced by the minimal failed document, whole-batch failures thrown, isolation mode.

const SCAN = '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f'
const log = useLogger('test')

function item(seq: number): WriteItem {
  const target: WriteTarget = { scanId: SCAN, seq, round: 1, attempt: 1, userId: 'u', now: new Date(0) }
  const message = {
    v: 1,
    kind: 'result',
    analysisId: `${SCAN}-${seq}`,
    scanId: SCAN,
    seq,
    round: 1,
    attempt: 1,
    executionId: 'b2f1c0d9-8e7a-4b6c-9d5e-4f3a2b1c0d9e',
    workerId: 'b2f1c0d9-8e7a-4b6c-9d5e-4f3a2b1c0d9e',
    nodeId: 'b2f1c0d9-8e7a-4b6c-9d5e-4f3a2b1c0d9e',
    config: {},
    status: 'succeeded',
    result: {},
    error: null,
    files: [],
    logTail: '',
    timings: { scheduledAt: 0, startedAt: 0, finishedAt: 0, durationMs: 0 },
  } satisfies ResultMessage
  return { write: buildSucceededWrite(message, target), fallback: (reason) => buildMinimalFailedWrite(target, { reason }) }
}

function bulkError(errors: { index: number; code: number }[], writeConcern = false): MongoBulkWriteError {
  return new MongoBulkWriteError(
    { message: 'bulk write failed', code: errors[0]?.code ?? 0, writeErrors: errors.map((error) => ({ ...error, errmsg: `error ${error.code}` })) } as never,
    { getWriteConcernError: () => (writeConcern ? { code: 64, errmsg: 'waiting for replication timed out' } : undefined) } as never,
  )
}

/** A collection whose successive bulkWrite calls throw the given errors (or succeed with `null`). */
function fakeCollection(outcomes: (Error | null)[]) {
  const calls: AnyBulkWriteOperation<Document>[][] = []
  const collection = {
    async bulkWrite(operations: AnyBulkWriteOperation<Document>[], options: { ordered?: boolean; writeConcern?: { w?: unknown } }) {
      expect(options.ordered).toBe(false)
      expect(options.writeConcern?.w).toBe('majority')
      calls.push(operations)
      const outcome = outcomes.shift() ?? null
      if (outcome) throw outcome
      return {}
    },
  }
  return { collection: collection as unknown as Collection<Document>, calls }
}

function setStatus(operation: AnyBulkWriteOperation<Document>): unknown {
  const update = (operation as { updateOne: { update: { $set: { status: string; error?: unknown } } } }).updateOne.update
  return update.$set.status
}

describe('writeBatch', () => {
  it('applies a clean batch with one unordered majority bulkWrite of upserts', async () => {
    const { collection, calls } = fakeCollection([null])
    const results = await writeBatch(collection, [item(0), item(1)], log)
    expect(results.map((result) => result.status)).toEqual(['applied', 'applied'])
    expect(calls).toHaveLength(1)
    expect((calls[0]![0] as { updateOne: { upsert: boolean } }).updateOne.upsert).toBe(true)
  })

  it('retries E11000 once and replaces other write errors by the minimal failed document', async () => {
    const { collection, calls } = fakeCollection([bulkError([{ index: 0, code: 11000 }, { index: 2, code: 2 }]), bulkError([{ index: 0, code: 11000 }])])
    const results = await writeBatch(collection, [item(0), item(1), item(2)], log)
    expect(results[0]).toEqual({ status: 'duplicate' })
    expect(results[1]!.status).toBe('applied')
    expect(results[2]).toMatchObject({ status: 'applied', write: { minimal: true } })
    expect(calls[1]).toHaveLength(2)
    expect(setStatus(calls[1]![0]!)).toBe('succeeded')
    expect(setStatus(calls[1]![1]!)).toBe('failed')
  })

  it('applies an E11000 operation whose retry succeeds (two writers raced on a new document)', async () => {
    const { collection } = fakeCollection([bulkError([{ index: 0, code: 11000 }]), null])
    expect((await writeBatch(collection, [item(0)], log))[0]!.status).toBe('applied')
  })

  it('acknowledges a document that fails again in the follow-up', async () => {
    const { collection } = fakeCollection([bulkError([{ index: 0, code: 10334 }]), bulkError([{ index: 0, code: 17419 }])])
    expect((await writeBatch(collection, [item(0)], log))[0]).toMatchObject({ status: 'writeFailed' })
  })

  it('fails the whole batch on network errors and write concern errors', async () => {
    const network = fakeCollection([new MongoNetworkError('connection reset')])
    await expect(writeBatch(network.collection, [item(0)], log)).rejects.toSatisfy(
      (error: unknown) => error instanceof BatchWriteError && error.transient,
    )
    const concern = fakeCollection([bulkError([{ index: 0, code: 11000 }], true)])
    await expect(writeBatch(concern.collection, [item(0)], log)).rejects.toSatisfy(
      (error: unknown) => error instanceof BatchWriteError && error.transient,
    )
    const other = fakeCollection([new Error('driver bug')])
    await expect(writeBatch(other.collection, [item(0)], log)).rejects.toSatisfy(
      (error: unknown) => error instanceof BatchWriteError && !error.transient,
    )
  })
})

describe('writeIsolated', () => {
  it('records the minimal failed document when the single write fails as a whole', async () => {
    const { collection, calls } = fakeCollection([new Error('unknown poison'), null])
    const result = await writeIsolated(collection, item(0), log)
    expect(result).toMatchObject({ status: 'applied', write: { minimal: true } })
    expect(calls).toHaveLength(2)
  })

  it('acknowledges without a document when even the minimal document fails', async () => {
    const { collection } = fakeCollection([new Error('unknown poison'), new Error('still failing')])
    expect((await writeIsolated(collection, item(0), log)).status).toBe('writeFailed')
  })

  it('still throws transient failures', async () => {
    const { collection } = fakeCollection([new MongoNetworkError('down')])
    await expect(writeIsolated(collection, item(0), log)).rejects.toBeInstanceOf(BatchWriteError)
  })
})

describe('isTransientMongoError', () => {
  it('classifies availability errors only', () => {
    expect(isTransientMongoError(new MongoNetworkError('x'))).toBe(true)
    expect(isTransientMongoError(bulkError([{ index: 0, code: 11000 }]))).toBe(false)
    expect(isTransientMongoError(new Error('x'))).toBe(false)
  })
})
