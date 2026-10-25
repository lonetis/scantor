import type { IncomingMessage } from 'node:http'
import { apiError } from './errors'

// Bodies without a usable Content-Length (`Transfer-Encoding: chunked`) on every non-streaming route (docs/api.md §1.5,
// security.md RES-1). Node's parser never delivers more than a declared Content-Length, so those bodies are bounded by
// the declared-length check; a chunked body has no such bound, so middleware/02.body-limit.ts reads it here, counting
// while it streams, and hands the buffer to h3, whose readRawBody and toWebRequest (readJsonBody, better-auth, /mcp,
// the registry token realm) read `RAW_BODY` before the socket.

/** The request property h3's readRawBody and getRequestWebStream read instead of the socket when it is set. */
export const RAW_BODY = Symbol.for('h3RawBody')

/** How long the rest of a body that hit its cap is discarded before the connection is destroyed. */
export const CAPPED_BODY_DRAIN_MS = 5_000

/**
 * Drops the rest of a body that is not read, so the connection stays open while the 413 is written and read. Leaving the
 * rest unread and closing the connection after the 413 (`Connection: close`) resets the connection while a proxy is
 * still sending the body, and the proxy answers 502 instead of the 413; kept alive with the rest unread, the next
 * request of the connection would wait behind it. Once the body ends, the connection carries the next request; a body
 * that has not ended `drainMs` later gets its connection destroyed (by then the 413 has long arrived), so a client
 * cannot make the orchestrator discard data for longer.
 */
function discardRest(req: IncomingMessage, drainMs: number): void {
  const deadline = setTimeout(() => req.socket.destroy(), drainMs)
  deadline.unref()
  req.once('end', () => clearTimeout(deadline))
  req.resume()
}

/**
 * Reads the request body into memory, never more than `limit` bytes. At the cap it rejects with 413 `payloadTooLarge`
 * (`details.limit`) and discards the rest of the body as it arrives (discardRest).
 */
export function readCappedBody(req: IncomingMessage, limit: number, drainMs = CAPPED_BODY_DRAIN_MS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('close', onClose)
    }
    const onData = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > limit) {
        cleanup()
        discardRest(req, drainMs)
        reject(apiError('payloadTooLarge', `request body exceeds ${limit} bytes`, { limit }))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      cleanup()
      resolve(Buffer.concat(chunks, bytes))
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onClose = () => {
      cleanup()
      reject(new Error('the client closed the connection before the request body ended'))
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('close', onClose)
  })
}

/** True when the request carries a body without a Content-Length (chunked), which only counting can bound. */
export function hasUncountedBody(req: IncomingMessage): boolean {
  return req.headers['content-length'] === undefined && req.headers['transfer-encoding'] !== undefined
}
