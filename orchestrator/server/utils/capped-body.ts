import type { IncomingMessage } from 'node:http'
import { apiError } from './errors'

// Bodies without a usable Content-Length (`Transfer-Encoding: chunked`) on every non-streaming route (docs/api.md §1.5,
// security.md RES-1). Node's parser never delivers more than a declared Content-Length, so those bodies are bounded by
// the declared-length check; a chunked body has no such bound, so middleware/02.body-limit.ts reads it here, counting
// while it streams, and hands the buffer to h3, whose readRawBody and toWebRequest (readJsonBody, better-auth, /mcp,
// the registry token realm) read `RAW_BODY` before the socket.

/** The request property h3's readRawBody and getRequestWebStream read instead of the socket when it is set. */
export const RAW_BODY = Symbol.for('h3RawBody')

/**
 * Reads the request body into memory, never more than `limit` bytes. At the cap it stops reading and rejects with 413
 * `payloadTooLarge` (`details.limit`): the request is paused, never destroyed, so the 413 can still be written; the
 * unread rest stays on the connection, so the caller answers with `Connection: close`.
 */
export function readCappedBody(req: IncomingMessage, limit: number): Promise<Buffer> {
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
        req.pause()
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
