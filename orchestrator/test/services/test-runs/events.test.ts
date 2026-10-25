import { describe, expect, it } from 'vitest'
import { acceptedFiles, analysisFromResult, configIssueMessage, type LocalEvent, MAX_ATTEMPT_LOG_TAIL_BYTES, MAX_LOG_TAIL_BYTES, parseLocalEvent, resultSeqAccepted } from '../../../server/services/test-runs/events'

// Local-mode events (docs/runtime.md §15.3) mapped onto testRunAnalyses (docs/data-model.md §4.4).

const FILE_ID = '2f6c1d3e-5a7b-4c8d-9e0f-1a2b3c4d5e6f'
const OTHER_ID = '3f6c1d3e-5a7b-4c8d-9e0f-1a2b3c4d5e6f'
const SHA = 'a'.repeat(64)

describe('parseLocalEvent', () => {
  it('accepts the event types of local mode only', () => {
    expect(parseLocalEvent('{"type":"start","at":"2026-10-21T09:10:01.020Z"}')?.type).toBe('start')
    expect(parseLocalEvent('{"type":"result","seq":"0"}')).toBeNull()
    expect(parseLocalEvent('{"type":"other"}')).toBeNull()
    expect(parseLocalEvent('garbage')).toBeNull()
  })
})

describe('analysisFromResult', () => {
  it('builds the document with masked secrets and Date timings', () => {
    const event = parseLocalEvent(
      JSON.stringify({
        type: 'result',
        at: '2026-10-21T09:10:01.071Z',
        seq: 2,
        status: 'succeeded',
        attempt: 1,
        config: { target: 'x', token: 's3cret' },
        result: { text: 'Hi', key: 'k' },
        error: null,
        files: [{ id: FILE_ID, name: 'a.png', size: 3, sha256: SHA, contentType: 'image/png', path: `files/2/${FILE_ID}/a.png` }],
        logTail: '[info] hi\n',
        attempts: [],
        timings: { scheduledAt: '2026-10-21T09:10:01.030Z', startedAt: '2026-10-21T09:10:01.031Z', finishedAt: '2026-10-21T09:10:01.071Z', durationMs: 40 },
      }),
    )
    if (event?.type !== 'result') throw new Error('expected a result event')
    const expiresAt = new Date('2026-10-28T00:00:00Z')
    const now = new Date('2026-10-21T09:10:02Z')
    const doc = analysisFromResult(event, { testRunId: 'tr', userId: 'u', expiresAt, now, maxFiles: 100, maxResultBytes: 1024 ** 2, maxConfigBytes: 64 * 1024, secretPaths: { analysisConfig: ['/token'], result: ['/key'] } })
    expect(doc).toMatchObject({
      _id: 'tr-2',
      testRunId: 'tr',
      userId: 'u',
      seq: 2,
      status: 'succeeded',
      config: { target: 'x', token: '***' },
      result: { text: 'Hi', key: '***' },
      error: null,
      files: [{ id: FILE_ID, name: 'a.png', size: 3, sha256: SHA, contentType: 'image/png' }],
      logTail: '[info] hi\n',
      expiresAt,
    })
    expect(doc.timings?.durationMs).toBe(40)
    expect(doc.timings?.startedAt).toEqual(new Date('2026-10-21T09:10:01.031Z'))
    expect(doc.files[0]).not.toHaveProperty('path')
  })

  it('keeps the error of a failed analysis and drops its result', () => {
    const event = parseLocalEvent(
      JSON.stringify({ type: 'result', at: '2026-10-21T09:10:01.071Z', seq: 0, status: 'failed', attempt: 1, config: {}, result: { leaked: true }, error: { type: 'fatal', message: 'boom', retryable: false, phase: 'run', attempt: 1, at: '2026-10-21T09:10:01.070Z' }, files: [], logTail: '', attempts: [], timings: {} }),
    )
    if (event?.type !== 'result') throw new Error('expected a result event')
    const doc = analysisFromResult(event, { testRunId: 'tr', userId: 'u', expiresAt: new Date(), now: new Date(), maxFiles: 100, maxResultBytes: 1024 ** 2, maxConfigBytes: 64 * 1024, secretPaths: { analysisConfig: [], result: [] } })
    expect(doc.result).toBeNull()
    expect(doc.error).toMatchObject({ type: 'fatal', message: 'boom', retryable: false, phase: 'run', attempt: 1 })
  })
})

describe('bounds of untrusted local-mode results', () => {
  const ctx = { testRunId: 'tr', userId: 'u', expiresAt: new Date(), now: new Date(), maxFiles: 100, maxResultBytes: 100, maxConfigBytes: 50, secretPaths: { analysisConfig: [], result: [] } }
  const result = (overrides: Record<string, unknown>) =>
    ({ type: 'result', at: '2026-10-21T09:10:01.071Z', seq: 1, status: 'succeeded', attempt: 1, config: {}, result: {}, error: null, files: [], logTail: '', attempts: [], timings: {}, ...overrides }) as unknown as Extract<LocalEvent, { type: 'result' }>

  it('keeps one result per seq below the limit', () => {
    expect(resultSeqAccepted(0, 5, new Set())).toBe(true)
    expect(resultSeqAccepted(4, 5, new Set())).toBe(true)
    expect(resultSeqAccepted(5, 5, new Set())).toBe(false)
    expect(resultSeqAccepted(-1, 5, new Set())).toBe(false)
    expect(resultSeqAccepted(2, 5, new Set([2]))).toBe(false)
  })

  it('fails an analysis whose result exceeds SCANTOR_MAX_RESULT_BYTES and drops an oversized config', () => {
    const doc = analysisFromResult(result({ result: { blob: 'x'.repeat(200) }, config: { big: 'y'.repeat(100) } }), ctx)
    expect(doc.status).toBe('failed')
    expect(doc.result).toBeNull()
    expect(doc.error).toMatchObject({ type: 'validation', phase: 'ingest', retryable: false, attempt: 1 })
    expect(doc.error?.message).toContain('above SCANTOR_MAX_RESULT_BYTES (100 bytes)')
    expect(doc).not.toHaveProperty('config')
  })

  it('bounds log tails, error details and attempts, and ignores fields of the wrong type', () => {
    const doc = analysisFromResult(
      result({
        status: 'failed',
        logTail: 'é'.repeat(MAX_LOG_TAIL_BYTES),
        error: { type: 'fatal', message: 'boom', details: { blob: 'z'.repeat(20_000) } },
        attempts: [...Array.from({ length: 12 }, (_, index) => ({ attempt: index + 1, logTail: 'a'.repeat(10_000) })), 'garbage'],
        result: ['not', 'an', 'object'],
      }),
      ctx,
    )
    expect(Buffer.byteLength(doc.logTail ?? '')).toBeLessThanOrEqual(MAX_LOG_TAIL_BYTES)
    expect(doc.logTail?.startsWith('é')).toBe(true)
    expect(doc.error).toMatchObject({ type: 'fatal', message: 'boom' })
    expect(doc.error).not.toHaveProperty('details')
    expect(doc.attempts).toHaveLength(9)
    expect(doc.attempts.every((attempt) => (attempt.logTail ?? '').length <= MAX_ATTEMPT_LOG_TAIL_BYTES)).toBe(true)
    expect(analysisFromResult(result({ attempts: 'nope', error: 'nope' }), ctx)).toMatchObject({ attempts: [], error: null })
  })
})

describe('acceptedFiles', () => {
  const resultWith = (files: unknown[]) =>
    ({ type: 'result', at: '2026-10-21T09:10:01.071Z', seq: 4, status: 'succeeded', attempt: 1, config: {}, result: {}, error: null, files, logTail: '', attempts: [], timings: {} }) as unknown as Extract<LocalEvent, { type: 'result' }>
  const file = (overrides: Record<string, unknown> = {}) => ({ id: FILE_ID, name: 'report.json', size: 10, sha256: SHA, contentType: 'application/json', path: `files/4/${FILE_ID}/report.json`, ...overrides })

  it('keeps well-formed files with the path the runtime writes', () => {
    expect(acceptedFiles(resultWith([file(), file({ id: OTHER_ID, name: 'a b.png', contentType: 'image/png', path: `files/4/${OTHER_ID}/a_b.png` })]), 100)).toEqual([
      { ref: { id: FILE_ID, name: 'report.json', size: 10, sha256: SHA, contentType: 'application/json' }, path: `files/4/${FILE_ID}/report.json` },
      { ref: { id: OTHER_ID, name: 'a b.png', size: 10, sha256: SHA, contentType: 'image/png' }, path: `files/4/${OTHER_ID}/a_b.png` },
    ])
  })

  it('drops ids that are no uuid v4 or repeat, which would steer the S3 key', () => {
    const traversal = `../../${OTHER_ID}/files/0/x`
    expect(acceptedFiles(resultWith([file({ id: traversal, path: `files/4/${traversal}/report.json` })]), 100)).toEqual([])
    expect(acceptedFiles(resultWith([file({ id: 'f1?x#y', path: 'files/4/f1?x#y/report.json' })]), 100)).toEqual([])
    expect(acceptedFiles(resultWith([file(), file()]), 100)).toHaveLength(1)
  })

  it('drops files whose path, name, size, hash or content type is malformed', () => {
    for (const overrides of [
      { path: `files/3/${FILE_ID}/report.json` },
      { path: `files/4/${FILE_ID}/../../etc` },
      { name: 'a/b', path: `files/4/${FILE_ID}/a_b` },
      { name: '' },
      { size: -1 },
      { size: '10' },
      { sha256: 'ab' },
      { contentType: 'not a type' },
    ]) {
      expect(acceptedFiles(resultWith([file(overrides)]), 100), JSON.stringify(overrides)).toEqual([])
    }
    expect(acceptedFiles(resultWith(['x', null, 3] as unknown[]), 100)).toEqual([])
  })

  it('keeps at most maxFiles files', () => {
    expect(acceptedFiles(resultWith([file(), file({ id: OTHER_ID, path: `files/4/${OTHER_ID}/report.json` })]), 1)).toHaveLength(1)
  })
})

describe('configIssueMessage', () => {
  it('formats config issues as in docs/tasks.md §11.1', () => {
    expect(configIssueMessage({ path: '/taskConfig/greeting', message: 'must be string' })).toBe('taskConfig /greeting: must be string')
    expect(configIssueMessage({ path: '/scanConfig', message: 'must be object' })).toBe('scanConfig: must be object')
    expect(configIssueMessage({ path: '', message: 'no schemas' })).toBe('no schemas')
  })
})
