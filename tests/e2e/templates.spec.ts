import type { TestRun } from '#shared/types/test-runs'
import type { Upload } from '#shared/types/uploads'
import { ok, type ApiClient } from '../helpers/api-client'
import { stackEnv } from '../helpers/docker'
import { allAnalyses, configIssues, estimateTemplate, getScan, pollScan, scanWorkers } from '../helpers/e2e-runtime'
import { scantor } from '../helpers/cli'
import { FlakyDataSource } from '../helpers/e2e-runtime-datasource'
import { extendRuntime } from '../helpers/e2e-runtime-fixtures'
import { removeGeneratedTask, writeGeneratedTask } from '../helpers/e2e-runtime-tasks'
import { FIXTURES_URL } from '../helpers/fixtures-server'
import { expect, test as base } from '../fixtures'

// Templates end to end (docs/templates.md §2–§9): every template runs natively (unwrapped) in a real scan on the
// built-in node, with its estimate, its resolution (`scheduling.resolved`) and its errors; a wrapped template streams
// into user code; a resumed scheduler reuses the stored resolution; test runs read uploads and the data sources.
// Tranco and CrUX data come from the fixtures server (SCANTOR_TRANCO_URL, SCANTOR_CRUX_URL of the test stack), whose
// lists are generated relative to its start: Tranco lists of the three days before it (1000 domains siteN.example,
// www.siteN.example with subdomains), CrUX lists of the two months before it for global, de and us (1000 origins in
// bucket 1000, 400 in 5000, 100 in 10000; every tenth origin is http://).

const test = extendRuntime(base)

test.describe.configure({ timeout: 180_000 })

// The run publishes the file's tasks once, all at the same time (helpers/e2e-runtime-fixtures.ts).
test.beforeAll(async ({ shared }) => {
  // Publishing builds images; the stack builds at most SCANTOR_BUILD_CONCURRENCY of them at a time for every user.
  test.setTimeout(300_000)
  await Promise.all([
    shared.example('echo'),
    shared.generated('probe'),
    shared.generated('wrap'),
    ...(['tpl-list', 'tpl-range', 'tpl-tranco', 'tpl-crux', 'tpl-cidr'] as const).map((kind) => shared.generated(kind)),
  ])
})

const TWO_RUNNERS = { workers: 2, processes: 2, resources: { cpus: 0.25, memoryMiB: 256 } }

interface TrancoMetadata {
  list_id: string
  configuration: { endDate: string }
}

async function trancoMetadata(path: string): Promise<TrancoMetadata> {
  const response = await fetch(`${FIXTURES_URL}/tranco${path}`)
  if (!response.ok) throw new Error(`fixtures server ${path}: ${response.status}`)
  return (await response.json()) as TrancoMetadata
}

/** The month (YYYYMM) `latest` resolves to: the newest of the current UTC month and the 3 before it that exists. */
async function latestCruxMonth(path: string): Promise<string> {
  const now = new Date()
  for (let back = 0; back < 4; back++) {
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))
    const name = `${month.getUTCFullYear()}${String(month.getUTCMonth() + 1).padStart(2, '0')}`
    if ((await fetch(`${FIXTURES_URL}/crux/${path}/${name}.csv.gz`, { method: 'HEAD' })).status === 200) return name
  }
  throw new Error(`the fixtures server has no CrUX list at ${path} in the last 4 months`)
}

/** The `n`-th origin (1-based) of a fixture CrUX list: https except every tenth. */
function cruxOrigin(n: number, host: string): string {
  return `${n % 10 === 0 ? 'http' : 'https'}://site${n}.${host}`
}

async function createListUpload(api: ApiClient, content: string): Promise<Upload> {
  const response = await api.call<Upload>('createUpload', {
    query: { name: 'list.txt', kind: 'list' },
    body: Buffer.from(content, 'utf8'),
    headers: { 'Content-Type': 'text/plain' },
  })
  return ok(response, 'createUpload')
}

/** Starts a test run and waits until it settled (completed, failed or cancelled). */
async function testRun(api: ApiClient, task: string, body: Record<string, unknown>): Promise<TestRun> {
  const created = ok(await api.call<TestRun>('testTask', { path: { task }, body, query: { wait: 120 } }), 'testTask')
  const deadline = Date.now() + 150_000
  for (let run = created; ;) {
    if (run.state === 'completed' || run.state === 'failed' || run.state === 'cancelled') {
      if (run.analyses) return run
      return ok(await api.call<TestRun>('getTestRun', { path: { testRunId: run.id }, query: { analyses: true } }), 'getTestRun')
    }
    if (Date.now() > deadline) throw new Error(`test run ${run.id} is still ${run.state}`)
    run = ok(await api.call<TestRun>('getTestRun', { path: { testRunId: run.id }, query: { wait: 60, analyses: true } }), 'getTestRun')
  }
}

test.describe('template single', () => {
  test('a task without a schedule yields exactly one analysis with an empty config', { tag: ['@TPL-001', '@TPL-010'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.example('echo')
    expect(revision.description?.schedule).toEqual({ kind: 'template', template: 'single' })
    expect(ok(await estimateTemplate(api, 'single', {}), 'estimateTemplate')).toMatchObject({ expectedTotal: 1, exact: true })

    const started = await scans.start({ revision: revision.ref, taskConfig: { text: 'single' } })
    expect(started.stats.expectedTotal).toBe(1)
    const scan = await scans.wait(started.id)
    expect(scan.scheduling.resolved.schedule).toMatchObject({ template: 'single', scanConfig: {}, provenance: {}, expectedTotal: 1 })
    expect(scan.stats.expectedTotal).toBe(1)
    expect(scan.scheduling.confirmed).toBe(1)

    const analyses = await allAnalyses(api, scan.id, ['config', 'result', 'status'])
    expect(analyses).toEqual([expect.objectContaining({ seq: 0, status: 'succeeded', config: {}, result: { echo: 'single' } })])
  })
})

test.describe('template list', () => {
  test('combines inline items and upload lines, trimmed, with offset and limit', { tag: ['@TPL-002', '@TPL-010'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.generated('tpl-list')
    // 4 lines after trimming: whitespace-only and empty lines are skipped and not counted.
    const upload = await createListUpload(api, '  alpha \n\n\tbeta\r\n   \ngamma\ndelta\n')
    expect(upload).toMatchObject({ kind: 'list', lines: 4 })

    // Combined sequence: one(0) two(1) alpha(2) beta(3) gamma(4) delta(5); the whitespace-only item is skipped.
    const scanConfig = { items: ['  one ', ' \t ', 'two'], upload: upload.id, offset: 1, limit: 3 }
    expect(ok(await estimateTemplate(api, 'list', scanConfig), 'estimateTemplate')).toMatchObject({ expectedTotal: 3, exact: true })
    expect(ok(await estimateTemplate(api, 'list', { ...scanConfig, limit: null }), 'estimateTemplate')).toMatchObject({ expectedTotal: 5, exact: true })

    const scan = await scans.wait((await scans.start({ revision: revision.ref, scanConfig })).id)
    const resolved = scan.scheduling.resolved.schedule
    expect(resolved).toMatchObject({
      template: 'list',
      expectedTotal: 3,
      provenance: { inlineItems: 2, upload: { id: upload.id, sha256: upload.sha256, bytes: upload.bytes, lines: 4 } },
    })
    expect(scan.stats.expectedTotal).toBe(3)
    const analyses = await allAnalyses(api, scan.id, ['config', 'result'])
    expect(analyses.map((a) => a.config)).toEqual([
      { item: 'two', index: 1 },
      { item: 'alpha', index: 2 },
      { item: 'beta', index: 3 },
    ])
    expect(analyses.map((a) => a.result)).toEqual(analyses.map((a) => ({ config: a.config })))
  })

  test('an upload line longer than 4096 bytes fails scheduling', { tag: ['@TPL-002'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.generated('tpl-list')
    const upload = await createListUpload(api, `short\n${'x'.repeat(5000)}\nlast\n`)
    const scan = await scans.wait((await scans.start({ revision: revision.ref, scanConfig: { upload: upload.id } })).id, { state: 'failed' })
    expect(scan.scheduling.state).toBe('failed')
    expect(scan.scheduling.error).toMatchObject({ type: 'validation', retryable: false, phase: 'schedule' })
    expect(scan.scheduling.error?.message).toContain('line 2 of upload exceeds 4096 bytes')
  })
})

test.describe('template range', () => {
  test('follows Python range semantics and rejects step 0', { tag: ['@TPL-003'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.generated('tpl-range')
    // Defaults start 0, end 10, step 1; end is exclusive; the count is max(0, ceil((end − start) / step)).
    expect(ok(await estimateTemplate(api, 'range', {}), 'estimateTemplate')).toMatchObject({ expectedTotal: 10, exact: true })
    expect(ok(await estimateTemplate(api, 'range', { start: 0, end: 5, step: -1 }), 'estimateTemplate')).toMatchObject({ expectedTotal: 0, exact: true })
    expect(ok(await estimateTemplate(api, 'range', { start: 5, end: -3, step: -3 }), 'estimateTemplate')).toMatchObject({ expectedTotal: 3, exact: true })

    const rejected = await api.startScan({ revision: revision.ref, scanConfig: { step: 0 }, settings: TWO_RUNNERS })
    expect(configIssues(rejected)).toContainEqual({ path: '/scanConfig/step', message: expect.stringContaining('must not be 0') })

    const scan = await scans.wait((await scans.start({ revision: revision.ref, scanConfig: { start: 5, end: -3, step: -3 } })).id)
    expect(scan.scheduling.resolved.schedule).toMatchObject({
      template: 'range',
      scanConfig: { start: 5, end: -3, step: -3 },
      provenance: {},
      expectedTotal: 3,
    })
    const analyses = await allAnalyses(api, scan.id, ['config'])
    expect(analyses.map((a) => a.config)).toEqual([{ value: 5 }, { value: 2 }, { value: -1 }])
  })
})

test.describe('template repeat', () => {
  test('yields iterations 0 … times − 1 with an exact estimate', { tag: ['@TPL-004'] }, async ({ api, shared, scans }) => {
    // The probe passes the template repeat unwrapped (helpers/e2e-runtime-tasks.ts).
    const { revision } = await shared.generated('probe')
    expect(revision.description?.schedule).toEqual({ kind: 'template', template: 'repeat' })
    expect(ok(await estimateTemplate(api, 'repeat', {}), 'estimateTemplate')).toMatchObject({ expectedTotal: 1, exact: true })
    expect(ok(await estimateTemplate(api, 'repeat', { times: 4 }), 'estimateTemplate')).toMatchObject({ expectedTotal: 4, exact: true })
    const rejected = await api.startScan({ revision: revision.ref, scanConfig: { times: 0 }, settings: TWO_RUNNERS })
    expect(configIssues(rejected).map((issue) => issue.path)).toContain('/scanConfig/times')

    const scan = await scans.wait((await scans.start({ revision: revision.ref, scanConfig: { times: 4 } })).id)
    expect(scan.scheduling.resolved.schedule).toMatchObject({ template: 'repeat', scanConfig: { times: 4 }, expectedTotal: 4 })
    const analyses = await allAnalyses(api, scan.id, ['config', 'result'])
    expect(analyses.map((a) => a.config)).toEqual([0, 1, 2, 3].map((iteration) => ({ iteration })))
    expect(analyses.map((a) => (a.result as { iteration: number }).iteration)).toEqual([0, 1, 2, 3])
  })
})

test.describe('template tranco', () => {
  test('resolves latest to a list id and yields the window in rank order', { tag: ['@TPL-005', '@TPL-008', '@TPL-010'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.generated('tpl-tranco')
    const latest = await trancoMetadata('/api/lists/date/latest?subdomains=false')
    expect(ok(await estimateTemplate(api, 'tranco', { offset: 2, limit: 3 }), 'estimateTemplate')).toMatchObject({ expectedTotal: 3, exact: true })

    const started = await scans.start({ revision: revision.ref, scanConfig: { offset: 2, limit: 3 } })
    const scan = await scans.wait(started.id)
    const resolved = scan.scheduling.resolved.schedule!
    expect(resolved).toMatchObject({
      template: 'tranco',
      scanConfig: { list: latest.list_id, subdomains: false, offset: 2, limit: 3 },
      provenance: {
        listId: latest.list_id,
        date: latest.configuration.endDate,
        // the data source of the stack (SCANTOR_TRANCO_URL): the download of ranks 1 … offset + limit
        sourceUrl: `${stackEnv().SCANTOR_TRANCO_URL}/download/${latest.list_id}/5`,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        fetchedAt: expect.any(String),
      },
      expectedTotal: 3,
      at: expect.any(String),
    })
    // The resolution is recorded before the first item is published.
    const analyses = await allAnalyses(api, scan.id, ['config', 'result', 'timings'])
    expect(Date.parse(resolved.at)).toBeLessThanOrEqual(Date.parse(analyses[0]!.timings!.scheduledAt!) + 1000)
    expect(scan.stats.expectedTotal).toBe(3)
    expect(analyses.map((a) => a.config)).toEqual([
      { domain: 'site3.example', rank: 3 },
      { domain: 'site4.example', rank: 4 },
      { domain: 'site5.example', rank: 5 },
    ])
  })

  test('resolves a date and a list id', { tag: ['@TPL-005'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.generated('tpl-tranco')
    const withSubdomains = await trancoMetadata('/api/lists/date/latest?subdomains=true')
    const plain = await trancoMetadata('/api/lists/date/latest?subdomains=false')

    const [byDate, byId] = await Promise.all([
      scans.start({ revision: revision.ref, scanConfig: { list: withSubdomains.configuration.endDate, subdomains: true, limit: 2 } }),
      scans.start({ revision: revision.ref, scanConfig: { list: plain.list_id, offset: 998, limit: 2 } }),
    ])
    const [dateScan, idScan] = await Promise.all([scans.wait(byDate.id), scans.wait(byId.id)])
    expect(dateScan.scheduling.resolved.schedule).toMatchObject({
      scanConfig: { list: withSubdomains.list_id, subdomains: true },
      provenance: { listId: withSubdomains.list_id, date: withSubdomains.configuration.endDate },
    })
    expect((await allAnalyses(api, dateScan.id, ['config'])).map((a) => a.config)).toEqual([
      { domain: 'www.site1.example', rank: 1 },
      { domain: 'www.site2.example', rank: 2 },
    ])
    expect(idScan.scheduling.resolved.schedule).toMatchObject({
      scanConfig: { list: plain.list_id, offset: 998, limit: 2 },
      provenance: { listId: plain.list_id, date: plain.configuration.endDate, sourceUrl: expect.stringMatching(/\/download\/[0-9A-Z]+\/1000$/) },
      expectedTotal: 2,
    })
    expect((await allAnalyses(api, idScan.id, ['config'])).map((a) => a.config)).toEqual([
      { domain: 'site999.example', rank: 999 },
      { domain: 'site1000.example', rank: 1000 },
    ])
  })

  test('rejects unknown lists, dates without a list and windows beyond rank 1 000 000', { tag: ['@TPL-005'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.generated('tpl-tranco')
    const tooLarge = await api.startScan({ revision: revision.ref, scanConfig: { offset: 999_999, limit: 2 }, settings: TWO_RUNNERS })
    expect(configIssues(tooLarge).map((issue) => issue.path)).toContain('/scanConfig/limit')

    const [unknownId, noList] = await Promise.all([
      scans.start({ revision: revision.ref, scanConfig: { list: 'ZZZZZ' } }),
      scans.start({ revision: revision.ref, scanConfig: { list: '2020-01-01' } }),
    ])
    for (const [scanId, message] of [
      [unknownId.id, 'unknown Tranco list id ZZZZZ'],
      [noList.id, 'no Tranco list for 2020-01-01'],
    ] as const) {
      const scan = await scans.wait(scanId, { state: 'failed' })
      expect(scan.scheduling.error).toMatchObject({ type: 'validation', retryable: false, phase: 'schedule' })
      expect(scan.scheduling.error?.message).toContain(message)
      expect(scan.scheduling.restarts).toBe(0)
      expect(await scans.counts(scanId)).toEqual({})
    }
  })
})

test.describe('template crux', () => {
  test(
    'latest resolves to the newest month; the stream stops at the first rank above the bucket',
    { tag: ['@TPL-006', '@TPL-008', '@TPL-010'] },
    async ({ api, shared, scans }) => {
      const { revision } = await shared.generated('tpl-crux')
      const month = await latestCruxMonth('data/country/de')
      expect(ok(await estimateTemplate(api, 'crux', { country: 'de', bucket: 5000 }), 'estimateTemplate')).toMatchObject({ expectedTotal: 5000, exact: false })

      // bucket 5000: the estimate is the upper bound, the resolution counts the 1400 rows up to that bucket exactly.
      // The estimate (5000) is above SCANTOR_SCAN_CONFIRM_THRESHOLD, so the start needs confirm.
      const wide = await scans.start({ revision: revision.ref, scanConfig: { country: 'de', bucket: 5000 }, confirm: true })
      const wideResolved = await pollScan(api, wide.id, (s) => s.scheduling.resolved.schedule !== undefined, { timeoutMs: 120_000, what: 'resolution' })
      expect(wideResolved.scheduling.resolved.schedule).toMatchObject({ scanConfig: { country: 'de', month, bucket: 5000 }, expectedTotal: 1400 })
      await expect.poll(async () => (await getScan(api, wide.id)).stats.expectedTotal, { timeout: 30_000 }).toBe(1400)
      ok(await api.cancelScan(wide.id), 'cancelScan')

      // bucket 1000: exactly the 1000 origins of that bucket, in file order.
      const scan = await scans.wait((await scans.start({ revision: revision.ref, scanConfig: { country: 'de', bucket: 1000 }, settings: TWO_RUNNERS })).id, {
        timeoutMs: 120_000,
      })
      expect(scan.scheduling.resolved.schedule).toMatchObject({
        template: 'crux',
        scanConfig: { country: 'de', month, bucket: 1000 },
        provenance: {
          country: 'de',
          month,
          sourceUrl: `${stackEnv().SCANTOR_CRUX_URL}/data/country/de/${month}.csv.gz`,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          fetchedAt: expect.any(String),
        },
        expectedTotal: 1000,
      })
      const analyses = await allAnalyses(api, scan.id, ['config', 'status'])
      expect(analyses).toHaveLength(1000)
      expect(analyses.every((a) => a.status === 'succeeded')).toBe(true)
      expect(analyses.map((a) => a.config)).toEqual(Array.from({ length: 1000 }, (_, i) => ({ origin: cruxOrigin(i + 1, 'de.example'), rank: 1000 })))
    },
  )

  test('a missing list fails scheduling', { tag: ['@TPL-006'] }, async ({ shared, scans }) => {
    const { revision } = await shared.generated('tpl-crux')
    const [noCountry, noMonth] = await Promise.all([
      scans.start({ revision: revision.ref, scanConfig: { country: 'fr' } }),
      scans.start({ revision: revision.ref, scanConfig: { month: '202001' } }),
    ])
    for (const [scanId, message] of [
      [noCountry.id, 'no CrUX list for fr in the last 4 months'],
      [noMonth.id, 'CrUX list global 202001 not found'],
    ] as const) {
      const scan = await scans.wait(scanId, { state: 'failed' })
      expect(scan.scheduling.error).toMatchObject({ type: 'validation', retryable: false, phase: 'schedule' })
      expect(scan.scheduling.error?.message).toContain(message)
    }
  })
})

test.describe('template cidr', () => {
  test('merges ranges and yields addresses and subnets, IPv4 first, minus exclusions', { tag: ['@TPL-007'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.generated('tpl-cidr')
    // Host bits cleared (10.0.0.5/30 = 10.0.0.4/30), overlapping (10.0.0.6/31) and adjacent (10.0.0.8/30) ranges merged
    // to 10.0.0.4–10.0.0.11, minus 10.0.0.9; IPv6 after IPv4 although it is listed first.
    const perAddress = { cidrs: ['2001:db8::1/127', '10.0.0.8/30', '10.0.0.5/30', '10.0.0.6/31'], exclude: ['10.0.0.9'] }
    const subnets = { cidrs: ['10.0.1.0/29'], exclude: ['10.0.1.2'], prefix: 31 }
    expect(ok(await estimateTemplate(api, 'cidr', perAddress), 'estimateTemplate')).toMatchObject({ expectedTotal: 9, exact: true })
    expect(ok(await estimateTemplate(api, 'cidr', subnets), 'estimateTemplate')).toMatchObject({ expectedTotal: 3, exact: true })

    const [first, second] = await Promise.all([
      scans.start({ revision: revision.ref, scanConfig: perAddress }),
      scans.start({ revision: revision.ref, scanConfig: subnets }),
    ])
    const v4 = (ip: string, prefix = 32) => ({ ip, prefix, version: 4 })
    expect((await allAnalyses(api, (await scans.wait(first.id)).id, ['config'])).map((a) => a.config)).toEqual([
      v4('10.0.0.4'),
      v4('10.0.0.5'),
      v4('10.0.0.6'),
      v4('10.0.0.7'),
      v4('10.0.0.8'),
      v4('10.0.0.10'),
      v4('10.0.0.11'),
      { ip: '2001:db8::', prefix: 128, version: 6 },
      { ip: '2001:db8::1', prefix: 128, version: 6 },
    ])
    // Subnet mode: every aligned /31 that does not intersect an exclusion.
    expect((await allAnalyses(api, (await scans.wait(second.id)).id, ['config'])).map((a) => a.config)).toEqual([
      v4('10.0.1.0', 31),
      v4('10.0.1.4', 31),
      v4('10.0.1.6', 31),
    ])
  })

  test('rejects invalid entries, prefix conflicts and expansions above maxAnalyses at scan start', { tag: ['@TPL-007'] }, async ({ api, shared }) => {
    const { revision } = await shared.generated('tpl-cidr')
    const cases: [Record<string, unknown>, string, string?][] = [
      [{ cidrs: ['not-an-ip'] }, '/scanConfig/cidrs/0'],
      [{ cidrs: ['10.0.0.0/30'], exclude: ['10.0.0.0/30', 'bogus'] }, '/scanConfig/exclude/1'],
      [{ cidrs: ['fe80::1%eth0'] }, '/scanConfig/cidrs/0'],
      [{ cidrs: ['::ffff:10.0.0.1'] }, '/scanConfig/cidrs/0'],
      [{ cidrs: ['10.0.0.0/30'], prefix: 24 }, '/scanConfig/prefix'],
      [{ cidrs: ['2001:db8::/48', '10.0.0.0/8'], prefix: 64 }, '/scanConfig/prefix'],
      [{ cidrs: ['10.0.0.0/24'], maxAnalyses: 10 }, '/scanConfig/maxAnalyses', 'cidrs expand to 256 analyses, above maxAnalyses 10'],
    ]
    for (const [scanConfig, path, message] of cases) {
      const response = await api.startScan({ revision: revision.ref, scanConfig, settings: TWO_RUNNERS })
      const issues = configIssues(response)
      expect(
        issues.map((issue) => issue.path),
        JSON.stringify(scanConfig),
      ).toContain(path)
      if (message) expect(issues.find((issue) => issue.path === path)?.message).toContain(message)
    }
  })
})

test.describe('wrapped templates', () => {
  test(
    'a custom schedule receives the proxy items in order; the resolution does not set expectedTotal',
    { tag: ['@TPL-009', '@TPL-010'] },
    async ({ api, shared, scans }) => {
      // wrap: a custom schedule that wraps the range template, as the power example does.
      const { revision } = await shared.generated('wrap')
      expect(revision.description?.schedule).toEqual({ kind: 'custom' })
      const scan = await scans.wait((await scans.start({ revision: revision.ref, scanConfig: { start: 1, end: 8, step: 2 } })).id)
      // The wrapped call is recorded under call:0 with its own count; stats.expectedTotal stays unknown.
      expect(scan.scheduling.resolved['call:0']).toMatchObject({
        template: 'range',
        scanConfig: { start: 1, end: 8, step: 2 },
        provenance: {},
        expectedTotal: 4,
      })
      expect(scan.scheduling.resolved.schedule).toBeUndefined()
      expect(scan.stats.expectedTotal).toBeNull()
      const analyses = await allAnalyses(api, scan.id, ['config', 'result'])
      expect(analyses.map((a) => (a.config as { value: number }).value)).toEqual([1, 3, 5, 7])
      expect(analyses.map((a) => (a.result as { value: number }).value)).toEqual([1, 3, 5, 7])
    },
  )

  test('an invalid scan config for the proxy raises a validation error in user code', { tag: ['@TPL-009'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.generated('wrap')
    // The task catches the template's error and yields one item that describes it.
    const scan = await scans.wait((await scans.start({ revision: revision.ref, scanConfig: { step: 0, catch: true } })).id)
    const analyses = await allAnalyses(api, scan.id, ['config'])
    expect(analyses).toHaveLength(1)
    const [type, retryable, message] = String((analyses[0]!.config as { note: string }).note).split('|')
    expect({ type, retryable }).toEqual({ type: 'validation', retryable: 'False' })
    expect(message).toContain('must not be 0')
  })
})

test.describe('resolution on resume', () => {
  test(
    'a resumed scheduler reuses the stored resolution and the scan completes exactly',
    { tag: ['@TPL-011', '@SCHED-003'] },
    async ({ api, shared, scans }) => {
      const { revision } = await shared.generated('wrap')
      // A slow schedule (60 Tranco ranks, 0.25 s apart) that is paused while it streams.
      const started = await scans.start({ revision: revision.ref, scanConfig: { source: 'tranco', limit: 60, item_delay: 0.25 }, settings: TWO_RUNNERS })
      const streaming = await pollScan(api, started.id, (s) => s.scheduling.resolved['call:0'] !== undefined && s.scheduling.confirmed >= 5, {
        timeoutMs: 120_000,
        what: 'a resolved, streaming schedule',
        intervalMs: 500,
      })
      expect(streaming.scheduling.state).toBe('running')
      ok(await api.call('pauseScan', { path: { scanId: started.id } }), 'pauseScan')
      // The scheduler drains (final checkpoint) and stops.
      await expect
        .poll(async () => (await scanWorkers(api, started.id)).filter((w) => w.role === 'scheduler' && w.state !== 'stopped').length, { timeout: 90_000 })
        .toBe(0)
      const paused = await getScan(api, started.id)
      expect(paused.state).toBe('paused')
      expect(paused.scheduling.confirmed).toBeLessThan(60)
      const stored = paused.scheduling.resolved

      ok(await api.call('resumeScan', { path: { scanId: started.id } }), 'resumeScan')
      const scan = await scans.wait(started.id, { timeoutMs: 120_000 })
      expect(scan.scheduling.resolved).toEqual(stored)
      expect(scan.scheduling.epoch).toBe(paused.scheduling.epoch + 1)
      expect(scan.scheduling.confirmed).toBe(60)
      expect(await scans.counts(scan.id)).toEqual({ succeeded: 60 })
      const analyses = await allAnalyses(api, scan.id, ['config'])
      expect(analyses.map((a) => a.seq)).toEqual(Array.from({ length: 60 }, (_, i) => i))
      expect(analyses.map((a) => (a.config as { value: number }).value)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1))
    },
  )
})

test.describe('test runs and template data', () => {
  test('a test run reads a list upload and fetches Tranco and CrUX data itself', { tag: ['@TRUN-012', '@TPL-008'] }, async ({ api, shared }) => {
    const [list, tranco, crux] = await Promise.all([shared.generated('tpl-list'), shared.generated('tpl-tranco'), shared.generated('tpl-crux')])
    const upload = await createListUpload(api, 'first\nsecond\nthird\n')
    const [listRun, trancoRun, cruxRun] = await Promise.all([
      testRun(api, list.task.name, { scanConfig: { upload: upload.id }, limit: 5 }),
      testRun(api, tranco.task.name, { scanConfig: { limit: 3 }, limit: 5 }),
      testRun(api, crux.task.name, { scanConfig: { country: 'us' }, limit: 3 }),
    ])
    for (const run of [listRun, trancoRun, cruxRun]) expect(run.state, JSON.stringify(run.errors)).toBe('completed')
    const configs = (run: TestRun) => run.analyses!.map((a) => a.config)
    expect(configs(listRun)).toEqual([
      { item: 'first', index: 0 },
      { item: 'second', index: 1 },
      { item: 'third', index: 2 },
    ])
    expect(configs(trancoRun)).toEqual([1, 2, 3].map((rank) => ({ domain: `site${rank}.example`, rank })))
    expect(configs(cruxRun)).toEqual([1, 2, 3].map((n) => ({ origin: cruxOrigin(n, 'us.example'), rank: 1000 })))
    for (const run of [listRun, trancoRun, cruxRun]) expect(run.analyses!.every((a) => a.status === 'succeeded')).toBe(true)
  })
})

test.describe('data sources', () => {
  test(
    'template data is fetched with the scantor User-Agent; 5xx and 429 are retried, then fail as a retryable platform error',
    { tag: ['@TPL-008'] },
    async () => {
      // Local runs (scantor dev run) read SCANTOR_TRANCO_URL like the orchestrator does for schedulers and test runs, so
      // they can point at a data source this test controls: one that recovers on the third try of every request, and
      // one that is down.
      const [recovering, down] = await Promise.all([
        FlakyDataSource.start({ failures: [{ status: 503 }, { status: 429, retryAfterSeconds: 1 }] }),
        FlakyDataSource.start({ always: { status: 503 } }),
      ])
      const dirs = await Promise.all([writeGeneratedTask('tpl-tranco'), writeGeneratedTask('tpl-tranco')])
      try {
        const run = (dir: string, source: FlakyDataSource) =>
          scantor(['dev', 'run', dir, '--scan-config', '{"limit": 2}', '--limit', '2', '-o', 'json'], {
            cwd: dir,
            env: { SCANTOR_TRANCO_URL: source.url('tranco') },
            timeoutMs: 150_000,
          })
        const [succeeded, failed] = await Promise.all([run(dirs[0]!, recovering), run(dirs[1]!, down)])
        type LocalEvent = { type: string; [key: string]: unknown }
        const events = (result: { json: unknown }) => (Array.isArray(result.json) ? (result.json as LocalEvent[]) : [])

        // Every request carries the platform's User-Agent.
        const userAgents = new Set([...recovering.requests, ...down.requests].map((r) => r.userAgent))
        expect([...userAgents]).toEqual([expect.stringMatching(/^scantor\/\S+ \(\+https:\/\/github\.com\/lonetis\/scantor\)$/)])

        // Recovering source: each request failed twice (503, then 429 with Retry-After: 1) and succeeded on the third try.
        expect(succeeded.exitCode, succeeded.stdout + succeeded.stderr).toBe(0)
        const resolved = events(succeeded).find((e) => e.type === 'resolved') as { provenance: { sourceUrl: string } } | undefined
        expect(resolved?.provenance.sourceUrl.startsWith(recovering.url('tranco'))).toBe(true)
        const results = events(succeeded).filter((e) => e.type === 'result') as unknown as { status: string; config: unknown }[]
        expect(results.map((r) => [r.status, r.config])).toEqual([
          ['succeeded', { domain: 'site1.example', rank: 1 }],
          ['succeeded', { domain: 'site2.example', rank: 2 }],
        ])
        const paths = [...new Set(recovering.requests.map((r) => r.path))]
        expect(paths).toEqual(expect.arrayContaining(['/tranco/api/lists/date/latest', expect.stringMatching(/^\/tranco\/download\/[0-9A-Z]+\/2$/)]))
        for (const path of paths) {
          const tries = recovering.requests.filter((r) => r.path === path)
          expect(
            tries.map((r) => r.status),
            path,
          ).toEqual([503, 429, 200])
          // 2 s after a 5xx; the Retry-After of the 429 (1 s) instead of the policy's 4 s.
          expect(tries[1]!.at - tries[0]!.at, path).toBeGreaterThanOrEqual(1800)
          expect(tries[1]!.at - tries[0]!.at, path).toBeLessThan(3500)
          expect(tries[2]!.at - tries[1]!.at, path).toBeGreaterThanOrEqual(900)
          expect(tries[2]!.at - tries[1]!.at, path).toBeLessThan(2500)
        }

        // Unavailable source: three tries, then a retryable platform error in phase schedule.
        expect(down.requests.map((r) => [r.path, r.status])).toEqual([
          ['/tranco/api/lists/date/latest', 503],
          ['/tranco/api/lists/date/latest', 503],
          ['/tranco/api/lists/date/latest', 503],
        ])
        const error = events(failed).find((e) => e.type === 'error') as { error: Record<string, unknown> } | undefined
        expect(error?.error).toMatchObject({ type: 'platform', retryable: true, phase: 'schedule' })
        const end = events(failed).find((e) => e.type === 'end') as { reason: string; exitCode: number } | undefined
        expect(end).toMatchObject({ reason: 'scheduleFailed', exitCode: 1 })
        expect(failed.exitCode).toBe(1)
      } finally {
        await Promise.all([recovering.stop(), down.stop(), ...dirs.map((dir) => removeGeneratedTask(dir))])
      }
    },
  )
})
