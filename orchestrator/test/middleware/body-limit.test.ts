import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, defineEventHandler, readRawBody, send, setResponseStatus, toNodeListener, toWebRequest } from 'h3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import bodyLimitMiddleware from '../../server/middleware/02.body-limit'
import { PROTOCOL_BODY_LIMIT } from '../../server/utils/body-limits'
import { parseConfig, setConfigForTesting } from '../../server/utils/config'
import { normalizeError } from '../../server/utils/errors'
import { readJsonBody } from '../../server/utils/zod'

// Body caps on a real listener (docs/api.md §1.5, security.md RES-1): a chunked body is counted while it streams and
// never read past the cap; below the cap the buffered body reaches readJsonBody, h3's readRawBody and toWebRequest.

const LIMIT = 4096

let server: Server | null = null

beforeEach(() => {
  setConfigForTesting(parseConfig({ SCANTOR_MAX_REQUEST_BYTES: String(LIMIT) }).config)
})

afterEach(async () => {
  const current = server
  server = null
  if (current) {
    await new Promise<void>((resolve) => {
      current.close(() => resolve())
      current.closeAllConnections()
    })
  }
  setConfigForTesting(null)
})

async function listen(): Promise<number> {
  const app = createApp({
    onError: (error, event) => {
      const normalized = normalizeError(error)
      setResponseStatus(event, normalized.status)
      return send(event, JSON.stringify(normalized.body), 'application/json')
    },
  })
  app.use(bodyLimitMiddleware)
  app.use(
    '/api/json',
    defineEventHandler(async (event) => ({ body: await readJsonBody(event) })),
  )
  app.use(
    '/api/auth',
    defineEventHandler(async (event) => ({ text: await toWebRequest(event).text() })),
  )
  app.use(
    '/mcp',
    defineEventHandler(async (event) => ({ bytes: (await readRawBody(event, false))?.length ?? 0 })),
  )
  app.use(
    '/api/uploads',
    defineEventHandler((event) => ({ buffered: Symbol.for('h3RawBody') in event.node.req, limit: event.context.bodyLimit })),
  )
  server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return (server!.address() as AddressInfo).port
}

interface Answer {
  status: number
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
  /** bytes the client wrote before it saw the answer */
  written: number
}

/**
 * Sends `body` chunked (or with Content-Length when `declared`), 64 KiB at a time, and stops writing once the answer
 * arrives, as a client behind a proxy would. With `declared`, nothing of the body is sent before the answer.
 */
function post(port: number, path: string, body: Buffer, options: { declared?: boolean; contentType?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    let written = 0
    let answered = false
    const headers: Record<string, string> = { 'Content-Type': options.contentType ?? 'application/json' }
    if (options.declared) headers['Content-Length'] = String(body.length)
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      answered = true
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        if (options.declared) req.destroy()
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')), written })
      })
    })
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') reject(error)
    })
    if (options.declared) {
      req.flushHeaders()
      return
    }
    const pump = () => {
      while (!answered && written < body.length) {
        const piece = body.subarray(written, written + 64 * 1024)
        written += piece.length
        if (!req.write(piece)) {
          req.once('drain', pump)
          return
        }
      }
      if (!answered) req.end()
    }
    pump()
  })
}

const spaces = (bytes: number) => Buffer.alloc(bytes, 0x20)

describe('middleware 02.body-limit', () => {
  it('stops reading a chunked body at the cap and closes the connection with 413', async () => {
    const port = await listen()
    // Far more than the socket buffers hold: the client only gets to write it all if the server keeps reading.
    const total = 32 * 1024 ** 2
    const answer = await post(port, '/api/json', spaces(total))
    expect(answer.status).toBe(413)
    expect(answer.body).toEqual({ error: { code: 'payloadTooLarge', message: `request body exceeds ${LIMIT} bytes`, details: { limit: LIMIT } } })
    expect(answer.headers.connection).toBe('close')
    expect(answer.written).toBeLessThan(total)
  })

  it('hands a chunked body below the cap to readJsonBody', async () => {
    const port = await listen()
    const value = { s: 'a'.repeat(LIMIT - 20) }
    const answer = await post(port, '/api/json', Buffer.from(JSON.stringify(value)))
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({ body: value })
  })

  it('caps better-auth, /mcp and the registry token realm at the protocol limit', async () => {
    const port = await listen()
    const auth = await post(port, '/api/auth/sign-in/email', spaces(4 * PROTOCOL_BODY_LIMIT))
    expect(auth.status).toBe(413)
    expect(auth.body).toMatchObject({ error: { code: 'payloadTooLarge', details: { limit: PROTOCOL_BODY_LIMIT } } })
    expect(auth.headers.connection).toBe('close')
    const mcp = await post(port, '/mcp', spaces(4 * PROTOCOL_BODY_LIMIT))
    expect(mcp.status).toBe(413)
    // Below the cap the buffered body reaches toWebRequest (better-auth) and readRawBody (/mcp) whole.
    expect((await post(port, '/api/auth/sign-in/email', spaces(3000))).body).toEqual({ text: ' '.repeat(3000) })
    expect((await post(port, '/mcp', spaces(5000))).body).toEqual({ bytes: 5000 })
  })

  it('answers a declared length above the cap before reading the body', async () => {
    const port = await listen()
    const answer = await post(port, '/api/json', spaces(10 * LIMIT), { declared: true })
    expect(answer.status).toBe(413)
    expect(answer.body).toMatchObject({ error: { code: 'payloadTooLarge', details: { limit: LIMIT, actual: 10 * LIMIT } } })
    expect(answer.written).toBe(0)
  })

  it('leaves the streaming upload routes to their own cap', async () => {
    const port = await listen()
    const answer = await post(port, '/api/uploads', spaces(2 * LIMIT), { contentType: 'text/plain' })
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({ buffered: false, limit: expect.any(Number) })
  })
})
