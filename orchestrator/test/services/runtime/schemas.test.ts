import { describe, expect, it } from 'vitest'
import {
  analysesStatusBody,
  presignBody,
  runtimeErrorBody,
  runtimeStateBody,
  schedulerCheckpointBody,
  schedulerDoneBody,
  schedulerResolvedBody,
} from '../../../server/services/runtime/schemas'

// Runtime API request schemas (docs/api.md §8) against the docs/api.md examples and the shapes Go's internal/api
// encodes (null for empty slices and absent pointers): strict objects, bounded sizes.

describe('state poll', () => {
  const runner = {
    processes: { running: 2, busy: 1 },
    busy: [{ seq: 1234, round: 1, attempt: 2, executionId: 'b2f1c0d9-8e7a-4b6c-9d5e-4f3a2b1c0d9e', startedAt: '2026-10-21T10:01:36.000Z', progress: null }],
    consuming: true,
    clockOffsetMs: -12,
    tmpFreeBytes: 9663676416,
    counters: { succeeded: 512, failed: 3, retried: 7, redeliveredSkipped: 1 },
    scheduler: null,
  }

  it('accepts the runner and scheduler examples', () => {
    expect(runtimeStateBody.parse(runner).busy).toHaveLength(1)
    const scheduler = { ...runner, processes: { running: 1, busy: 1 }, busy: [], scheduler: { published: 42100, confirmed: 42000, nacked: 0, backpressure: false } }
    expect(runtimeStateBody.parse(scheduler).scheduler).toEqual({ published: 42100, confirmed: 42000, nacked: 0, backpressure: false })
  })

  it('accepts progress objects and normalises a missing progress to null', () => {
    const withProgress = { ...runner, busy: [{ ...runner.busy[0], progress: { fraction: 0.5, message: 'half' } }] }
    expect(runtimeStateBody.parse(withProgress).busy[0]!.progress).toEqual({ fraction: 0.5, message: 'half' })
    const { progress: _progress, ...withoutProgress } = runner.busy[0]!
    expect(runtimeStateBody.parse({ ...runner, busy: [withoutProgress] }).busy[0]!.progress).toBeNull()
    expect(runtimeStateBody.parse({ ...runner, busy: null }).busy).toEqual([])
  })

  it('rejects unknown keys', () => {
    expect(runtimeStateBody.safeParse({ ...runner, scanId: 'x' }).success).toBe(false)
  })
})

describe('presign', () => {
  const body = {
    seq: 1234,
    round: 1,
    attempt: 2,
    executionId: 'b2f1c0d9-8e7a-4b6c-9d5e-4f3a2b1c0d9e',
    files: [{ fileId: 'e0c4b2a1-9f8e-4d7c-8b6a-5f4e3d2c1b0a', name: 'screenshot.png', size: 48213, sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', contentType: 'image/png' }],
  }

  it('accepts the docs/api.md §8.3 example', () => {
    expect(presignBody.parse(body)).toEqual(body)
  })

  it('rejects names with separators and malformed hashes or content types', () => {
    expect(presignBody.safeParse({ ...body, files: [{ ...body.files[0], name: 'a/b' }] }).success).toBe(false)
    expect(presignBody.safeParse({ ...body, files: [{ ...body.files[0], name: 'a\\b' }] }).success).toBe(false)
    expect(presignBody.safeParse({ ...body, files: [{ ...body.files[0], sha256: 'XYZ' }] }).success).toBe(false)
    expect(presignBody.safeParse({ ...body, files: [{ ...body.files[0], contentType: 'text/html\r\nX-Evil: 1' }] }).success).toBe(false)
  })
})

describe('analyses status', () => {
  it('accepts up to 1000 seqs', () => {
    expect(analysesStatusBody.parse({ seqs: [1234, 1235, 1240] }).seqs).toEqual([1234, 1235, 1240])
    expect(analysesStatusBody.safeParse({ seqs: Array.from({ length: 1001 }, (_, index) => index) }).success).toBe(false)
  })
})

describe('scheduler routes', () => {
  it('accepts the resolved example and the key forms schedule and call:<n>', () => {
    const body = {
      epoch: 1,
      key: 'schedule',
      template: 'tranco',
      scanConfig: { list: '262W9', subdomains: false, offset: 0, limit: 100000 },
      provenance: { listId: '262W9', date: '2026-10-20', sourceUrl: 'https://tranco-list.eu/download/262W9/100000', sha256: '77aa31c4', fetchedAt: '2026-10-21T10:00:03.120Z' },
      expectedTotal: 100000,
    }
    expect(schedulerResolvedBody.parse(body).key).toBe('schedule')
    expect(schedulerResolvedBody.parse({ ...body, key: 'call:3', expectedTotal: null }).key).toBe('call:3')
    for (const key of ['call:', 'call:-1', 'schedule.x', '$where', 'call:01']) {
      expect(schedulerResolvedBody.safeParse({ ...body, key }).success, key).toBe(false)
    }
  })

  it('requires tailHash exactly when confirmed > 0', () => {
    const hash = `sha256:${'9b1c7e2f'.repeat(8)}`
    expect(schedulerCheckpointBody.parse({ epoch: 1, confirmed: 42000, tailHash: hash })).toEqual({ epoch: 1, confirmed: 42000, tailHash: hash })
    expect(schedulerCheckpointBody.parse({ epoch: 1, confirmed: 0, tailHash: null }).confirmed).toBe(0)
    expect(schedulerCheckpointBody.safeParse({ epoch: 1, confirmed: 5, tailHash: null }).success).toBe(false)
    expect(schedulerCheckpointBody.safeParse({ epoch: 1, confirmed: 0, tailHash: hash }).success).toBe(false)
  })

  it('accepts the done examples and requires an error for a failed outcome', () => {
    const hash = `sha256:${'41e0aa5c'.repeat(8)}`
    expect(schedulerDoneBody.parse({ epoch: 1, outcome: 'done', confirmed: 100000, tailHash: hash }).outcome).toBe('done')
    const failed = schedulerDoneBody.parse({
      epoch: 1,
      outcome: 'failed',
      confirmed: 5000,
      tailHash: hash,
      error: { type: 'validation', phase: 'schedule', message: 'schedule() is not deterministic', retryable: false, attempt: 1, at: '2026-10-21T10:20:00.000Z' },
    })
    expect(failed.error?.at).toEqual(new Date('2026-10-21T10:20:00.000Z'))
    expect(schedulerDoneBody.safeParse({ epoch: 1, outcome: 'failed', confirmed: 0, tailHash: null }).success).toBe(false)
  })
})

describe('error reports', () => {
  it('accepts the docs/api.md §8.8 example', () => {
    const report = runtimeErrorBody.parse({
      fatal: false,
      error: { type: 'platform', phase: 'bootstrap', message: 'connector did not send hello within 30s', retryable: true, attempt: 0, at: '2026-10-21T10:00:21.000Z', details: { connectorExitCode: 1 } },
      context: { stderrTail: "ModuleNotFoundError: No module named 'requests'\n" },
    })
    expect(report.error.details).toEqual({ connectorExitCode: 1 })
    expect(report.error.at).toBeInstanceOf(Date)
  })

  it('rejects unknown error types and phases', () => {
    const error = { type: 'oops', phase: 'bootstrap', message: '', retryable: true, attempt: 0, at: '2026-10-21T10:00:21.000Z' }
    expect(runtimeErrorBody.safeParse({ fatal: false, error }).success).toBe(false)
    expect(runtimeErrorBody.safeParse({ fatal: false, error: { ...error, type: 'platform', phase: 'nowhere' } }).success).toBe(false)
  })
})
