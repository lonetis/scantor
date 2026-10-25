import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { readCappedBody } from '../../server/utils/capped-body'
import { normalizeError } from '../../server/utils/errors'

// The capped read of chunked bodies (docs/api.md §1.5, security.md RES-1) on a real listener: at the cap the rest of
// the body is discarded for a bounded time, never buffered.

const LIMIT = 1024
const DRAIN_MS = 200

let server: Server | null = null

afterEach(async () => {
  const current = server
  server = null
  if (current) {
    await new Promise<void>((resolve) => {
      current.close(() => resolve())
      current.closeAllConnections()
    })
  }
})

async function listen(): Promise<number> {
  server = createServer((req, res) => {
    readCappedBody(req, LIMIT, DRAIN_MS).then(
      (body) => res.end(JSON.stringify({ bytes: body.length })),
      (error: unknown) => {
        const normalized = normalizeError(error)
        res.writeHead(normalized.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(normalized.body))
      },
    )
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return (server!.address() as AddressInfo).port
}

describe('readCappedBody', () => {
  it('reads a body below the cap whole', async () => {
    const port = await listen()
    const body = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method: 'POST', headers: { 'Transfer-Encoding': 'chunked' } }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      })
      req.on('error', reject)
      req.end(Buffer.alloc(LIMIT, 0x20))
    })
    expect(JSON.parse(body)).toEqual({ bytes: LIMIT })
  })

  it('answers at the cap and destroys the connection of a body that does not end within the drain time', async () => {
    const port = await listen()
    const started = Date.now()
    const outcome = await new Promise<{ status: number; closedAfterMs: number }>((resolve) => {
      let status = 0
      const req = request({ host: '127.0.0.1', port, method: 'POST', headers: { 'Transfer-Encoding': 'chunked' } }, (res) => {
        status = res.statusCode ?? 0
        res.resume()
      })
      // A client that never stops sending, whatever the answer.
      const piece = Buffer.alloc(16 * 1024, 0x20)
      const pump = () => {
        while (!req.destroyed && req.write(piece));
        if (!req.destroyed) req.once('drain', pump)
      }
      req.on('close', () => resolve({ status, closedAfterMs: Date.now() - started }))
      req.on('error', () => {})
      pump()
    })
    expect(outcome.status).toBe(413)
    expect(outcome.closedAfterMs).toBeGreaterThanOrEqual(DRAIN_MS)
    expect(outcome.closedAfterMs).toBeLessThan(DRAIN_MS + 3000)
  })
})
