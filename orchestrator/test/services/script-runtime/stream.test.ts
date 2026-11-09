import { MongoNetworkError, MongoServerError } from 'mongodb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScanDoc } from '../../../server/types/documents'
import type { CachedUser } from '../../../server/utils/user-cache'
import { FakeCollection } from '../../helpers/fake-collection'
import { analysis, OWNER, RUN, SCAN, SCRIPT, scan, streamableAnalyses, type WindowHooks } from './helpers'

// scriptRuntimeStreamAnalyses (docs/scripts.md): NDJSON lines in seq order over the export's seq windows, masked,
// with presigned URLs of stored files, checkpoint lines after every window and on silence, exactly one end line or a
// final error line (retryable for a lost cursor, a transient database error and a shutdown).

const scriptRuns = new FakeCollection('scriptRuns')
const scans = new FakeCollection<ScanDoc>('scans')
const users = new Map<string, CachedUser | null>()

vi.mock('../../../server/utils/mongo', () => ({ useCollections: () => ({ scriptRuns: scriptRuns.asCollection(), scans: scans.asCollection() }) }))
vi.mock('../../../server/utils/user-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/utils/user-cache')>()
  return { ...actual, getCachedUser: async (id: string) => users.get(id) ?? null }
})

const { analysisStreamLines, planStream, recheckStream, streamErrorOf, StreamStop, DEFAULT_STREAM_FIELDS } =
  await import('../../../server/services/script-runtime/stream')
const { EXPORT_SEQ_RANGE } = await import('../../../server/services/exports/rows')
const { apiError } = await import('../../../server/utils/errors')

const KEY_1 = `files/${SCAN}/0/e/f1/report.json`
const FILE_1 = { id: 'f1', name: 'report.json', size: 10, sha256: 'a'.repeat(64), contentType: 'application/json', key: KEY_1 }
const FILE_UNSTORED = { id: 'f2', name: 'later.bin', size: 1, sha256: 'b'.repeat(64), contentType: 'application/octet-stream' }

const principal = { kind: 'scriptRun' as const, scriptRun: { id: RUN, userId: OWNER, scriptId: SCRIPT, scanIds: [SCAN], limit: null } }

interface RunOptions {
  body?: Parameters<typeof planStream>[1] | Partial<Parameters<typeof planStream>[1]>
  limit?: number | null
  hooks?: WindowHooks
  recheck?: () => Promise<void>
  signal?: AbortSignal
  keepAliveMs?: number
  docs?: ReturnType<typeof analysis>[]
}

async function collect(options: RunOptions = {}) {
  const analyses = streamableAnalyses(options.hooks)
  for (const doc of options.docs ?? []) await analyses.fake.insertOne(doc)
  const recheck = vi.fn(options.recheck ?? (async () => undefined))
  const plan = planStream(scan(), { fileUrls: true, ...options.body } as Parameters<typeof planStream>[1], options.limit ?? null)
  const lines: unknown[] = []
  for await (const line of analysisStreamLines(plan, {
    collection: analyses.collection,
    limits: { queryMaxTimeMs: 1000, queryMaxDocs: 1000 },
    signal: options.signal ?? new AbortController().signal,
    recheck,
    sign: (key) => `signed:${key}`,
    keepAliveMs: options.keepAliveMs ?? 60_000,
    pause: async () => undefined,
  })) {
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    lines.push(JSON.parse(line))
  }
  return { lines, recheck, analyses }
}

const SPREAD = [
  analysis(0, { files: [FILE_1, FILE_UNSTORED] }),
  analysis(5, {
    status: 'failed',
    result: undefined,
    error: { type: 'taskError', message: 'boom', retryable: false, phase: 'run', attempt: 1, at: new Date('2026-01-01T00:00:00Z') },
  }),
  analysis(EXPORT_SEQ_RANGE + 5),
  analysis(2 * EXPORT_SEQ_RANGE + 1),
]

afterEach(async () => {
  await scriptRuns.deleteMany({})
  await scans.deleteMany({})
  users.clear()
})

describe('analysisStreamLines', () => {
  it('streams masked analyses in seq order with file URLs, window checkpoints and one end line', async () => {
    const { lines, recheck } = await collect({ docs: SPREAD })
    expect(lines).toEqual([
      {
        analysis: {
          id: `${SCAN}-0`,
          seq: 0,
          status: 'succeeded',
          attempt: 1,
          round: 1,
          config: { url: 'https://example.com/0', token: '***' },
          result: { title: 't0' },
          files: [
            { id: 'f1', name: 'report.json', size: 10, sha256: 'a'.repeat(64), contentType: 'application/json' },
            { id: 'f2', name: 'later.bin', size: 1, sha256: 'b'.repeat(64), contentType: 'application/octet-stream' },
          ],
        },
        urls: { f1: `signed:${KEY_1}` },
      },
      { analysis: expect.objectContaining({ id: `${SCAN}-5`, status: 'failed', files: [] }) },
      { checkpoint: { afterSeq: EXPORT_SEQ_RANGE - 1 } },
      { analysis: expect.objectContaining({ seq: EXPORT_SEQ_RANGE + 5 }) },
      { checkpoint: { afterSeq: 2 * EXPORT_SEQ_RANGE - 1 } },
      { analysis: expect.objectContaining({ seq: 2 * EXPORT_SEQ_RANGE + 1 }) },
      { checkpoint: { afterSeq: 2 * EXPORT_SEQ_RANGE + 1 } },
      { end: { afterSeq: 2 * EXPORT_SEQ_RANGE + 1, count: 4, limited: false } },
    ])
    // The key never leaves the server, and the default projection has exactly the default fields.
    expect(JSON.stringify(lines)).not.toContain('"key"')
    expect(Object.keys((lines[0] as { analysis: object }).analysis).sort()).toEqual(DEFAULT_STREAM_FIELDS.filter((field) => field !== 'error').sort())
    expect(Object.keys((lines[1] as { analysis: object }).analysis).sort()).toEqual(DEFAULT_STREAM_FIELDS.filter((field) => field !== 'result').sort())
    // Re-checked before every further window (and after the last one).
    expect(recheck).toHaveBeenCalledTimes(3)
  })

  it('sends the full representation for fields "all"', async () => {
    const { lines } = await collect({ docs: [analysis(1)], body: { fields: 'all' } })
    const first = (lines[0] as { analysis: Record<string, unknown> }).analysis
    expect(first).toMatchObject({ id: `${SCAN}-1`, scanId: SCAN, userId: OWNER, attempts: [], createdAt: '2026-01-01T00:00:00.000Z' })
    expect(first.config).toEqual({ url: 'https://example.com/1', token: '***' })
  })

  it('always sends id and seq with explicit fields, and files when URLs are requested', async () => {
    const docs = [analysis(0, { files: [FILE_1] })]
    const withUrls = await collect({ docs, body: { fields: ['result.title'] } })
    expect(withUrls.lines[0]).toEqual({
      analysis: {
        id: `${SCAN}-0`,
        seq: 0,
        result: { title: 't0' },
        files: [{ id: 'f1', name: 'report.json', size: 10, sha256: 'a'.repeat(64), contentType: 'application/json' }],
      },
      urls: { f1: `signed:${KEY_1}` },
    })
    const withoutUrls = await collect({ docs, body: { fields: ['result.title'], fileUrls: false } })
    expect(withoutUrls.lines[0]).toEqual({ analysis: { id: `${SCAN}-0`, seq: 0, result: { title: 't0' } } })
  })

  it('applies status, filter, afterSeq and untilSeq', async () => {
    const docs = [analysis(1), analysis(2, { status: 'failed' }), analysis(3, { result: { title: 'x' } }), analysis(4), analysis(9)]
    const byStatus = await collect({ docs, body: { status: ['succeeded'], afterSeq: 1, untilSeq: 4 } })
    expect(byStatus.lines.filter((line) => 'analysis' in (line as object)).map((line) => (line as { analysis: { seq: number } }).analysis.seq)).toEqual([3, 4])
    expect(byStatus.lines.at(-1)).toEqual({ end: { afterSeq: 4, count: 2, limited: false } })
    const byFilter = await collect({ docs, body: { filter: { 'result.title': 'x' } } })
    expect(byFilter.lines.filter((line) => 'analysis' in (line as object))).toHaveLength(1)
    // Every window query is scoped to the scan and its owner.
    expect(JSON.stringify(byFilter.analyses.finds[0])).toContain(`{"scanId":"${SCAN}"},{"userId":"${OWNER}"}`)
  })

  it('ends a scan without analyses (or a start after its end) at the requested position', async () => {
    expect((await collect({ docs: [] })).lines).toEqual([{ end: { afterSeq: -1, count: 0, limited: false } }])
    expect((await collect({ docs: [analysis(3)], body: { afterSeq: 7 } })).lines).toEqual([{ end: { afterSeq: 7, count: 0, limited: false } }])
  })

  it('stops after settings.limit analysis lines with limited true', async () => {
    const { lines } = await collect({ docs: SPREAD, limit: 2 })
    expect(lines.at(-1)).toEqual({ end: { afterSeq: 5, count: 2, limited: true } })
    expect(lines.filter((line) => 'analysis' in (line as object))).toHaveLength(2)
  })

  it('ends with a non-retryable error line when the re-check between windows fails', async () => {
    const recheck = async () => {
      throw new StreamStop('unauthorized', 'the script run is no longer running')
    }
    const { lines } = await collect({ docs: SPREAD, recheck })
    expect(lines.slice(-2)).toEqual([
      { checkpoint: { afterSeq: EXPORT_SEQ_RANGE - 1 } },
      { error: { code: 'unauthorized', message: 'the script run is no longer running', retryable: false } },
    ])
    expect(lines.some((line) => 'end' in (line as object))).toBe(false)
  })

  it('marks a lost cursor and an unreachable database as retryable, a query timeout not', async () => {
    const failing = (error: Error): WindowHooks => ({
      beforeFind: (index) => {
        if (index === 1) throw error
      },
    })
    const cursorLost = await collect({ docs: SPREAD, hooks: failing(new MongoServerError({ message: 'cursor id 1 not found', code: 43 })) })
    expect(cursorLost.lines.at(-1)).toEqual({ error: { code: 'unavailable', message: expect.stringContaining('cursor'), retryable: true } })
    // The resume point before the failure was announced.
    expect(cursorLost.lines.at(-2)).toEqual({ checkpoint: { afterSeq: EXPORT_SEQ_RANGE - 1 } })
    const network = await collect({ docs: SPREAD, hooks: failing(new MongoNetworkError('connection reset')) })
    expect(network.lines.at(-1)).toEqual({ error: { code: 'unavailable', message: expect.any(String), retryable: true } })
    const timeout = await collect({ docs: SPREAD, hooks: failing(new MongoServerError({ message: 'operation exceeded time limit', code: 50 })) })
    expect(timeout.lines.at(-1)).toEqual({ error: { code: 'queryTimeout', message: expect.any(String), retryable: false } })
  })

  it('ends with a retryable error line at shutdown', async () => {
    const stopping = new AbortController()
    const hooks: WindowHooks = {
      beforeFind: async (index) => {
        if (index === 1) stopping.abort()
        if (index >= 1) await new Promise((resolve) => setTimeout(resolve, 50))
      },
    }
    const { lines } = await collect({ docs: SPREAD, hooks, signal: stopping.signal })
    expect(lines.slice(-2)).toEqual([
      { checkpoint: { afterSeq: EXPORT_SEQ_RANGE - 1 } },
      { error: { code: 'unavailable', message: expect.stringContaining('stopping'), retryable: true } },
    ])
  })

  it('keeps at most one abort listener over thousands of lines and still ends on an abort', async () => {
    // A stream lives for a whole scan: each line's wait must release its abort listener (and promise reaction).
    const controller = new AbortController()
    const attached = new Map<EventListenerOrEventListenerObject, EventListener>()
    let maxAttached = 0
    let added = 0
    const signal = {
      get aborted() {
        return controller.signal.aborted
      },
      addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions) {
        const wrapper: EventListener = (event) => {
          attached.delete(listener)
          if (typeof listener === 'function') listener(event)
          else listener.handleEvent(event)
        }
        attached.set(listener, wrapper)
        added += 1
        maxAttached = Math.max(maxAttached, attached.size)
        controller.signal.addEventListener(type, wrapper, options)
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        const wrapper = attached.get(listener)
        if (!wrapper) return
        attached.delete(listener)
        controller.signal.removeEventListener(type, wrapper)
      },
    } as unknown as AbortSignal
    const analyses = streamableAnalyses()
    const total = 3000
    for (let seq = 0; seq < total; seq += 1) await analyses.fake.insertOne(analysis(seq))
    const abortAfter = 2500
    const lines: Record<string, unknown>[] = []
    for await (const raw of analysisStreamLines(planStream(scan(), { fileUrls: false }, null), {
      collection: analyses.collection,
      limits: { queryMaxTimeMs: 1000, queryMaxDocs: 10_000 },
      signal,
      recheck: async () => undefined,
      sign: (key) => key,
      keepAliveMs: 60_000,
      pause: async () => undefined,
    })) {
      lines.push(JSON.parse(raw) as Record<string, unknown>)
      if (lines.length === abortAfter) controller.abort()
    }
    expect(added).toBeGreaterThanOrEqual(abortAfter - 1)
    expect(maxAttached).toBeLessThanOrEqual(1)
    expect(attached.size).toBe(0)
    expect(lines.filter((line) => 'analysis' in line)).toHaveLength(abortAfter)
    expect(lines.slice(-2)).toEqual([
      { checkpoint: { afterSeq: abortAfter - 1 } },
      { error: { code: 'unavailable', message: expect.stringContaining('stopping'), retryable: true } },
    ])
  })

  it('sends a checkpoint line while a window is silent', async () => {
    const hooks: WindowHooks = {
      beforeFind: async (index) => {
        if (index === 0) await new Promise((resolve) => setTimeout(resolve, 60))
      },
    }
    const { lines } = await collect({ docs: [analysis(4)], hooks, keepAliveMs: 20, body: { afterSeq: 2 } })
    expect(lines[0]).toEqual({ checkpoint: { afterSeq: 2 } })
    expect(lines.filter((line) => 'analysis' in (line as object))).toHaveLength(1)
    expect(lines.at(-1)).toEqual({ end: { afterSeq: 4, count: 1, limited: false } })
  })
})

describe('planStream', () => {
  it('rejects filters and fields the export rules reject', () => {
    expect(() => planStream(scan(), { fileUrls: true, filter: { $where: 'true' } }, null)).toThrow(expect.objectContaining({ code: 'queryRejected' }))
    expect(() => planStream(scan(), { fileUrls: true, filter: { 'config.token': 'x' } }, null)).toThrow(expect.objectContaining({ code: 'queryRejected' }))
    expect(() => planStream(scan(), { fileUrls: true, fields: ['nope'] }, null)).toThrow(expect.objectContaining({ code: 'validationFailed' }))
    expect(() => planStream(scan(), { fileUrls: true, fields: ['files.key'] }, null)).toThrow(expect.objectContaining({ code: 'validationFailed' }))
  })

  it('uses the default fields, the full representation for "all" and carries the limit', () => {
    expect(planStream(scan(), { fileUrls: false }, 5)).toMatchObject({ limit: 5, fileUrls: false })
    expect(planStream(scan(), { fileUrls: false }, 5).fields?.sort()).toEqual([...DEFAULT_STREAM_FIELDS].sort())
    expect(planStream(scan(), { fileUrls: true, fields: 'all' }, null).fields).toBeNull()
  })
})

describe('streamErrorOf', () => {
  it('passes API errors through and hides unexpected ones', () => {
    expect(streamErrorOf(apiError('unavailable', 'down'))).toEqual({ code: 'unavailable', message: 'down', retryable: true })
    expect(streamErrorOf(apiError('queryRejected', 'bad', { path: 'filter' }))).toEqual({ code: 'queryRejected', message: 'bad', retryable: false })
    expect(streamErrorOf(new TypeError('boom'))).toEqual({ code: 'internal', message: expect.not.stringContaining('boom'), retryable: false })
  })
})

describe('recheckStream', () => {
  const owner: CachedUser = { id: OWNER, email: 'o@x', name: 'o', role: 'user', banned: false, banExpires: null, canRunPrivileged: false, maxWorkers: 0 }

  async function seed(runState: string, scanState: string) {
    await scriptRuns.insertOne({ _id: RUN, userId: OWNER, state: runState })
    await scans.insertOne(scan({ state: scanState as ScanDoc['state'] }))
    users.set(OWNER, owner)
  }

  it('passes while the run runs, the scan lives and the owner may sign in', async () => {
    await seed('running', 'running')
    await expect(recheckStream(principal, SCAN)).resolves.toBeUndefined()
  })

  it.each([
    ['cancelled', 'running', 'unauthorized'],
    ['running', 'deleting', 'notFound'],
  ])('stops a run in state %s reading a scan in state %s with %s', async (runState, scanState, code) => {
    await seed(runState, scanState)
    await expect(recheckStream(principal, SCAN)).rejects.toMatchObject({ name: 'StreamStop', code })
  })

  it('stops the run of a banned owner and of a scan of another user', async () => {
    await seed('running', 'running')
    users.set(OWNER, { ...owner, banned: true })
    await expect(recheckStream(principal, SCAN)).rejects.toMatchObject({ code: 'unauthorized' })
    users.set(OWNER, owner)
    await scans.updateOne({ _id: SCAN }, { $set: { userId: 'someone-else' } })
    await expect(recheckStream(principal, SCAN)).rejects.toMatchObject({ code: 'notFound' })
  })
})
