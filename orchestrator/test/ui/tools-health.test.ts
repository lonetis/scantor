import { describe, expect, it } from 'vitest'
import { healthAnswerError, isHealthReport } from '../../app/composables/useTools'

// The health card of /admin/tools (docs/ui.md §5.20): getHealth is read without failing on 503, because that answer
// carries a full report while MongoDB is down; every other answer must become "Health could not be loaded".

const report = {
  status: 'degraded',
  version: 'dev',
  components: { mongo: { status: 'down' }, rabbitmq: { status: 'ok' }, s3: { status: 'ok' }, registry: { status: 'ok' } },
  alarms: [],
}

describe('isHealthReport', () => {
  it('accepts a report, also a degraded one', () => {
    expect(isHealthReport(report)).toBe(true)
  })

  it('rejects error envelopes, proxy pages and empty answers', () => {
    expect(isHealthReport({ error: { code: 'internal', message: 'boom' } })).toBe(false)
    expect(isHealthReport('Bad Gateway')).toBe(false)
    expect(isHealthReport(undefined)).toBe(false)
    expect(isHealthReport({ ...report, alarms: undefined })).toBe(false)
  })
})

describe('healthAnswerError', () => {
  it('keeps the code and message of an error envelope', () => {
    const error = healthAnswerError({ error: { code: 'internal', message: 'Unexpected server error' } })
    expect(error.code).toBe('internal')
    expect(error.message).toBe('Unexpected server error')
  })

  it('explains an answer that is no JSON report', () => {
    expect(healthAnswerError('Bad Gateway').message).toBe('The orchestrator answered without a health report.')
  })
})
