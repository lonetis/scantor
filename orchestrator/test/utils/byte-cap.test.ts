import { Agent, createServer, request, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ByteCap, closeConnectionOnFailure } from '../../server/utils/byte-cap'
import { apiError } from '../../server/utils/errors'

// The streaming routes cap a chunked body with ByteCap, which stops reading it and leaves the rest unread on the
// connection (docs/api.md §1.5). Their 413 closes the connection: a keep-alive client that had written the whole body
// would otherwise send its next request over that connection, where nothing ever reads it (a proxy in front then
// answers that request with 502 once the socket times out). Any other failure before the whole body was read closes it
// as well.

const CAP = 64 * 1024

let server: Server
let agent: Agent
let base: string

/** Reads the body through the cap the way the upload services do: pipe, never destroy. */
async function capped(req: IncomingMessage): Promise<void> {
  const cap = new ByteCap(CAP)
  await new Promise<void>((resolve, reject) => {
    const piped = req.pipe(cap)
    piped.on('data', () => {})
    piped.on('end', resolve)
    piped.on('error', reject)
  }).catch((error: unknown) => {
    throw cap.exceeded ? apiError('payloadTooLarge', `the upload exceeds ${CAP} bytes`, { limit: CAP }) : error
  })
}

beforeEach(async () => {
  server = createServer((req, res) => {
    const fail = (error: { statusCode?: number }) => {
      res.statusCode = error.statusCode ?? 500
      res.end(error.statusCode === 413 ? 'too large' : 'failed')
    }
    if (req.url === '/early-failure') {
      // Fails before reading the body, like an upload that finds no free helper slot.
      closeConnectionOnFailure(req, res, () => Promise.reject(apiError('unavailable', 'no slot'))).catch(fail)
      return
    }
    if (req.url === '/read-then-fail') {
      closeConnectionOnFailure(req, res, async () => {
        for await (const chunk of req) void chunk
        throw apiError('workspaceDirty', 'dirty')
      }).catch(fail)
      return
    }
    if (req.url !== '/upload') {
      res.end('next')
      return
    }
    closeConnectionOnFailure(req, res, () => capped(req)).then(() => res.end('stored'), fail)
  })
  // Long enough that only the fix can free the connection within the test.
  server.keepAliveTimeout = 60_000
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  agent = new Agent({ keepAlive: true, maxSockets: 1 })
})

afterEach(async () => {
  agent.destroy()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function send(path: string, body?: Buffer): Promise<{ status: number; text: string; connection: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method: body ? 'POST' : 'GET', agent, headers: body ? { 'Transfer-Encoding': 'chunked' } : {} }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), connection: res.headers.connection }))
      res.on('error', reject)
    })
    req.setTimeout(3000, () => req.destroy(new Error(`${path}: no response within 3 s`)))
    req.on('error', reject)
    if (body) for (let offset = 0; offset < body.length; offset += 16 * 1024) req.write(body.subarray(offset, offset + 16 * 1024))
    req.end()
  })
}

describe('closeConnectionOnFailure', () => {
  it('answers 413 with Connection: close, so the next request of a keep-alive client gets a connection that is read', async () => {
    // Four times the cap: small enough that the client writes all of it into the socket before the 413 arrives.
    const tooLarge = await send('/upload', Buffer.alloc(4 * CAP, 0x61))
    expect(tooLarge).toMatchObject({ status: 413, text: 'too large' })
    expect(await send('/next')).toMatchObject({ status: 200, text: 'next' })
    expect(tooLarge.connection).toBe('close')
  })

  it('keeps the connection of an upload within the cap', async () => {
    expect(await send('/upload', Buffer.alloc(CAP, 0x61))).toEqual({ status: 200, text: 'stored', connection: 'keep-alive' })
    expect(await send('/next')).toMatchObject({ status: 200, text: 'next' })
  })

  it('closes the connection of any failure that left the body unread', async () => {
    const failed = await send('/early-failure', Buffer.alloc(2 * CAP, 0x61))
    expect(failed).toMatchObject({ status: 503, text: 'failed', connection: 'close' })
    expect(await send('/next')).toMatchObject({ status: 200, text: 'next' })
  })

  it('keeps the connection of a failure after the whole body was read', async () => {
    expect(await send('/read-then-fail', Buffer.alloc(CAP, 0x61))).toEqual({ status: 409, text: 'failed', connection: 'keep-alive' })
    expect(await send('/next')).toMatchObject({ status: 200, text: 'next' })
  })
})
