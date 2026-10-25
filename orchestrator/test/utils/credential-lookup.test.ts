import { APIError } from 'better-auth/api'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Session and API key lookups (docs/auth.md §5.2): a rejected credential is no session, a failed lookup is 503.

const getSession = vi.fn()
vi.mock('../../server/utils/auth', () => ({ useAuth: () => ({ api: { getSession } }) }))

const { isCredentialRejection, lookupSession } = await import('../../server/utils/credential-lookup')
const { principalFromApiKey } = await import('../../server/services/mcp/auth')

const KEY = `sk_scantor_${'A'.repeat(64)}`

beforeEach(() => {
  getSession.mockReset()
})

describe('isCredentialRejection', () => {
  it('is true only for 4xx APIErrors', () => {
    expect(isCredentialRejection(new APIError('UNAUTHORIZED', { message: 'Invalid API key' }))).toBe(true)
    expect(isCredentialRejection(new APIError('FORBIDDEN'))).toBe(true)
    expect(isCredentialRejection(new APIError('INTERNAL_SERVER_ERROR', { message: 'Failed to get session' }))).toBe(false)
    expect(isCredentialRejection(new Error('connection pool closed'))).toBe(false)
    expect(isCredentialRejection(null)).toBe(false)
  })
})

describe('lookupSession', () => {
  it('returns the session and the response headers', async () => {
    const headers = new Headers({ 'set-cookie': 'x=1' })
    getSession.mockResolvedValue({ response: { session: { id: 's', createdAt: new Date() }, user: { id: 'u' } }, headers })
    const { result, headers: returned } = await lookupSession(new Headers({ cookie: 'c=1' }))
    expect(result?.user).toEqual({ id: 'u' })
    expect(returned).toBe(headers)
    expect(getSession).toHaveBeenCalledWith(expect.objectContaining({ returnHeaders: true }))
  })

  it('is no session when better-auth finds none or rejects the credential', async () => {
    getSession.mockResolvedValueOnce({ response: null })
    expect((await lookupSession(new Headers({ cookie: 'c=1' }))).result).toBeNull()
    getSession.mockRejectedValueOnce(new APIError('UNAUTHORIZED', { message: 'Invalid API key' }))
    expect((await lookupSession(new Headers({ 'x-api-key': KEY }))).result).toBeNull()
  })

  it('answers 503 unavailable when the lookup itself fails', async () => {
    for (const failure of [new APIError('INTERNAL_SERVER_ERROR', { message: 'Failed to get session' }), new Error('not primary')]) {
      getSession.mockRejectedValueOnce(failure)
      await expect(lookupSession(new Headers({ cookie: 'c=1' }))).rejects.toMatchObject({ code: 'unavailable', statusCode: 503 })
    }
  })
})

describe('principalFromApiKey (/mcp)', () => {
  it('is null for a rejected key and throws unavailable for a failed lookup', async () => {
    getSession.mockRejectedValueOnce(new APIError('UNAUTHORIZED', { message: 'Invalid API key' }))
    expect(await principalFromApiKey(KEY)).toBeNull()
    getSession.mockRejectedValueOnce(new Error('server selection timed out'))
    await expect(principalFromApiKey(KEY)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('resolves a valid key to a write principal', async () => {
    getSession.mockResolvedValueOnce({
      response: { session: { id: 'key-1', createdAt: new Date() }, user: { id: 'u', email: 'u@x.test', name: 'U', role: 'user', banned: false } },
    })
    expect(await principalFromApiKey(KEY)).toMatchObject({
      via: 'mcp',
      user: { id: 'u' },
      apiKey: { id: 'key-1', configId: 'default' },
      mcp: { level: 'write' },
    })
  })
})
