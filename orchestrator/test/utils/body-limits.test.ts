import { describe, expect, it } from 'vitest'
import { bodyLimitFor, NODE_REPORT_BODY_LIMIT, RUNTIME_BODY_LIMIT } from '../../server/utils/body-limits'

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
  ])('%s %s → %d', (method, path, limit) => {
    expect(bodyLimitFor(method, path, config)).toBe(limit)
  })
})
