import { describe, expect, it } from 'vitest'
import { ApiError, errorIssues, errorMessage, errorTitle, toApiError } from '../../app/utils/errors'

function response(status: number, requestId: string | null = null) {
  return { status, headers: { get: (name: string) => (name.toLowerCase() === 'x-request-id' ? requestId : null) } }
}

describe('toApiError (docs/ui.md §8)', () => {
  it('converts the scantor error envelope', () => {
    const error = toApiError({
      response: response(409, 'req-1'),
      data: { error: { code: 'invalidState', message: 'scan is completed; pause requires running', details: { state: 'completed', allowed: ['running'] } } },
    })
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 409, code: 'invalidState', message: 'scan is completed; pause requires running', requestId: 'req-1' })
    expect(error.details).toEqual({ state: 'completed', allowed: ['running'] })
  })

  it('derives a code from the status for non-envelope bodies (better-auth, text)', () => {
    expect(toApiError({ response: response(429), data: { message: 'Too many requests. Please try again later.' } }))
      .toMatchObject({ code: 'tooManyRequests', message: 'Too many requests. Please try again later.' })
    expect(toApiError({ response: response(502), data: '<html>' })).toMatchObject({ code: 'internal', message: 'Unexpected server error' })
  })

  it('treats a missing response as a network error', () => {
    const error = toApiError(new TypeError('fetch failed'))
    expect(error.isNetworkError).toBe(true)
    expect(error.status).toBe(0)
    expect(errorTitle(error.code)).toBe('Cannot reach the orchestrator')
  })

  it('passes ApiError instances through', () => {
    const error = new ApiError({ status: 404, code: 'notFound', message: 'gone' })
    expect(toApiError(error)).toBe(error)
  })
})

describe('error helpers', () => {
  it('titles codes from the shared table', () => {
    expect(errorTitle('invalidState')).toBe('Not possible in the current state')
    expect(errorTitle('notFound')).toBe('Not found')
    expect(errorTitle('brokerAlarm')).toBe('The message broker is out of resources')
    expect(errorTitle('somethingNew')).toBe('Request failed')
  })

  it('extracts validation issues', () => {
    const error = new ApiError({ status: 422, code: 'configInvalid', message: 'x', details: { issues: [{ path: '/taskConfig/a', message: 'bad' }, 'junk'] } })
    expect(errorIssues(error)).toEqual([{ path: '/taskConfig/a', message: 'bad' }])
  })

  it('builds inline messages', () => {
    expect(errorMessage(new ApiError({ status: 400, code: 'badRequest', message: '' }))).toBe('Bad request')
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('weird', 'fallback')).toBe('fallback')
  })
})
