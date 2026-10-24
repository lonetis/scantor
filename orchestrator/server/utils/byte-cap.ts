import type { ServerResponse } from 'node:http'
import { Transform, type TransformCallback } from 'node:stream'
import { ApiError } from './errors'

// The streaming cap of request bodies without a usable Content-Length (docs/api.md §1.5, security.md WS-9), shared
// by the streaming routes (`uploadTask`, `createUpload`).

/**
 * Counts the bytes of a streamed body and ends the stream with an error once `maxBytes` is exceeded, so an oversized
 * body is never read further. `exceeded` tells the caller to answer 413. `observe` sees every chunk within the cap
 * (for example to hash it). Pipe the request into it (`request.pipe(cap)`) and never destroy the request: the
 * failing pipe only pauses it, so the connection stays usable for the 413 response; destroying the request closes the
 * socket, and a proxy in front then answers 502. The route runs its upload through closeConnectionWhenTooLarge, so
 * the connection ends once the 413 is written.
 */
export class ByteCap extends Transform {
  bytes = 0
  exceeded = false

  constructor(
    readonly maxBytes: number,
    private readonly observe?: (chunk: Buffer) => void,
  ) {
    super()
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length
    if (this.bytes > this.maxBytes) {
      this.exceeded = true
      callback(new Error(`the upload exceeds ${this.maxBytes} bytes`))
      return
    }
    this.observe?.(chunk)
    callback(null, chunk)
  }
}

/**
 * Runs the upload of a streaming route. When it ends in 413 `payloadTooLarge`, the cap stopped reading the body and
 * the rest of it still sits unread on the connection, so the response closes the connection (`Connection: close`,
 * written after the 413). Kept alive, a proxy that had already written the whole body would send its next request
 * over that connection, where it waits behind the unread body until the socket times out and the proxy answers it
 * with 502.
 */
export async function closeConnectionWhenTooLarge<T>(response: ServerResponse, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof ApiError && error.code === 'payloadTooLarge' && !response.headersSent) response.setHeader('Connection', 'close')
    throw error
  }
}
