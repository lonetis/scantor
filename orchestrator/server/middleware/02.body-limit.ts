import { defineEventHandler, getRequestHeader } from 'h3'
import { bodyLimitFor } from '../utils/body-limits'
import { useConfig } from '../utils/config'
import { apiError } from '../utils/errors'

// Body caps (docs/api.md §1.5): rejects declared lengths above the route's cap with 413 payloadTooLarge and stores
// the cap in `event.context.bodyLimit`, which readJsonBody (server/utils/zod.ts) and streaming routes enforce for
// bodies without Content-Length.

export default defineEventHandler((event) => {
  const method = event.method
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
  const path = event.path.split('?')[0] ?? '/'
  if (!path.startsWith('/api/')) return
  const limit = bodyLimitFor(method, path, useConfig())
  event.context.bodyLimit = limit
  const declared = Number(getRequestHeader(event, 'content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > limit) {
    throw apiError('payloadTooLarge', `request body exceeds ${limit} bytes`, { limit, actual: declared })
  }
})
