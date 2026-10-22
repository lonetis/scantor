import { describe, expect, it } from 'vitest'
import { analysisFromResult, configIssueMessage, parseLocalEvent } from '../../../server/services/test-runs/events'

// Local-mode events (docs/runtime.md §15.3) mapped onto testRunAnalyses (docs/data-model.md §4.4).

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
        files: [{ id: 'f1', name: 'a.png', size: 3, sha256: 'ab', contentType: 'image/png', path: 'files/2/f1/a.png' }],
        logTail: '[info] hi\n',
        attempts: [],
        timings: { scheduledAt: '2026-10-21T09:10:01.030Z', startedAt: '2026-10-21T09:10:01.031Z', finishedAt: '2026-10-21T09:10:01.071Z', durationMs: 40 },
      }),
    )
    if (event?.type !== 'result') throw new Error('expected a result event')
    const expiresAt = new Date('2026-10-28T00:00:00Z')
    const now = new Date('2026-10-21T09:10:02Z')
    const doc = analysisFromResult(event, { testRunId: 'tr', userId: 'u', expiresAt, now, secretPaths: { analysisConfig: ['/token'], result: ['/key'] } })
    expect(doc).toMatchObject({
      _id: 'tr-2',
      testRunId: 'tr',
      userId: 'u',
      seq: 2,
      status: 'succeeded',
      config: { target: 'x', token: '***' },
      result: { text: 'Hi', key: '***' },
      error: null,
      files: [{ id: 'f1', name: 'a.png', size: 3, sha256: 'ab', contentType: 'image/png' }],
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
    const doc = analysisFromResult(event, { testRunId: 'tr', userId: 'u', expiresAt: new Date(), now: new Date(), secretPaths: { analysisConfig: [], result: [] } })
    expect(doc.result).toBeNull()
    expect(doc.error).toMatchObject({ type: 'fatal', message: 'boom', retryable: false, phase: 'run', attempt: 1 })
  })
})

describe('configIssueMessage', () => {
  it('formats config issues as in docs/tasks.md §11.1', () => {
    expect(configIssueMessage({ path: '/taskConfig/greeting', message: 'must be string' })).toBe('taskConfig /greeting: must be string')
    expect(configIssueMessage({ path: '/scanConfig', message: 'must be object' })).toBe('scanConfig: must be object')
    expect(configIssueMessage({ path: '', message: 'no schemas' })).toBe('no schemas')
  })
})
