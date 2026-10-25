import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCursorList } from '../../app/composables/useCursorList'
import { EXPORT_POLL_MS, exportPollDelay, useExports } from '../../app/composables/useExports'

// Following an export until it is ready (docs/ui.md §5.13.6, §9): every 2 s, doubling after failures up to 60 s, and
// never after the export expired or the API refused it for good.

let answers: (() => unknown)[]
let reads: number

function exportOf(id: string, state = 'running', expiresInMs = 3_600_000) {
  return { id, scanId: 'scan', state, format: 'jsonl', rows: 0, bytes: 0, error: null, expiresAt: new Date(Date.now() + expiresInMs).toISOString() }
}

function failure(status: number): () => never {
  return () => {
    throw Object.assign(new Error(`status ${status}`), { status })
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  answers = []
  reads = 0
  vi.stubGlobal('useCursorList', useCursorList)
  vi.stubGlobal('apiQuery', (query: Record<string, unknown>) => query)
  vi.stubGlobal('toApiError', (cause: unknown) => cause)
  vi.stubGlobal('useToast', () => ({ add: () => {} }))
  vi.stubGlobal('useOverlay', () => ({}))
  vi.stubGlobal('formatCount', String)
  vi.stubGlobal('formatBytes', String)
  vi.stubGlobal('useApi', () => async (_path: string, options: { method?: string, body?: { id: string, expiresInMs?: number } } = {}) => {
    if (options.method === 'POST') return exportOf(options.body!.id, 'queued', options.body!.expiresInMs)
    reads++
    return (answers.shift() ?? failure(503))()
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Starts an export through create(), which follows it. */
async function start(id: string, expiresInMs?: number): Promise<void> {
  await useExports('scan').create('scan', { id, expiresInMs } as never)
}

describe('exportPollDelay', () => {
  it('doubles from 2 s up to 60 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(exportPollDelay)).toEqual([EXPORT_POLL_MS, 4000, 8000, 16_000, 32_000, 60_000, 60_000])
  })
})

describe('following an export', () => {
  it('backs off while reads fail and ends once the export settled', async () => {
    await start('e1')
    await vi.advanceTimersByTimeAsync(EXPORT_POLL_MS)
    expect(reads).toBe(1)
    await vi.advanceTimersByTimeAsync(4000 - 1)
    expect(reads).toBe(1)
    answers.push(() => exportOf('e1', 'running'))
    await vi.advanceTimersByTimeAsync(1)
    expect(reads).toBe(2)
    // A success resets the interval to 2 s.
    answers.push(() => exportOf('e1', 'ready'))
    await vi.advanceTimersByTimeAsync(EXPORT_POLL_MS)
    expect(reads).toBe(3)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(reads).toBe(3)
  })

  it('stops for good after a refusal that retrying cannot change', async () => {
    answers.push(failure(403))
    await start('e2')
    await vi.advanceTimersByTimeAsync(EXPORT_POLL_MS)
    expect(reads).toBe(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(reads).toBe(1)
  })

  it('stops once the export expired', async () => {
    await start('e3', 5000)
    await vi.advanceTimersByTimeAsync(EXPORT_POLL_MS)
    expect(reads).toBe(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(reads).toBe(1)
  })
})
