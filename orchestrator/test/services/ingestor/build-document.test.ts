import { describe, expect, it } from 'vitest'
import {
  ATTEMPT_LOG_TAIL_BYTES,
  type AnalysisWrite,
  buildAttemptWrite,
  buildDeadLetterWrite,
  buildFailedWrite,
  buildMinimalFailedWrite,
  buildSucceededWrite,
  headBytes,
  tailBytes,
  type WriteTarget,
} from '../../../server/services/ingestor/build-document'
import type { AttemptMessage, ResultMessage } from '../../../server/services/ingestor/messages'
import { matches } from '../../helpers/fake-collection'

// The ingestor's document builder (docs/queue.md §6.5, docs/data-model.md §6.3, security.md ING-2): guarded upserts
// built field by field, the guard semantics per message kind, recomputed file keys and the minimal failed document.

const SCAN = '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f'
const USER = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const EXECUTION = 'b2f1c0d9-8e7a-4b6c-9d5e-4f3a2b1c0d9e'
const WORKER = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const NODE = '2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a'
const FILE = 'e0c4b2a1-9f8e-4d7c-8b6a-5f4e3d2c1b0a'
const NOW = new Date('2026-10-21T10:00:00.000Z')

function target(overrides: Partial<WriteTarget> = {}): WriteTarget {
  return { scanId: SCAN, seq: 7, round: 1, attempt: 1, userId: USER, now: NOW, ...overrides }
}

const timings = { scheduledAt: 1761040805000, startedAt: 1761040896000, finishedAt: 1761040897200, durationMs: 1200 }

function result(overrides: Partial<ResultMessage> = {}): ResultMessage {
  return {
    v: 1,
    kind: 'result',
    analysisId: `${SCAN}-7`,
    scanId: SCAN,
    seq: 7,
    round: 1,
    attempt: 1,
    executionId: EXECUTION,
    workerId: WORKER,
    nodeId: NODE,
    config: { origin: 'https://example.org' },
    status: 'succeeded',
    result: { title: 'Example' },
    error: null,
    files: [],
    logTail: 'log',
    timings,
    ...overrides,
  }
}

function attempt(overrides: Partial<AttemptMessage> = {}): AttemptMessage {
  return {
    v: 1,
    kind: 'attempt',
    analysisId: `${SCAN}-7`,
    scanId: SCAN,
    seq: 7,
    round: 1,
    attempt: 1,
    executionId: EXECUTION,
    workerId: WORKER,
    nodeId: NODE,
    config: { origin: 'https://example.org' },
    error: { type: 'timeout', message: 'run exceeded 30000 ms', retryable: true, phase: 'run', attempt: 1, at: 1761040890000 },
    logTail: 'attempt log',
    timings,
    ...overrides,
  }
}

const failedError = { type: 'taskError', message: 'boom', retryable: false, phase: 'run', attempt: 1, at: 1761040990000 } as const

/** True when the guarded upsert applies to an existing document (otherwise MongoDB answers E11000). */
function applies(write: AnalysisWrite, existing: Record<string, unknown>): boolean {
  return matches({ _id: `${SCAN}-7`, scanId: SCAN, ...existing }, write.filter)
}

describe('guarded upserts', () => {
  it('filter on _id and scanId taken from the target only', () => {
    const forged = result({ scanId: '11111111-1111-4111-8111-111111111111', analysisId: '11111111-1111-4111-8111-111111111111-7' })
    for (const write of [buildSucceededWrite(forged, target()), buildFailedWrite(result({ status: 'failed', result: null, error: failedError }), target()), buildAttemptWrite(attempt(), target())]) {
      expect(write.filter._id).toBe(`${SCAN}-7`)
      expect(write.filter.scanId).toBe(SCAN)
      expect(write.id).toBe(`${SCAN}-7`)
    }
  })

  it('a success replaces pending, retrying, failed, lost and cancelled of the same round and anything of older rounds', () => {
    const write = buildSucceededWrite(result(), target({ round: 2 }))
    for (const status of ['pending', 'retrying', 'failed', 'lost', 'cancelled']) expect(applies(write, { round: 2, status })).toBe(true)
    expect(applies(write, { round: 2, status: 'succeeded' })).toBe(false)
    expect(applies(write, { round: 1, status: 'succeeded' })).toBe(true)
    expect(applies(write, { round: 3, status: 'pending' })).toBe(false)
  })

  it('a failure never replaces a terminal result of the same round, except lost and cancelled', () => {
    const write = buildFailedWrite(result({ status: 'failed', result: null, error: failedError }), target())
    for (const status of ['pending', 'retrying', 'lost', 'cancelled']) expect(applies(write, { round: 1, status })).toBe(true)
    for (const status of ['failed', 'succeeded']) expect(applies(write, { round: 1, status })).toBe(false)
  })

  it('an attempt event applies only to pending/retrying with a lower attempt, or older rounds', () => {
    const write = buildAttemptWrite(attempt({ attempt: 2 }), target({ attempt: 2 }))
    expect(applies(write, { round: 1, status: 'retrying', attempt: 1 })).toBe(true)
    expect(applies(write, { round: 1, status: 'pending', attempt: 0 })).toBe(true)
    expect(applies(write, { round: 1, status: 'retrying', attempt: 2 })).toBe(false)
    expect(applies(write, { round: 1, status: 'retrying', attempt: 3 })).toBe(false)
    expect(applies(write, { round: 1, status: 'succeeded', attempt: 1 })).toBe(false)
    expect(applies(write, { round: 1, status: 'failed', attempt: 1 })).toBe(false)
  })

  it('builds the succeeded document field by field and recomputes file keys', () => {
    const message = result({
      files: [{ id: FILE, name: '../../etc/passwd', size: 3, sha256: 'a'.repeat(64), contentType: 'text/plain' }],
    })
    // A hostile body may carry extra top-level keys; they must never reach the update.
    const hostile = { ...message, userId: 'attacker', $set: { userId: 'attacker' }, round: 1 } as ResultMessage
    const write = buildSucceededWrite(hostile, target())
    const set = write.update.$set as Record<string, unknown>
    expect(Object.keys(write.update).sort()).toEqual(['$push', '$set', '$setOnInsert', '$unset'])
    expect(Object.keys(set).sort()).toEqual(
      ['attempt', 'config', 'executionId', 'files', 'logTail', 'nodeId', 'result', 'round', 'seq', 'status', 'timings', 'updatedAt', 'workerId'].sort(),
    )
    expect(write.update.$setOnInsert).toEqual({ userId: USER, createdAt: NOW })
    expect(write.update.$unset).toEqual({ error: '' })
    expect(set.status).toBe('succeeded')
    expect(set.files).toEqual([
      { id: FILE, name: '../../etc/passwd', size: 3, sha256: 'a'.repeat(64), contentType: 'text/plain', key: `files/${SCAN}/7/${EXECUTION}/${FILE}/.._.._etc_passwd` },
    ])
    expect(set.timings).toEqual({
      scheduledAt: new Date(timings.scheduledAt),
      startedAt: new Date(timings.startedAt),
      finishedAt: new Date(timings.finishedAt),
      durationMs: 1200,
    })
    const push = write.update.$push as { attempts: { $each: Record<string, unknown>[]; $slice: number } }
    expect(push.attempts.$slice).toBe(-10)
    expect(push.attempts.$each[0]).toMatchObject({ attempt: 1, round: 1, executionId: EXECUTION, error: null, logTail: 'log' })
    expect(write.outcome).toBe('succeeded')
    expect(write.minimal).toBe(false)
  })

  it('stores the failure and unsets a previous result', () => {
    const write = buildFailedWrite(result({ status: 'failed', result: null, error: { ...failedError, stack: 'trace', details: { code: 1 } } }), target())
    const set = write.update.$set as Record<string, unknown>
    expect(set.status).toBe('failed')
    expect(set.files).toEqual([])
    expect(set.error).toEqual({ type: 'taskError', message: 'boom', retryable: false, phase: 'run', attempt: 1, at: new Date(1761040990000), stack: 'trace', details: { code: 1 } })
    expect(write.update.$unset).toEqual({ result: '' })
  })

  it('keeps only the last 4 KiB of an attempt log tail and leaves logTail of the document alone', () => {
    const write = buildAttemptWrite(attempt({ logTail: 'x'.repeat(5000) }), target())
    const set = write.update.$set as Record<string, unknown>
    expect(set.status).toBe('retrying')
    expect('logTail' in set).toBe(false)
    const entry = (write.update.$push as { attempts: { $each: { logTail: string }[] } }).attempts.$each[0]!
    expect(Buffer.byteLength(entry.logTail)).toBe(ATTEMPT_LOG_TAIL_BYTES)
  })
})

describe('minimal failed document', () => {
  it('omits config, truncates the reason to 1 KiB and stores only a uuid execution id', () => {
    const write = buildMinimalFailedWrite(target({ attempt: 3 }), { reason: 'r'.repeat(5000), executionId: 'not-a-uuid' })
    const set = write.update.$set as Record<string, unknown>
    expect(Object.keys(set).sort()).toEqual(['attempt', 'error', 'files', 'round', 'seq', 'status', 'updatedAt'])
    expect(set.error).toMatchObject({ type: 'platform', phase: 'ingest', retryable: false, attempt: 3, at: NOW })
    expect(Buffer.byteLength((set.error as { message: string }).message)).toBe(1024)
    expect(write.update.$unset).toEqual({ result: '', logTail: '' })
    const entry = (write.update.$push as { attempts: { $each: Record<string, unknown>[] } }).attempts.$each[0]!
    expect('executionId' in entry).toBe(false)
    expect(write.minimal).toBe(true)
    expect(write.outcome).toBe('failed')
    expect(applies(write, { round: 1, status: 'succeeded' })).toBe(false)
  })

  it('keeps a valid execution id and can record a validation failure', () => {
    const write = buildMinimalFailedWrite(target(), { reason: 'too large', type: 'validation', executionId: EXECUTION.toUpperCase() })
    expect((write.update.$set as { error: { type: string } }).error.type).toBe('validation')
    const entry = (write.update.$push as { attempts: { $each: Record<string, unknown>[] } }).attempts.$each[0]!
    expect(entry.executionId).toBe(EXECUTION)
  })
})

describe('dead-lettered analyses', () => {
  const analysis = { v: 1 as const, analysisId: `${SCAN}-7`, scanId: SCAN, seq: 7, round: 1, attempt: 2, config: { origin: 'x' }, scheduledAt: 1761040805000 }

  it('records a delivery-limit death as a crash with the broker headers', () => {
    const write = buildDeadLetterWrite(analysis, target({ attempt: 2 }), { reason: 'delivery_limit', queue: `scantor.scan.${SCAN}`, deliveryCount: 11, acquiredCount: 11 }, 10)
    const set = write.update.$set as { error: Record<string, unknown>; config: unknown; status: string; logTail: string }
    expect(set.status).toBe('failed')
    expect(set.config).toEqual({ origin: 'x' })
    expect(set.logTail).toBe('')
    expect(set.error).toMatchObject({
      type: 'crash',
      phase: 'run',
      retryable: false,
      attempt: 2,
      message: 'every worker that received this analysis died while processing it (delivered 11 times, delivery limit 10)',
      details: { deathReason: 'delivery_limit', deathQueue: `scantor.scan.${SCAN}`, deliveryCount: 11, acquiredCount: 11 },
    })
    // The failed-result guard: a real result of a duplicate execution is never overwritten.
    expect(applies(write, { round: 1, status: 'succeeded' })).toBe(false)
    expect(applies(write, { round: 1, status: 'retrying' })).toBe(true)
  })

  it('records other dead-letter reasons as platform failures', () => {
    const write = buildDeadLetterWrite(analysis, target(), { reason: 'rejected', queue: `scantor.scan.${SCAN}`, deliveryCount: 1, acquiredCount: 1 }, 10)
    expect((write.update.$set as { error: Record<string, unknown> }).error).toMatchObject({ type: 'platform', phase: 'platform', message: 'dead-lettered (rejected)' })
  })
})

describe('byte-bounded strings', () => {
  it('never splits a multi-byte character', () => {
    const text = `${'é'.repeat(10)}` // 20 bytes
    expect(tailBytes(text, 5)).toBe('éé')
    expect(headBytes(text, 5)).toBe('éé')
    expect(tailBytes('short', 100)).toBe('short')
    expect(headBytes('short', 100)).toBe('short')
  })
})
