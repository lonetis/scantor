import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCursorList } from '../../app/composables/useCursorList'
import type { Export } from '#shared/types/exports'
import { EXPORT_POLL_MS, exportPollDelay, exportRows, useExports } from '../../app/composables/useExports'

// Following an export until it is ready (docs/ui.md §5.13.6, §9): every 2 s, doubling after failures up to 60 s, and
// never after the export expired or the API refused it for good.

let answers: (() => unknown)[]
let reads: number
/** features.downloads of the stubbed instance info (false through the tunnel URL) */
let downloads: boolean
/** every toast the composable showed */
let toasts: { title?: string; actions?: { label: string }[] }[]
/** every presigned URL a download followed */
let followed: string[]

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
  downloads = true
  toasts = []
  followed = []
  vi.stubGlobal('useCursorList', useCursorList)
  vi.stubGlobal('apiQuery', (query: Record<string, unknown>) => query)
  vi.stubGlobal('toApiError', (cause: unknown) => cause)
  vi.stubGlobal('useToast', () => ({ add: (toast: (typeof toasts)[number]) => toasts.push(toast) }))
  vi.stubGlobal('useOverlay', () => ({}))
  vi.stubGlobal('useInstance', () => ({ features: { value: { downloads } }, downloadsAvailable: async () => downloads }))
  vi.stubGlobal('navigateToDownload', (url: string) => followed.push(url))
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

describe('downloads (TUNNEL-013)', () => {
  const ready = () => ({
    ...exportOf('e4', 'ready'),
    download: { url: 'https://s3.example.com/e4?X-Amz-Signature=x', expiresAt: new Date(Date.now() + 600_000).toISOString() },
  })

  it('offers the download in the ready toast and follows its presigned link on the public URL', async () => {
    answers.push(ready)
    await start('e4')
    await vi.advanceTimersByTimeAsync(EXPORT_POLL_MS)
    expect(toasts.map((toast) => [toast.title, toast.actions?.map((action) => action.label)])).toEqual([['Export ready', ['Download']]])
    await useExports('scan').download(ready() as never)
    expect(followed).toEqual(['https://s3.example.com/e4?X-Amz-Signature=x'])
  })

  it('only announces a ready export through the tunnel URL and never follows a presigned link there', async () => {
    downloads = false
    answers.push(ready)
    await start('e5')
    await vi.advanceTimersByTimeAsync(EXPORT_POLL_MS)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]!.title).toBe('Export ready')
    expect(toasts[0]!.actions).toBeUndefined()
    const before = reads
    await useExports('scan').download(exportOf('e5', 'ready') as never)
    expect(followed).toEqual([])
    expect(reads).toBe(before)
  })
})

describe('exportRows (the exports tab)', () => {
  const at = (minute: number) => `2026-10-25T10:${String(minute).padStart(2, '0')}:00.000Z`
  const item = (id: string, minute: number, state = 'ready', scanId = 'scan') => ({ id, scanId, state, createdAt: at(minute) }) as unknown as Export

  it('puts followed exports of the scan that the list lacks first, newest first', () => {
    const listed = [item('b', 20), item('a', 10)]
    const followed = new Map([['d', item('d', 40, 'running')], ['c', item('c', 30, 'queued')]])
    expect(exportRows(listed, followed, 'scan').map((row) => row.id)).toEqual(['d', 'c', 'b', 'a'])
  })

  it('shows listed exports in their followed state', () => {
    const followed = new Map([['a', item('a', 10, 'ready')]])
    expect(exportRows([item('a', 10, 'running')], followed, 'scan').map((row) => row.state)).toEqual(['ready'])
  })

  it('leaves out exports of other scans and followed exports older than the newest listed one', () => {
    const listed = [item('b', 20)]
    const followed = new Map([['other', item('other', 50, 'running', 'other-scan')], ['old', item('old', 5, 'running')]])
    expect(exportRows(listed, followed, 'scan').map((row) => row.id)).toEqual(['b'])
    expect(exportRows([], followed, 'scan').map((row) => row.id)).toEqual(['old'])
  })
})
