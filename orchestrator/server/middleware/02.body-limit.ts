import { defineEventHandler, getRequestHeader } from 'h3'
import { bodyLimitFor, isStreamingBodyRoute } from '../utils/body-limits'
import { hasUncountedBody, RAW_BODY, readCappedBody } from '../utils/capped-body'
import { useConfig } from '../utils/config'
import { apiError } from '../utils/errors'
import { rawPathOf } from '../utils/request-path'

// Body caps (docs/api.md §1.5, security.md RES-1) on `/api/*`, `/mcp` and the root `/.well-known/*` documents, before
// any credential is checked: a declared length above the route's cap is 413 payloadTooLarge at once. A body without
// Content-Length (chunked) is read here, counted while it streams, and stops at the cap with 413 and `Connection:
// close`; below the cap the buffer is handed to h3 (utils/capped-body.ts), so readJsonBody, better-auth, `/mcp` and the
// registry token realm never read an unbounded body. The two streaming upload routes count their own bodies (ByteCap);
// the cap is stored in `event.context.bodyLimit` for them.

export default defineEventHandler(async (event) => {
  const method = event.method
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
  const path = rawPathOf(event.path)
  const limit = bodyLimitFor(method, path, useConfig())
  if (limit === null) return
  event.context.bodyLimit = limit
  const declared = Number(getRequestHeader(event, 'content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > limit) {
    throw apiError('payloadTooLarge', `request body exceeds ${limit} bytes`, { limit, actual: declared })
  }
  const req = event.node.req
  if (isStreamingBodyRoute(method, path) || !hasUncountedBody(req)) return
  try {
    ;(req as unknown as Record<symbol, unknown>)[RAW_BODY] = await readCappedBody(req, limit)
  } catch (error) {
    // The unread rest of the body still sits on the connection, so it must not carry another request.
    if (!event.node.res.headersSent) event.node.res.setHeader('Connection', 'close')
    throw error
  }
})
