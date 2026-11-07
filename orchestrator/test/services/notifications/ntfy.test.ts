import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type NtfyMessage, publishNtfy } from '../../../server/services/notifications/ntfy'

// The ntfy client (docs/api.md §4.3, security.md NTF-1): one JSON publish to the server root, the token as Bearer,
// no redirects, and an outcome that says whether a failure is worth a retry. A local HTTP server plays ntfy.

interface Received {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: unknown
}

let server: Server
let base: string
let received: Received[]
let answer: (req: IncomingMessage, res: ServerResponse) => void

const message: NtfyMessage = {
  title: 'Scan "x" completed',
  message: '1 succeeded, 0 failed.',
  priority: 3,
  tags: ['white_check_mark', 'scantor'],
  click: 'https://scantor.test/scans/1',
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null })
      answer(req, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  // The tests that never answer leave their connections open.
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  received = []
  answer = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"id":"abc","event":"message"}')
  }
})

function respond(status: number, body: string, headers: Record<string, string> = {}) {
  answer = (_req, res) => {
    res.writeHead(status, headers)
    res.end(body)
  }
}

describe('publishNtfy', () => {
  it('publishes JSON to the server root with the topic and the Bearer token', async () => {
    const outcome = await publishNtfy({ server: base, topic: 'my-topic', token: 'tk_secret' }, message)
    expect(outcome).toEqual({ ok: true, status: 200, message: null, retryable: false })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ method: 'POST', url: '/' })
    expect(received[0]!.headers.authorization).toBe('Bearer tk_secret')
    expect(received[0]!.headers['content-type']).toBe('application/json')
    expect(received[0]!.headers['user-agent']).toMatch(/^scantor\//)
    expect(received[0]!.body).toEqual({ topic: 'my-topic', ...message })
  })

  it('sends no Authorization header without a token and keeps a base path', async () => {
    await publishNtfy({ server: `${base}/ntfy`, topic: 't', token: null }, message)
    expect(received[0]!.url).toBe('/ntfy/')
    expect(received[0]!.headers.authorization).toBeUndefined()
  })

  it('reports a rejection with the ntfy error and does not retry it', async () => {
    respond(403, '{"code":40301,"http":403,"error":"forbidden","link":"https://ntfy.sh/docs/publish/#authentication"}')
    expect(await publishNtfy({ server: base, topic: 't', token: 'wrong' }, message)).toEqual({
      ok: false,
      status: 403,
      message: 'the ntfy server answered 403: forbidden',
      retryable: false,
    })
    respond(400, 'plain text problem')
    expect((await publishNtfy({ server: base, topic: 't', token: null }, message)).message).toBe('the ntfy server answered 400: plain text problem')
  })

  it('retries rate limits and server errors', async () => {
    for (const status of [408, 429, 500, 503]) {
      respond(status, '')
      const outcome = await publishNtfy({ server: base, topic: 't', token: null }, message)
      expect(outcome, String(status)).toMatchObject({ ok: false, status, retryable: true })
    }
  })

  it('never follows a redirect', async () => {
    respond(302, '', { location: 'http://127.0.0.1:1/elsewhere' })
    expect(await publishNtfy({ server: base, topic: 't', token: 'tk' }, message)).toMatchObject({
      ok: false,
      status: 302,
      message: 'the ntfy server answered 302: redirects are not followed',
      retryable: false,
    })
    expect(received).toHaveLength(1)
  })

  it('reports an unreachable server or a timeout as retryable', async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const unreachable = await publishNtfy({ server: `http://127.0.0.1:${port}`, topic: 't', token: null }, message)
    expect(unreachable).toMatchObject({ ok: false, status: null, retryable: true })
    expect(unreachable.message).toMatch(/^the ntfy server could not be reached: /)

    answer = () => {} // never answers
    const timedOut = await publishNtfy({ server: base, topic: 't', token: null }, message, { timeoutMs: 100 })
    expect(timedOut).toEqual({ ok: false, status: null, message: 'the ntfy server could not be reached: no answer within 100 ms', retryable: true })
  })

  it('throws when the caller aborts', async () => {
    answer = () => {}
    const controller = new AbortController()
    const pending = publishNtfy({ server: base, topic: 't', token: null }, message, { signal: controller.signal })
    setTimeout(() => controller.abort(new Error('shutting down')), 50)
    await expect(pending).rejects.toThrow('shutting down')
  })
})
