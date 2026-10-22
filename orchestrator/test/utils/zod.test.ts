import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, createRouter, defineEventHandler, send, setResponseStatus, toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { pageQuery, qBoolean, qList } from '#shared/schemas/common'
import { normalizeError } from '../../server/utils/errors'
import { parseOrThrow, validateBody, validateParams, validateQuery, zodIssues } from '../../server/utils/zod'

// The request validation helpers of docs/api.md §1.5, exercised through a real h3 app.

const body = z.strictObject({ name: z.string().min(1).max(8), count: z.number().int().default(1) })
const params = z.strictObject({ id: z.uuid() })
const query = z.strictObject({ ...pageQuery.shape, enabled: qBoolean().optional(), tags: qList(z.enum(['a', 'b'])).optional() })

let server: Server
let base: string

beforeAll(async () => {
  const app = createApp({
    onError: async (error, event) => {
      const normalized = normalizeError(error)
      setResponseStatus(event, normalized.status)
      await send(event, JSON.stringify(normalized.body), 'application/json')
    },
  })
  app.use(
    defineEventHandler((event) => {
      event.context.bodyLimit = 64
    }),
  )
  const router = createRouter()
  router.post('/body', defineEventHandler((event) => validateBody(event, body)))
  router.get('/items/:id', defineEventHandler((event) => validateParams(event, params)))
  router.get('/query', defineEventHandler((event) => validateQuery(event, query)))
  app.use(router)
  server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
})

async function call(path: string, init?: RequestInit): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}${path}`, init)
  return { status: response.status, json: await response.json() }
}

function post(payload: string, contentType = 'application/json') {
  return call('/body', { method: 'POST', headers: { 'content-type': contentType }, body: payload })
}

describe('validateBody', () => {
  it('parses a valid body and applies defaults', async () => {
    expect(await post('{"name":"echo"}')).toEqual({ status: 200, json: { name: 'echo', count: 1 } })
  })

  it('reports schema failures as validationFailed with issues', async () => {
    const result = await post('{"name":"","extra":1,"other":2}')
    expect(result.status).toBe(400)
    expect(result.json).toEqual({
      error: {
        code: 'validationFailed',
        message: 'request validation failed',
        details: {
          issues: [
            { path: 'name', message: expect.any(String) },
            { path: 'extra', message: 'unknown field' },
            { path: 'other', message: 'unknown field' },
          ],
        },
      },
    })
  })

  it('validates a missing body as an empty object', async () => {
    const result = await call('/body', { method: 'POST' })
    expect(result.status).toBe(400)
    expect((result.json as { error: { details: { issues: { path: string }[] } } }).error.details.issues[0]!.path).toBe('name')
  })

  it('answers 400 badRequest for malformed JSON', async () => {
    expect((await post('{"name":')).json).toMatchObject({ error: { code: 'badRequest' } })
  })

  it('answers 415 for another content type', async () => {
    const result = await post('name=echo', 'application/x-www-form-urlencoded')
    expect(result).toMatchObject({ status: 415, json: { error: { code: 'unsupportedMediaType' } } })
  })

  it('answers 413 above the route cap', async () => {
    const result = await post(JSON.stringify({ name: 'x'.repeat(100) }))
    expect(result).toMatchObject({ status: 413, json: { error: { code: 'payloadTooLarge', details: { limit: 64 } } } })
  })
})

describe('validateParams', () => {
  it('parses valid ids', async () => {
    const id = '7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c'
    expect(await call(`/items/${id}`)).toEqual({ status: 200, json: { id } })
  })

  it('answers 404 for an id that does not parse', async () => {
    expect(await call('/items/not-a-uuid')).toMatchObject({ status: 404, json: { error: { code: 'notFound' } } })
  })
})

describe('validateQuery', () => {
  it('parses query strings with the shared helpers', async () => {
    expect(await call('/query?limit=20&enabled=true&tags=a,%20b')).toEqual({ status: 200, json: { limit: 20, enabled: true, tags: ['a', 'b'] } })
  })

  it.each(['/query?limit=0', '/query?limit=201', '/query?enabled=yes', '/query?tags=c', '/query?unknown=1', '/query?limit=1&limit=2'])(
    'rejects %s',
    async (path) => {
      expect(await call(path)).toMatchObject({ status: 400, json: { error: { code: 'validationFailed' } } })
    },
  )
})

describe('helpers', () => {
  it('parseOrThrow throws validationFailed', () => {
    expect(() => parseOrThrow(body, { name: 1 })).toThrow('request validation failed')
  })

  it('zodIssues joins nested paths with dots', () => {
    const result = z.strictObject({ a: z.strictObject({ b: z.array(z.number()) }) }).safeParse({ a: { b: [1, 'x'] } })
    expect(result.success).toBe(false)
    if (!result.success) expect(zodIssues(result.error)).toEqual([{ path: 'a.b.1', message: expect.any(String) }])
  })
})
