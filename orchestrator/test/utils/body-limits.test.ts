import { describe, expect, it } from 'vitest'
import { bodyLimitFor, isStreamingBodyRoute, NODE_REPORT_BODY_LIMIT, PROTOCOL_BODY_LIMIT, RUNTIME_BODY_LIMIT } from '../../server/utils/body-limits'

// Body caps (docs/api.md §1.5, security.md RES-1).

const config = { maxRequestBytes: 10, taskMaxPackBytes: 20, maxUploadBytes: 30 }

describe('bodyLimitFor', () => {
  it.each([
    ['POST', '/api/scans', 10],
    ['POST', '/api/tasks/upload', 20],
    ['POST', '/api/uploads', 30],
    ['POST', '/api/runtime/state', RUNTIME_BODY_LIMIT],
    ['POST', '/api/node/status', NODE_REPORT_BODY_LIMIT],
    ['POST', '/api/node/workers/abc/logs', NODE_REPORT_BODY_LIMIT],
    ['POST', '/api/node/hello', 10],
    ['PUT', '/api/tasks/x/files', 10],
    ['POST', '/api/auth/sign-in/email', PROTOCOL_BODY_LIMIT],
    ['POST', '/api/auth', PROTOCOL_BODY_LIMIT],
    ['POST', '/api/registry/token', PROTOCOL_BODY_LIMIT],
    ['POST', '/mcp', PROTOCOL_BODY_LIMIT],
    ['POST', '/.well-known/oauth-authorization-server/api/auth', PROTOCOL_BODY_LIMIT],
  ])('%s %s → %d', (method, path, limit) => {
    expect(bodyLimitFor(method, path, config)).toBe(limit)
  })

  it('leaves the UI and its assets alone', () => {
    for (const path of ['/', '/tasks', '/_nuxt/entry.js', '/api', '/mcpx']) expect(bodyLimitFor('POST', path, config), path).toBeNull()
  })
})

describe('isStreamingBodyRoute', () => {
  it('is true only for the two upload routes', () => {
    expect(isStreamingBodyRoute('POST', '/api/tasks/upload')).toBe(true)
    expect(isStreamingBodyRoute('post', '/api/uploads')).toBe(true)
    expect(isStreamingBodyRoute('PUT', '/api/uploads')).toBe(false)
    expect(isStreamingBodyRoute('POST', '/api/auth/sign-in/email')).toBe(false)
  })
})
