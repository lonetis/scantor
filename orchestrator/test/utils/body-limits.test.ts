import { describe, expect, it } from 'vitest'
import {
  bodyLimitFor,
  isStreamingBodyRoute,
  NODE_REPORT_BODY_LIMIT,
  PROTOCOL_BODY_LIMIT,
  RUNTIME_BODY_LIMIT,
  SCRIPT_RUNTIME_BODY_LIMIT,
} from '../../server/utils/body-limits'

// Body caps (docs/api.md §1.5, security.md RES-1).

const MiB = 1024 ** 2
const KiB = 1024
const config = { maxRequestBytes: 10, taskMaxPackBytes: 20, maxUploadBytes: 30, maxResultBytes: MiB }

describe('bodyLimitFor', () => {
  it.each([
    ['POST', '/api/scans', 10],
    ['POST', '/api/tasks/upload', 20],
    ['POST', '/api/scripts/upload', 20],
    ['POST', '/api/scripts', 10],
    ['PUT', '/api/scripts/x/files', 10],
    ['POST', '/api/uploads', 30],
    ['POST', '/api/runtime/state', RUNTIME_BODY_LIMIT],
    ['POST', '/api/script-runtime/progress', SCRIPT_RUNTIME_BODY_LIMIT],
    ['POST', '/api/script-runtime/scans/s/analyses', SCRIPT_RUNTIME_BODY_LIMIT],
    ['POST', '/api/script-runtime/describe', SCRIPT_RUNTIME_BODY_LIMIT],
    ['POST', '/api/script-runtime/finish', MiB + 128 * KiB],
    ['PUT', '/api/script-runtime/checkpoint', MiB + 128 * KiB],
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

  it('sizes finish and checkpoint for the larger of a 1 MiB checkpoint and SCANTOR_MAX_RESULT_BYTES', () => {
    const small = { ...config, maxResultBytes: 64 * KiB }
    const large = { ...config, maxResultBytes: 4 * MiB }
    expect(bodyLimitFor('PUT', '/api/script-runtime/checkpoint', small)).toBe(MiB + 128 * KiB)
    expect(bodyLimitFor('POST', '/api/script-runtime/finish', small)).toBe(MiB + 128 * KiB)
    expect(bodyLimitFor('POST', '/api/script-runtime/finish', large)).toBe(4 * MiB + 128 * KiB)
    expect(bodyLimitFor('POST', '/api/script-runtime/progress', large)).toBe(SCRIPT_RUNTIME_BODY_LIMIT)
  })

  it('leaves the UI and its assets alone', () => {
    for (const path of ['/', '/tasks', '/_nuxt/entry.js', '/api', '/mcpx']) expect(bodyLimitFor('POST', path, config), path).toBeNull()
  })
})

describe('isStreamingBodyRoute', () => {
  it('is true only for the three upload routes', () => {
    expect(isStreamingBodyRoute('POST', '/api/tasks/upload')).toBe(true)
    expect(isStreamingBodyRoute('POST', '/api/scripts/upload')).toBe(true)
    expect(isStreamingBodyRoute('post', '/api/uploads')).toBe(true)
    expect(isStreamingBodyRoute('PUT', '/api/scripts/upload')).toBe(false)
    expect(isStreamingBodyRoute('PUT', '/api/uploads')).toBe(false)
    expect(isStreamingBodyRoute('POST', '/api/auth/sign-in/email')).toBe(false)
  })
})
