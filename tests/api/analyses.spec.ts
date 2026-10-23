import type { Analysis, AnalysisAggregateResult, AnalysisQueryResult } from '#shared/types/analyses'
import type { Page } from '#shared/types/common'
import type { Scan } from '#shared/types/scans'
import { ok, type ApiClient } from '../helpers/api-client'
import { countingPipeline, exportInline, rawJson, RESULT_SEQS, settleScan } from '../helpers/api-results'
import { expect, test as fixturesTest } from '../fixtures'
import { apiResultsTest } from '../helpers/api-results-fixtures'

const test = apiResultsTest(fixturesTest)

// Reading results (docs/api.md §4.14, §5.2): listAnalyses, getAnalysis, queryAnalyses and aggregateAnalyses over the
// worker's finished results scan of the resultset task (RESULT_ITEMS: 60 analyses, two of them failed, one with a file and
// one that succeeded in its twelfth attempt) and a second small scan of the same task for the scope checks. The
// scans are read-only for the tests; the per-user query cap is SCANTOR_USER_MAX_CONCURRENT_QUERIES = 4, the
// document cap SCANTOR_QUERY_MAX_DOCS = 10 000 and the time cap SCANTOR_QUERY_MAX_TIME = 30 s (tests/docker).

const QUERY_MAX_DOCS = 10_000
const MAX_CONCURRENT_QUERIES = 4

type ErrorBody = { error: { code: string; message: string; details?: { path?: string; issues?: { path: string; message: string }[]; limit?: number } } }

const listAnalyses = (api: ApiClient, scanId: string, query: Record<string, string | number> = {}) =>
  api.call<Page<Analysis>>('listAnalyses', { path: { scanId }, query })

const query = (api: ApiClient, scanId: string, body: Record<string, unknown>) => api.call<AnalysisQueryResult>('queryAnalyses', { path: { scanId }, body })

const aggregate = (api: ApiClient, scanId: string, pipeline: unknown[], limit?: number) =>
  api.call<AnalysisAggregateResult>('aggregateAnalyses', { path: { scanId }, body: { pipeline, limit } })

const seqs = (items: readonly object[]) => items.map((item) => (item as { seq?: unknown }).seq)
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, n) => from + n)

test.describe('analyses of a finished scan', () => {
  let scanId: string
  /** a second scan of the same task and user, with its own two analyses */
  let otherScan: Scan

  // The scans belong to the worker's resultset task and are deleted with it at worker teardown; the results scan is
  // shared with the exports spec of the same worker.
  test.beforeAll(async ({ resultsScan, resultsetTask }) => {
    const other = await resultsetTask.start({ scanConfig: { items: ['other-0', 'other-1'] } })
    scanId = resultsScan.id
    otherScan = await settleScan(resultsetTask.api, other.id, 'completed', 120_000)
  })

  test('listAnalyses pages by seq with status filters and afterSeq', { tag: ['@RES-001'] }, async ({ api }) => {
    const first = ok(await listAnalyses(api, scanId), 'listAnalyses')
    expect(seqs(first.items)).toEqual(range(0, 50))
    expect(first.nextCursor).toBe('49')
    const second = ok(await listAnalyses(api, scanId, { afterSeq: Number(first.nextCursor) }), 'listAnalyses')
    expect(seqs(second.items)).toEqual(range(50, RESULT_SEQS.total))
    expect(second.nextCursor).toBeNull()

    // Items are whole Analysis representations.
    const single = ok(await api.call<Analysis>('getAnalysis', { path: { analysisId: `${scanId}-12` } }), 'getAnalysis')
    expect(first.items[12]).toEqual(single)

    const failed = ok(await listAnalyses(api, scanId, { status: 'failed' }), 'listAnalyses')
    expect(seqs(failed.items)).toEqual([...RESULT_SEQS.failed])
    expect(failed.items.every((item) => item.status === 'failed')).toBe(true)
    const both = ok(await listAnalyses(api, scanId, { status: 'failed, succeeded', limit: 1000 }), 'listAnalyses')
    expect(seqs(both.items)).toEqual(range(0, RESULT_SEQS.total))
    expect(both.nextCursor).toBeNull()
    expect(ok(await listAnalyses(api, scanId, { status: 'pending,retrying' }), 'listAnalyses').items).toEqual([])

    const small = ok(await listAnalyses(api, scanId, { limit: 7, afterSeq: 40 }), 'listAnalyses')
    expect(seqs(small.items)).toEqual(range(41, 48))
    expect(small.nextCursor).toBe('47')
    expect(ok(await listAnalyses(api, scanId, { afterSeq: 59 }), 'listAnalyses')).toEqual({ items: [], nextCursor: null })

    for (const [key, value] of [
      ['limit', 1001],
      ['limit', 0],
      ['status', 'done'],
      ['afterSeq', 'x'],
    ] as const) {
      const response = await api.call<ErrorBody>('listAnalyses', { path: { scanId }, query: { [key]: value } })
      expect(response.status, `${key}=${value}`).toBe(400)
      expect(response.body.error.code).toBe('validationFailed')
      // A comma list is validated item by item, so its issues point at `status.<n>`.
      expect(response.body.error.details!.issues!.map((issue) => issue.path.replace(/\.\d+$/, ''))).toContain(key)
    }
  })

  test('listAnalyses?fields returns only those paths plus id and seq', { tag: ['@RES-002'] }, async ({ api }) => {
    const projected = ok(await listAnalyses(api, scanId, { fields: 'result.value,status', limit: 5 }), 'listAnalyses')
    expect(projected.items).toEqual([
      { id: `${scanId}-0`, seq: 0, status: 'succeeded', result: { value: 'file:report.txt' } },
      { id: `${scanId}-1`, seq: 1, status: 'succeeded', result: { value: '=1+1' } },
      { id: `${scanId}-2`, seq: 2, status: 'succeeded', result: { value: '+1' } },
      { id: `${scanId}-3`, seq: 3, status: 'succeeded', result: { value: '-1' } },
      { id: `${scanId}-4`, seq: 4, status: 'succeeded', result: { value: '@SUM(A1)' } },
    ])
    expect(projected.nextCursor).toBe('4')

    // A failed analysis has no result: the path is simply absent.
    const failed = ok(await listAnalyses(api, scanId, { fields: 'result.value,error.type', status: 'failed' }), 'listAnalyses')
    expect(failed.items).toEqual(RESULT_SEQS.failed.map((seq) => ({ id: `${scanId}-${seq}`, seq, error: { type: 'fatal' } })))

    // files never expose their storage keys.
    const files = ok(await listAnalyses(api, scanId, { fields: 'files', limit: 1 }), 'listAnalyses')
    expect(files.items[0]!.files).toEqual([
      { id: expect.any(String), name: 'report.txt', size: expect.any(Number), sha256: expect.any(String), contentType: 'text/plain' },
    ])

    expect(ok(await listAnalyses(api, scanId, { fields: 'id', limit: 2 }), 'listAnalyses').items).toEqual([
      { id: `${scanId}-0`, seq: 0 },
      { id: `${scanId}-1`, seq: 1 },
    ])

    for (const fields of ['nosuch', 'result.value,unknown.x', 'files.key', 'files.0.key', 'id.x', '$where', 'result..value']) {
      const response = await api.call<ErrorBody>('listAnalyses', { path: { scanId }, query: { fields } })
      expect(response.status, fields).toBe(400)
      expect(response.body.error.code, fields).toBe('validationFailed')
      expect(
        response.body.error.details!.issues!.map((issue) => issue.path.replace(/\.\d+$/, '')),
        fields,
      ).toContain('fields')
    }
  })

  test('getAnalysis returns attempts, config, result, error, log tail, timings and files', { tag: ['@RES-003'] }, async ({ api, otherApi }) => {
    const flaky = ok(await api.call<Analysis>('getAnalysis', { path: { analysisId: `${scanId}-${RESULT_SEQS.flaky}` } }), 'getAnalysis')
    expect(flaky).toMatchObject({
      id: `${scanId}-${RESULT_SEQS.flaky}`,
      scanId,
      seq: RESULT_SEQS.flaky,
      round: 1,
      status: 'succeeded',
      attempt: 12,
      config: { item: 'flaky:11', index: RESULT_SEQS.flaky },
      result: { item: 'flaky:11', value: 'flaky:11', nested: { upper: 'FLAKY:11', index: RESULT_SEQS.flaky } },
      files: [],
    })
    // At most the last ten attempts are kept.
    expect(flaky.attempts.map((attempt) => attempt.attempt)).toEqual(range(3, 13))
    for (const attempt of flaky.attempts.slice(0, -1)) {
      expect(attempt.error).toMatchObject({ type: 'taskError', message: `RuntimeError: failure in attempt ${attempt.attempt}`, retryable: true, phase: 'run' })
    }
    expect(flaky.attempts.at(-1)!.error).toBeNull()
    expect(flaky.error).toBeUndefined()
    expect(flaky.logTail).toContain('stdout flaky:11')
    expect(flaky.timings).toEqual({
      scheduledAt: expect.any(String),
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
      durationMs: expect.any(Number),
    })

    const fatal = ok(await api.call<Analysis>('getAnalysis', { path: { analysisId: `${scanId}-${RESULT_SEQS.failed[0]}` } }), 'getAnalysis')
    expect(fatal).toMatchObject({ status: 'failed', attempt: 1, error: { type: 'fatal', message: 'boom', retryable: false, phase: 'run', attempt: 1 } })
    expect(fatal.result).toBeUndefined()
    expect(fatal.attempts).toHaveLength(1)

    const withFile = ok(await api.call<Analysis>('getAnalysis', { path: { analysisId: `${scanId}-${RESULT_SEQS.file}` } }), 'getAnalysis')
    expect(withFile.files).toHaveLength(1)
    expect(Object.keys(withFile.files[0]!).sort()).toEqual(['contentType', 'id', 'name', 'sha256', 'size'])
    expect(withFile.result!.report).toEqual(withFile.files[0])

    for (const analysisId of [
      `${scanId}-${RESULT_SEQS.total}`,
      `${scanId}-999999`,
      `${scanId}-x`,
      `${scanId}-01`,
      `${scanId}--1`,
      scanId,
      `${scanId}-1.5`,
      'nope-1',
    ]) {
      const response = await api.call<ErrorBody>('getAnalysis', { path: { analysisId } })
      expect(response.status, analysisId).toBe(404)
      expect(response.body.error.code).toBe('notFound')
    }
    // Another user's analysis is 404, never 403.
    const foreign = await otherApi.call<ErrorBody>('getAnalysis', { path: { analysisId: `${scanId}-0` } })
    expect(foreign.status).toBe(404)
    expect(foreign.body.error.code).toBe('notFound')
  })

  test('queryAnalyses filters, projects and pages within the scan', { tag: ['@RES-004'] }, async ({ api }) => {
    const first = ok(await query(api, scanId, { filter: {} }), 'queryAnalyses')
    expect(seqs(first.items)).toEqual(range(0, 20))
    expect(first.nextCursor).toBe('19')
    const second = ok(await query(api, scanId, { filter: {}, afterSeq: 19 }), 'queryAnalyses')
    expect(seqs(second.items)).toEqual(range(20, 40))

    const failed = ok(await query(api, scanId, { filter: { status: 'failed' }, projection: { seq: 1, 'error.message': 1 } }), 'queryAnalyses')
    expect(failed).toEqual({
      items: [
        { id: `${scanId}-8`, seq: 8, error: { message: 'boom' } },
        { id: `${scanId}-9`, seq: 9, error: { message: 'bang' } },
      ],
      nextCursor: null,
    })

    const formula = ok(await query(api, scanId, { filter: { 'result.value': '=1+1' }, projection: { 'result.value': 1 } }), 'queryAnalyses')
    expect(formula.items).toEqual([{ id: `${scanId}-1`, result: { value: '=1+1' } }])

    // The scope cannot be widened: naming the user's other scan, or any scan, stays inside this one.
    expect(ok(await query(api, scanId, { filter: { scanId: otherScan.id } }), 'queryAnalyses')).toEqual({ items: [], nextCursor: null })
    const everything = ok(await query(api, scanId, { filter: { scanId: { $ne: null } }, projection: { scanId: 1 }, limit: 1000 }), 'queryAnalyses')
    expect(everything.items).toHaveLength(RESULT_SEQS.total)
    expect(new Set(everything.items.map((item) => item.scanId))).toEqual(new Set([scanId]))
    expect(ok(await query(api, otherScan.id, { filter: {} }), 'queryAnalyses').items.map((item) => (item.config as { item: string }).item)).toEqual([
      'other-0',
      'other-1',
    ])

    // Excluding _id still pages by seq.
    const noId = ok(await query(api, scanId, { filter: {}, projection: { _id: 0, seq: 1 }, limit: 5 }), 'queryAnalyses')
    expect(noId).toEqual({ items: range(0, 5).map((seq) => ({ seq })), nextCursor: '4' })
    expect(ok(await query(api, scanId, { filter: {}, projection: { _id: 0, seq: 1 }, limit: 5, afterSeq: 4 }), 'queryAnalyses').items).toEqual(
      range(5, 10).map((seq) => ({ seq })),
    )

    // With a sort there is no cursor.
    const sorted = ok(await query(api, scanId, { filter: {}, projection: { seq: 1 }, sort: { seq: -1 }, limit: 3 }), 'queryAnalyses')
    expect(sorted).toEqual({ items: [57, 58, 59].reverse().map((seq) => ({ id: `${scanId}-${seq}`, seq })), nextCursor: null })

    expect(ok(await query(api, scanId, { filter: {}, limit: 1000 }), 'queryAnalyses').items).toHaveLength(RESULT_SEQS.total)
    for (const body of [{ filter: {}, limit: 1001 }, { filter: {}, limit: 0 }, { filter: [] }, {}]) {
      const response = await api.call<ErrorBody>('queryAnalyses', { path: { scanId }, body })
      expect(response.status, JSON.stringify(body)).toBe(400)
      expect(response.body.error.code).toBe('validationFailed')
    }
  })

  test('sort keys are dot paths with 1 or -1, at most eight of them', { tag: ['@RES-005'] }, async ({ api }) => {
    for (const sort of [{ seq: 2 }, { seq: 'asc' }, { seq: 0 }, { $natural: 1 }, { 'result.$x': 1 }]) {
      const response = await api.call<ErrorBody>('queryAnalyses', { path: { scanId }, body: { filter: {}, sort } })
      expect(response.status, JSON.stringify(sort)).toBe(400)
      expect(response.body.error.code).toBe('validationFailed')
      expect(response.body.error.details!.issues![0]!.path).toMatch(/^sort/)
    }
    const keys = ['status', 'round', 'attempt', 'result.index', 'result.value', 'config.index', 'createdAt', 'seq']
    const eight = Object.fromEntries(keys.map((key, n) => [key, n % 2 === 0 ? 1 : -1]))
    const allowed = ok(await query(api, scanId, { filter: {}, projection: { seq: 1 }, sort: eight, limit: 3 }), 'queryAnalyses')
    expect(allowed.items).toHaveLength(3)
    const nine = await api.call<ErrorBody>('queryAnalyses', { path: { scanId }, body: { filter: {}, sort: { ...eight, updatedAt: 1 } } })
    expect(nine.status).toBe(400)
    expect(nine.body.error).toMatchObject({ code: 'queryRejected', details: { path: 'sort' } })
  })

  test('aggregateAnalyses runs allowlisted stages and rejects everything else', { tag: ['@RES-006'] }, async ({ api }) => {
    const grouped = ok(await aggregate(api, scanId, [{ $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { _id: 1 } }]), 'aggregateAnalyses')
    expect(grouped).toEqual({
      items: [
        { _id: 'failed', n: 2 },
        { _id: 'succeeded', n: RESULT_SEQS.total - 2 },
      ],
      truncated: false,
    })
    const facet = ok(
      await aggregate(api, scanId, [{ $facet: { all: [{ $count: 'n' }], failed: [{ $match: { status: 'failed' } }, { $count: 'n' }] } }]),
      'aggregateAnalyses',
    )
    expect(facet.items).toEqual([{ all: [{ n: RESULT_SEQS.total }], failed: [{ n: 2 }] }])
    const sampled = ok(await aggregate(api, scanId, [{ $sample: { size: 10_000 } }, { $count: 'n' }]), 'aggregateAnalyses')
    expect(sampled.items).toEqual([{ n: RESULT_SEQS.total }])
    const stages100 = ok(await aggregate(api, scanId, [...Array.from({ length: 99 }, () => ({ $match: {} })), { $count: 'n' }]), 'aggregateAnalyses')
    expect(stages100.items).toEqual([{ n: RESULT_SEQS.total }])

    const rejected: [unknown[], string][] = [
      [[{ $facet: { a: [{ $facet: { b: [] } }] } }], 'pipeline.0.$facet.a.0.$facet'],
      [[{ $sample: { size: 10_001 } }], 'pipeline.0.$sample.size'],
      [[{ $match: {}, $limit: 1 }], 'pipeline.0'],
      [[{ $lookup: { from: 'scans', localField: 'scanId', foreignField: '_id', as: 's' } }], 'pipeline.0.$lookup'],
      [[{ $out: 'x' }], 'pipeline.0.$out'],
      [[{ $match: { $where: 'true' } }], 'pipeline.0.$match.$where'],
      [[{ $facet: { a: [{ $unionWith: 'scans' }] } }], 'pipeline.0.$facet.a.0.$unionWith'],
    ]
    for (const [pipeline, path] of rejected) {
      const response = await api.call<ErrorBody>('aggregateAnalyses', { path: { scanId }, body: { pipeline } })
      expect(response.status, JSON.stringify(pipeline)).toBe(400)
      expect(response.body.error, JSON.stringify(pipeline)).toMatchObject({ code: 'queryRejected', details: { path } })
    }
    const tooMany = await api.call<ErrorBody>('aggregateAnalyses', {
      path: { scanId },
      body: { pipeline: Array.from({ length: 101 }, () => ({ $match: {} })) },
    })
    expect(tooMany.status).toBe(400)
    expect(tooMany.body.error.code).toBe('validationFailed')
  })

  test('aggregation results above limit or SCANTOR_QUERY_MAX_DOCS are truncated', { tag: ['@RES-007'] }, async ({ api }) => {
    const bySeq = [{ $sort: { seq: 1 } }, { $project: { _id: 0, seq: 1 } }]
    expect(ok(await aggregate(api, scanId, bySeq, 5), 'aggregateAnalyses')).toEqual({ items: range(0, 5).map((seq) => ({ seq })), truncated: true })
    expect(ok(await aggregate(api, scanId, bySeq, RESULT_SEQS.total), 'aggregateAnalyses')).toMatchObject({ truncated: false })

    // One analysis unwound into more documents than the instance cap; a larger limit is clamped to the cap.
    const many = [{ $limit: 1 }, { $project: { _id: 0, n: { $range: [0, QUERY_MAX_DOCS + 5] } } }, { $unwind: '$n' }]
    const capped = ok(await aggregate(api, scanId, many), 'aggregateAnalyses')
    expect(capped.truncated).toBe(true)
    expect(capped.items).toHaveLength(QUERY_MAX_DOCS)
    expect(capped.items.at(-1)).toEqual({ n: QUERY_MAX_DOCS - 1 })
    const clamped = ok(await aggregate(api, scanId, many, QUERY_MAX_DOCS * 3), 'aggregateAnalyses')
    expect(clamped.truncated).toBe(true)
    expect(clamped.items).toHaveLength(QUERY_MAX_DOCS)
  })

  test('a query running longer than SCANTOR_QUERY_MAX_TIME returns 504 queryTimeout', { tag: ['@RES-008'] }, async ({ api }) => {
    test.setTimeout(180_000)
    const started = Date.now()
    const response = await rawJson<ErrorBody>(api, 'POST', `/api/scans/${scanId}/analyses/aggregate`, {
      data: { pipeline: countingPipeline(100_000, 100_000) },
      timeoutMs: 120_000,
    })
    expect(response.status, response.text.slice(0, 500)).toBe(504)
    expect(response.body.error.code).toBe('queryTimeout')
    expect(Date.now() - started).toBeGreaterThanOrEqual(29_000)
  })

  test('more than SCANTOR_USER_MAX_CONCURRENT_QUERIES concurrent queries of one user return 429', { tag: ['@RES-009'] }, async ({ api }) => {
    test.setTimeout(180_000)
    // One more aggregation than the cap, each keeping MongoDB busy for seconds: the first answer is the 429 of the
    // one that found every slot taken, so the other four still hold all slots of the user afterwards.
    const slow = () =>
      rawJson<ErrorBody>(api, 'POST', `/api/scans/${scanId}/analyses/aggregate`, { data: { pipeline: countingPipeline(20_000, 10_000) }, timeoutMs: 120_000 })
    const holders = Array.from({ length: MAX_CONCURRENT_QUERIES + 1 }, slow)
    const first = await Promise.race(holders)
    expect(first.status, first.text.slice(0, 300)).toBe(429)
    expect(first.body.error).toMatchObject({ code: 'tooManyRequests', details: { limit: MAX_CONCURRENT_QUERIES } })

    // Queries, aggregations and inline exports share the cap.
    const blocked = {
      query: await query(api, scanId, { filter: {}, limit: 1 }),
      aggregate: await aggregate(api, scanId, [{ $count: 'n' }]),
      export: await exportInline(api, scanId, { format: 'jsonl' }),
    }
    const results = await Promise.all(holders)
    for (const [what, response] of Object.entries(blocked)) {
      expect(response.status, what).toBe(429)
      expect((response.body as ErrorBody).error, what).toMatchObject({ code: 'tooManyRequests', details: { limit: MAX_CONCURRENT_QUERIES } })
    }
    expect(results.filter((result) => result.status === 429)).toHaveLength(1)
    for (const result of results.filter((candidate) => candidate.status !== 429)) expect([200, 504], result.text.slice(0, 300)).toContain(result.status)

    // The slots are free again.
    expect(ok(await query(api, scanId, { filter: {}, limit: 1 }), 'queryAnalyses').items).toHaveLength(1)
  })
})
