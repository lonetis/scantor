import type { Analysis } from '#shared/types/analyses'
import type { JobAccepted, Page } from '#shared/types/common'
import type { Export } from '#shared/types/exports'
import type { Scan } from '#shared/types/scans'
import { ok, type ApiClient } from '../helpers/api-client'
import { callLong, download, exportInline, finishScanDeletion, parseCsv, RESULT_SEQS, settledJob, settleScan } from '../helpers/api-results'
import { stackEnv } from '../helpers/docker'
import { expect, test as fixturesTest } from '../fixtures'
import { apiResultsTest } from '../helpers/api-results-fixtures'

const test = apiResultsTest(fixturesTest)

// Exports (docs/api.md §4.15, security.md DL-2): inline JSONL and CSV streams and background exports with presigned
// downloads, over one finished scan of the resultset task per worker (RESULT_ITEMS: 60 analyses, among them values
// that start with spreadsheet formula characters and one that needs RFC 4180 quoting). SCANTOR_EXPORT_INLINE_MAX is
// 50 000 and SCANTOR_EXPORT_RETENTION_DAYS 7 in the test stack.

const EXPORT_INLINE_MAX = 50_000
const DEFAULT_CSV_HEADER = 'id,seq,status,attempt,round,error.type,error.message,timings.durationMs,config,result'
const DAY_MS = 86_400_000

type ErrorBody = { error: { code: string; message: string; details?: { path?: string; issues?: { path: string }[]; limit?: number; state?: string } } }

function inlineExport(api: ApiClient, scanId: string, query: Record<string, string | number> = {}) {
  return exportInline<ErrorBody>(api, scanId, query)
}

function jsonLines(text: string): Record<string, unknown>[] {
  expect(text.endsWith('\n')).toBe(true)
  return text
    .slice(0, -1)
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function readyExport(api: ApiClient, scanId: string, body: Record<string, unknown>): Promise<Export> {
  const created = await callLong<Export>(api, 'exportScan', { path: { scanId }, body, query: { wait: 60 } }, 90_000)
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  if (created.body.state === 'ready') return created.body
  const settled = ok(await callLong<Export>(api, 'getExport', { path: { exportId: created.body.id }, query: { wait: 60 } }, 90_000), 'getExport')
  expect(settled.state, JSON.stringify(settled.error)).toBe('ready')
  return settled
}

test.describe('exports of a finished scan', () => {
  let scanId: string

  // The results scan belongs to the worker's resultset task (shared with the analyses spec of the same worker).
  test.beforeAll(({ resultsScan }) => {
    scanId = resultsScan.id
  })

  test('the inline export streams JSONL or CSV in seq order as an attachment', { tag: ['@RES-010'] }, async ({ api }) => {
    const jsonl = await inlineExport(api, scanId, { format: 'jsonl' })
    expect(jsonl.status).toBe(200)
    expect(jsonl.headers['content-type']).toMatch(/^application\/x-ndjson/)
    expect(jsonl.headers['content-disposition']).toMatch(new RegExp(`^attachment; filename="scantor-${scanId}\\.jsonl"`))
    expect(jsonLines(jsonl.raw.toString('utf8')).map((row) => row.seq)).toEqual(Array.from({ length: RESULT_SEQS.total }, (_, n) => n))
    // jsonl is the default format.
    expect((await inlineExport(api, scanId)).raw.equals(jsonl.raw)).toBe(true)

    const csv = await inlineExport(api, scanId, { format: 'csv' })
    expect(csv.status).toBe(200)
    expect(csv.headers['content-type']).toMatch(/^text\/csv/)
    expect(csv.headers['content-disposition']).toMatch(new RegExp(`^attachment; filename="scantor-${scanId}\\.csv"`))
    expect(
      parseCsv(csv.raw.toString('utf8'))
        .slice(1)
        .map((row) => Number(row[1])),
    ).toEqual(Array.from({ length: RESULT_SEQS.total }, (_, n) => n))

    const selections: [Record<string, string | number>, number[]][] = [
      [{ status: 'failed' }, [...RESULT_SEQS.failed]],
      [{ afterSeq: 55 }, [56, 57, 58, 59]],
      [{ filter: JSON.stringify({ 'result.value': '-1' }) }, [3]],
      [{ filter: JSON.stringify({ seq: { $gte: 50 } }), status: 'succeeded', afterSeq: 57 }, [58, 59]],
    ]
    for (const [query, expected] of selections) {
      const response = await inlineExport(api, scanId, { ...query, fields: 'seq' })
      expect(response.status, JSON.stringify(query)).toBe(200)
      expect(
        jsonLines(response.raw.toString('utf8')).map((row) => row.seq),
        JSON.stringify(query),
      ).toEqual(expected)
    }
    const empty = await inlineExport(api, scanId, { status: 'lost' })
    expect(empty.status).toBe(200)
    expect(empty.raw.length).toBe(0)

    for (const filter of ['not json', '[1]', '"text"', '42', 'null', '{"seq":']) {
      const response = await inlineExport(api, scanId, { filter })
      expect(response.status, filter).toBe(400)
      expect(response.body.error.code, filter).toBe('validationFailed')
      expect(
        response.body.error.details!.issues!.map((issue) => issue.path),
        filter,
      ).toEqual(['filter'])
    }
  })

  test(
    'a CSV export has the default header, JSON-encoded nested values, RFC 4180 quoting, CRLF and formula escaping',
    { tag: ['@RES-012'] },
    async ({ api }) => {
      const text = (await inlineExport(api, scanId, { format: 'csv' })).raw.toString('utf8')
      expect(text.startsWith(`${DEFAULT_CSV_HEADER}\r\n`)).toBe(true)
      const rows = parseCsv(text)
      expect(rows).toHaveLength(RESULT_SEQS.total + 1)
      const header = rows[0]!
      const cell = (seq: number, column: string) => rows[seq + 1]![header.indexOf(column)]!
      expect(cell(12, 'id')).toBe(`${scanId}-12`)
      expect(cell(12, 'status')).toBe('succeeded')
      expect(cell(12, 'round')).toBe('1')
      expect(JSON.parse(cell(12, 'config'))).toEqual({ item: 'ok-1', index: 12 })
      expect(JSON.parse(cell(12, 'result'))).toMatchObject({ item: 'ok-1', index: 12, nested: { upper: 'OK-1', index: 12 }, report: null })
      expect(cell(8, 'error.type')).toBe('fatal')
      expect(cell(8, 'error.message')).toBe('boom')
      expect(cell(8, 'result')).toBe('')

      const valued = await inlineExport(api, scanId, { format: 'csv', fields: 'seq,result.value', afterSeq: 0, filter: JSON.stringify({ seq: { $lte: 7 } }) })
      const valuedText = valued.raw.toString('utf8')
      expect(parseCsv(valuedText)).toEqual([
        ['seq', 'result.value'],
        ['1', "'=1+1"],
        ['2', "'+1"],
        ['3', "'-1"],
        ['4', "'@SUM(A1)"],
        ['5', "'\tx"],
        ['6', "'\rx"],
        ['7', 'a,b "q"\nline'],
      ])
      // Cells with a CR, a quote, a comma or a line break are quoted; quotes are doubled.
      expect(valuedText).toContain('\r\n6,"\'\rx"\r\n')
      expect(valuedText).toContain('\r\n7,"a,b ""q""\nline"\r\n')
      expect(valuedText).toContain("\r\n1,'=1+1\r\n")

      // The background export writes the same bytes.
      const background = await readyExport(api, scanId, { format: 'csv', fields: ['seq', 'result.value'], afterSeq: 0, filter: { seq: { $lte: 7 } } })
      expect((await download(background.download!.url)).body.toString('utf8')).toBe(valuedText)
    },
  )

  test('JSONL rows are whole masked analyses, or the fields projection', { tag: ['@RES-013'] }, async ({ api }) => {
    const rows = jsonLines((await inlineExport(api, scanId)).raw.toString('utf8'))
    for (const seq of [RESULT_SEQS.file, RESULT_SEQS.failed[0], RESULT_SEQS.flaky, 59]) {
      const analysis = ok(await api.call<Analysis>('getAnalysis', { path: { analysisId: `${scanId}-${seq}` } }), 'getAnalysis')
      expect(rows[seq], `seq ${seq}`).toEqual(analysis)
    }
    const projected = jsonLines((await inlineExport(api, scanId, { fields: 'status,result.value,error.type' })).raw.toString('utf8'))
    expect(projected[1]).toEqual({ status: 'succeeded', result: { value: '=1+1' } })
    expect(projected[8]).toEqual({ status: 'failed', error: { type: 'fatal' } })
    for (const row of projected) expect(Object.keys(row).every((key) => ['status', 'result', 'error'].includes(key))).toBe(true)
  })

  test('a background export becomes ready with a download equal to the inline export', { tag: ['@RES-014'] }, async ({ api }) => {
    const before = Date.now()
    const created = await api.call<Export>('exportScan', { path: { scanId }, body: { format: 'jsonl' } })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ scanId, format: 'jsonl', filter: {}, fields: null, afterSeq: null, error: null, jobId: expect.any(String) })
    expect(['queued', 'running', 'ready']).toContain(created.body.state)

    const held = await callLong<Export>(api, 'getExport', { path: { exportId: created.body.id }, query: { wait: 60 } }, 90_000)
    expect(held.status).toBe(200)
    expect(held.headers['scantor-wait']).toBe('settled')
    const ready = held.body
    const inline = (await inlineExport(api, scanId, { format: 'jsonl' })).raw
    expect(ready).toMatchObject({ state: 'ready', rows: RESULT_SEQS.total, bytes: inline.length, finishedAt: expect.any(String) })
    expect(Date.parse(ready.download!.expiresAt) - before).toBeGreaterThan(9 * 60_000)
    expect(Date.parse(ready.download!.expiresAt) - Date.now()).toBeLessThanOrEqual(10 * 60_000 + 5000)

    const fetched = await download(ready.download!.url)
    expect(fetched.status).toBe(200)
    expect(fetched.headers['content-disposition']).toMatch(/^attachment; filename="scantor-/)
    expect(fetched.body.equals(inline)).toBe(true)

    // With a selection: the same rows as the inline export with the same parameters.
    const selected = await readyExport(api, scanId, { format: 'jsonl', filter: { status: 'succeeded' }, fields: ['seq', 'result.text'], afterSeq: 50 })
    expect(selected).toMatchObject({ filter: { status: 'succeeded' }, fields: ['seq', 'result.text'], afterSeq: 50, rows: 9 })
    const selectedInline = await inlineExport(api, scanId, { filter: JSON.stringify({ status: 'succeeded' }), fields: 'seq,result.text', afterSeq: 50 })
    expect((await download(selected.download!.url)).body.equals(selectedInline.raw)).toBe(true)

    for (const body of [{}, { format: 'xml' }, { format: 'csv', fields: [] }, { format: 'csv', fields: ['nosuch'] }]) {
      const response = await api.call<ErrorBody>('exportScan', { path: { scanId }, body })
      expect(response.status, JSON.stringify(body)).toBe(400)
      expect(response.body.error.code).toBe('validationFailed')
    }
  })

  test('listExports pages newest first; deleteExport removes the export and its object; exports expire', { tag: ['@RES-016'] }, async ({ api, otherApi }) => {
    const first = await readyExport(api, scanId, { format: 'jsonl', fields: ['seq'] })
    const second = await readyExport(api, scanId, { format: 'csv', fields: ['seq'] })
    const third = await readyExport(api, scanId, { format: 'jsonl', fields: ['status'] })
    const retentionDays = Number(stackEnv().SCANTOR_EXPORT_RETENTION_DAYS ?? 7)
    for (const created of [first, second, third]) expect(Date.parse(created.expiresAt) - Date.parse(created.createdAt)).toBe(retentionDays * DAY_MS)

    const listed: Export[] = []
    let cursor: string | undefined
    do {
      const page = ok(await api.call<Page<Export>>('listExports', { query: { scanId, limit: 2, cursor } }), 'listExports')
      expect(page.items.length).toBeLessThanOrEqual(2)
      listed.push(...page.items)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    const mine = listed.map((item) => item.id).filter((id) => [first.id, second.id, third.id].includes(id))
    expect(mine).toEqual([third.id, second.id, first.id])
    expect(listed.every((item) => item.scanId === scanId)).toBe(true)
    expect(listed.find((item) => item.id === third.id)!.download).toEqual({ url: expect.any(String), expiresAt: expect.any(String) })
    const foreign = ok(await otherApi.call<Page<Export>>('listExports', { query: { scanId } }), 'listExports')
    expect(foreign.items).toEqual([])
    expect((await otherApi.call('getExport', { path: { exportId: first.id } })).status).toBe(404)
    expect((await otherApi.call('deleteExport', { path: { exportId: first.id } })).status).toBe(404)

    // A settled export returns at once with wait.
    const settled = await api.call<Export>('getExport', { path: { exportId: first.id }, query: { wait: 30 } })
    expect(settled.headers['scantor-wait']).toBe('settled')

    const url = first.download!.url
    expect((await download(url)).status).toBe(200)
    const deleted = await api.call('deleteExport', { path: { exportId: first.id } })
    expect(deleted.status).toBe(204)
    expect((await api.call('getExport', { path: { exportId: first.id } })).status).toBe(404)
    expect((await api.call('deleteExport', { path: { exportId: first.id } })).status).toBe(404)
    // The stored object is gone: the presigned URL of the old download no longer serves it.
    expect((await download(url)).status).toBe(404)

    // Deleting an export whose job has not finished cancels the job.
    const pending = ok(await api.call<Export>('exportScan', { path: { scanId }, body: { format: 'csv' } }), 'exportScan')
    expect((await api.call('deleteExport', { path: { exportId: pending.id } })).status).toBe(204)
    const job = await settledJob(api, pending.jobId)
    expect(['cancelled', 'succeeded']).toContain(job.state)
    expect((await api.call('getExport', { path: { exportId: pending.id } })).status).toBe(404)
    for (const created of [second, third]) ok(await api.call('deleteExport', { path: { exportId: created.id } }), 'deleteExport')
  })
})

// These tests export scans of their own, so they run in parallel with the tests of the shared results scan.
test.describe('exports of scans of their own', () => {
  test(
    'an inline export matching more than SCANTOR_EXPORT_INLINE_MAX analyses is 409 exportTooLarge',
    { tag: ['@RES-011'] },
    async ({ api, docker, resultset }) => {
      test.setTimeout(180_000)
      // White-box: running 50 001 real analyses would occupy the shared stack for minutes, so the analyses of a finished
      // one-item scan are seeded directly (seqs 1…50 000 next to the real seq 0); nothing else writes to the scan, and
      // its deletion removes them.
      const scan = await settleScan(api, (await resultset.start({ scanConfig: { items: ['seed'] } })).id)
      const inserted = await docker.mongosh(
        `const scanId = ${JSON.stringify(scan.id)}, userId = ${JSON.stringify(scan.userId)}, now = new Date(), docs = [];
       for (let seq = 1; seq <= ${EXPORT_INLINE_MAX}; seq++) docs.push({ _id: scanId + '-' + seq, scanId, userId, seq, round: 1, status: 'succeeded', attempt: 1, attempts: [], files: [], config: { item: 'seeded', index: seq }, result: { value: 'seeded' }, createdAt: now, updatedAt: now });
       print(Object.keys(db.analyses.insertMany(docs, { ordered: false }).insertedIds).length)`,
        { as: 'root' },
      )
      expect(Number(inserted)).toBe(EXPORT_INLINE_MAX)

      const tooLarge = await inlineExport(api, scan.id, { format: 'jsonl' })
      expect(tooLarge.status).toBe(409)
      expect(tooLarge.body.error).toMatchObject({ code: 'exportTooLarge', details: { limit: EXPORT_INLINE_MAX } })
      expect((await inlineExport(api, scan.id, { format: 'csv', status: 'succeeded' })).status).toBe(409)

      // Exactly the cap, or a narrower selection, streams.
      const atCap = await inlineExport(api, scan.id, { fields: 'seq', afterSeq: 0 })
      expect(atCap.status).toBe(200)
      expect(atCap.raw.toString('utf8').split('\n').filter(Boolean)).toHaveLength(EXPORT_INLINE_MAX)
      const narrow = await inlineExport(api, scan.id, { fields: 'seq', filter: JSON.stringify({ seq: { $lt: 3 } }) })
      expect(narrow.raw.toString('utf8')).toBe('{"seq":0}\n{"seq":1}\n{"seq":2}\n')
    },
  )

  test('exporting a deleting or deleted scan is 409 invalidState', { tag: ['@RES-015'] }, async ({ api, resultset }) => {
    const scan: Scan = await settleScan(api, (await resultset.start({ scanConfig: { items: ['gone'] } })).id)
    const deleted = ok(await api.call<JobAccepted & { scan: Scan }>('deleteScan', { path: { scanId: scan.id } }), 'deleteScan')
    expect(deleted.scan.state).toBe('deleting')

    const inline = await inlineExport(api, scan.id)
    const background = await api.call<ErrorBody>('exportScan', { path: { scanId: scan.id }, body: { format: 'jsonl' } })
    for (const response of [inline, background]) {
      expect(response.status).toBe(409)
      expect(response.body.error).toMatchObject({ code: 'invalidState', details: { state: 'deleting' } })
    }

    // The deleted tombstone (the delete job's final step is applied directly, see finishScanDeletion).
    await finishScanDeletion(scan.id)
    expect(ok(await api.getScan(scan.id), 'getScan').state).toBe('deleted')
    for (const response of [
      await inlineExport(api, scan.id, { format: 'csv' }),
      await api.call<ErrorBody>('exportScan', { path: { scanId: scan.id }, body: { format: 'csv' } }),
    ]) {
      expect(response.status).toBe(409)
      expect(response.body.error).toMatchObject({ code: 'invalidState', details: { state: 'deleted' } })
    }
  })
})
