import { describe, expect, it } from 'vitest'
import { authenticateResultMessage, MAX_BODY_BYTES, scanIdOfUserId } from '../../../server/services/ingestor/identity'
import { checkAttemptMessage, checkResultMessage } from '../../../server/services/ingestor/messages'
import { readRepoFile } from '../../helpers/repo'

// Checks 1–3 of docs/queue.md §6.2 (security.md ING-1, ING-2): identity only from the AMQP user_id, the body must
// agree with it, and seq/round/attempt/kind must be well-formed. Check 6 validates against the shared schemas.

const SCAN = '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f'
const OTHER = '11111111-2222-4333-8444-555555555555'

function delivery(body: unknown, options: { userId?: unknown; routingKey?: string; raw?: Buffer } = {}) {
  const content = options.raw ?? Buffer.from(JSON.stringify(body))
  return {
    content,
    fields: { routingKey: options.routingKey ?? SCAN } as never,
    properties: { userId: 'userId' in options ? options.userId : `scan-${SCAN}` } as never,
  }
}

const valid = { scanId: SCAN, analysisId: `${SCAN}-7`, seq: 7, round: 1, attempt: 1, kind: 'result' }

describe('authenticateResultMessage', () => {
  it('accepts a consistent message and takes the scan from user_id', () => {
    const result = authenticateResultMessage(delivery(valid))
    expect(result).toMatchObject({ ok: true, message: { scanId: SCAN, seq: 7, round: 1, attempt: 1, kind: 'result' } })
  })

  const rejections: [string, ReturnType<typeof delivery>, string][] = [
    ['missing user_id', delivery(valid, { userId: undefined }), 'missingUserId'],
    ['admin user_id', delivery(valid, { userId: 'scantor' }), 'invalidUserId'],
    ['uppercase scan id', delivery(valid, { userId: `scan-${SCAN.toUpperCase()}` }), 'invalidUserId'],
    ['routing key of another scan', delivery(valid, { routingKey: OTHER }), 'routingKeyMismatch'],
    ['body claiming another scan', delivery({ ...valid, scanId: OTHER, analysisId: `${OTHER}-7` }), 'scanIdMismatch'],
    ['analysisId of another seq', delivery({ ...valid, analysisId: `${SCAN}-8` }), 'analysisIdMismatch'],
    ['negative seq', delivery({ ...valid, seq: -1, analysisId: `${SCAN}--1` }), 'invalidSeq'],
    ['fractional seq', delivery({ ...valid, seq: 1.5, analysisId: `${SCAN}-1.5` }), 'invalidSeq'],
    ['seq above 2^53', delivery({ ...valid, seq: 2 ** 53, analysisId: `${SCAN}-${2 ** 53}` }), 'invalidSeq'],
    ['string seq', delivery({ ...valid, seq: '7' }), 'invalidSeq'],
    ['round 0', delivery({ ...valid, round: 0 }), 'invalidRound'],
    ['attempt 0', delivery({ ...valid, attempt: 0 }), 'invalidAttempt'],
    ['unknown kind', delivery({ ...valid, kind: 'analysis' }), 'invalidKind'],
    ['array body', delivery([valid]), 'notAnObject'],
    ['invalid JSON', delivery(null, { raw: Buffer.from('{"scanId":') }), 'invalidJson'],
    ['invalid UTF-8', delivery(null, { raw: Buffer.from([0x7b, 0xff, 0x7d]) }), 'invalidUtf8'],
    ['oversized body', delivery(null, { raw: Buffer.alloc(MAX_BODY_BYTES + 1, 0x20) }), 'bodyTooLarge'],
  ]
  for (const [name, message, reason] of rejections) {
    it(`rejects ${name}`, () => {
      expect(authenticateResultMessage(message)).toEqual({ ok: false, reason })
    })
  }
})

describe('scanIdOfUserId', () => {
  it('parses only scan-<lowercase uuid>', () => {
    expect(scanIdOfUserId(`scan-${SCAN}`)).toBe(SCAN)
    expect(scanIdOfUserId(`scan-${SCAN}x`)).toBeNull()
    expect(scanIdOfUserId(SCAN)).toBeNull()
    expect(scanIdOfUserId(42)).toBeNull()
  })
})

describe('message schemas (check 6)', () => {
  const resultSchema = JSON.parse(readRepoFile('schemas/messages/result.schema.json')) as { examples: unknown[] }
  const attemptSchema = JSON.parse(readRepoFile('schemas/messages/attempt.schema.json')) as { examples: unknown[] }

  it('accepts the schema examples', () => {
    for (const example of resultSchema.examples) expect(checkResultMessage(example).ok).toBe(true)
    for (const example of attemptSchema.examples) expect(checkAttemptMessage(example).ok).toBe(true)
  })

  it('reports the first schema error for unknown fields and inconsistent outcomes', () => {
    const example = resultSchema.examples[0] as Record<string, unknown>
    const extra = checkResultMessage({ ...example, userId: 'x' })
    expect(extra.ok).toBe(false)
    const inconsistent = checkResultMessage({ ...example, status: 'failed' })
    expect(inconsistent.ok).toBe(false)
    if (!inconsistent.ok) expect(inconsistent.error.length).toBeGreaterThan(0)
  })
})
