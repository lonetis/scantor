import { createError, H3Error } from 'h3'
import { describe, expect, it } from 'vitest'
import { ERROR_CODES } from '#shared/utils/error-codes'
import { apiError, invalidState, normalizeError } from '../../server/utils/errors'
import { usesErrorEnvelope } from '../../server/utils/error-handler'

// The error envelope of docs/api.md §1.7.

describe('apiError', () => {
  it.each(Object.entries(ERROR_CODES))('%s carries HTTP %o', (code, { status }) => {
    const error = apiError(code as keyof typeof ERROR_CODES, 'message')
    expect(error.statusCode).toBe(status)
    expect(normalizeError(error).body).toEqual({ error: { code, message: 'message' } })
  })

  it('formats invalidState with the current and allowed states', () => {
    const error = invalidState('scan', 'completed', ['running'], 'pause')
    expect(error.message).toBe('scan is completed; pause requires running')
    expect(normalizeError(error).body.error.details).toEqual({ state: 'completed', allowed: ['running'] })
  })
})

describe('normalizeError', () => {
  it('keeps details and adds the request id to 500s only', () => {
    expect(normalizeError(apiError('notFound', 'x', { a: 1 }), 'req-1').body).toEqual({ error: { code: 'notFound', message: 'x', details: { a: 1 } } })
    expect(normalizeError(apiError('internal', 'boom'), 'req-1').body.error.details).toEqual({ requestId: 'req-1' })
  })

  it('maps foreign HTTP errors by status', () => {
    expect(normalizeError(createError({ statusCode: 404, statusMessage: 'Not Found' })).body.error.code).toBe('notFound')
    expect(normalizeError(createError({ statusCode: 413 })).body.error.code).toBe('payloadTooLarge')
    expect(normalizeError(createError({ statusCode: 503, message: 'down' }))).toMatchObject({ status: 503, body: { error: { code: 'unavailable' } } })
  })

  it('unwraps ApiErrors wrapped by h3', () => {
    const wrapped = new H3Error('wrapped', { cause: apiError('banned', 'nope') })
    expect(normalizeError(wrapped).body.error.code).toBe('banned')
  })

  it('never leaks internal messages', () => {
    const result = normalizeError(new Error('connection string mongodb://user:pw@host'), 'req-9')
    expect(result).toEqual({
      status: 500,
      body: { error: { code: 'internal', message: 'unexpected server error', details: { requestId: 'req-9' } } },
      unexpected: true,
    })
  })

  it('uses the envelope for /api, /mcp and discovery only', () => {
    expect(usesErrorEnvelope('/api/scans')).toBe(true)
    expect(usesErrorEnvelope('/api')).toBe(true)
    expect(usesErrorEnvelope('/mcp')).toBe(true)
    expect(usesErrorEnvelope('/.well-known/oauth-protected-resource/mcp')).toBe(true)
    expect(usesErrorEnvelope('/scans/abc')).toBe(false)
    expect(usesErrorEnvelope('/apiary')).toBe(false)
  })
})
