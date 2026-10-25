import { createHash, randomBytes } from 'node:crypto'
import { request as playwrightRequest } from '@playwright/test'
import type { Analysis } from '#shared/types/analyses'
import type { Export } from '#shared/types/exports'
import type { Scan } from '#shared/types/scans'
import type { TestRun } from '#shared/types/test-runs'
import { ok, type ApiClient } from '../helpers/api-client'
import { callJson } from '../helpers/mcp'
import { errorCode } from '../helpers/security'
import { SECRET_PATHS_FALLBACK, SECRET_PATHS_TASK } from '../helpers/security-tasks'
import { stackEnv } from '../helpers/docker'
import { withSecurityTenants } from '../helpers/security-tenants'
import { expect, test as base } from '../fixtures'

// The tenant fixtures of the security specs (helpers/security-tenants.ts).
const test = withSecurityTenants(base)

// writeOnly secrets in configs and results (docs/security.md §6.16 SEC-1…SEC-3, SEC-7, §6.5 Q-6; docs/tasks.md §6.5):
// encrypted at rest, "***" in every response, export and MCP result, the plaintext only for the task itself (asserted
// through hashes the task reports), and queries that would turn a secret into an oracle are refused.

const MASK = '***'
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const secretValue = (label: string) => `${label}-${randomBytes(12).toString('hex')}`

/** Downloads a finished export through its presigned URL. */
async function downloadExport(api: ApiClient, scanId: string, format: 'jsonl' | 'csv', filter: Record<string, unknown> = {}): Promise<string> {
  const created = await api.call<Export>('exportScan', { path: { scanId }, body: { format, filter }, query: { wait: 60 } })
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  expect(created.body.state).toBe('ready')
  const context = await playwrightRequest.newContext({ extraHTTPHeaders: {} })
  try {
    const response = await context.get(created.body.download!.url)
    expect(response.status()).toBe(200)
    return await response.text()
  } finally {
    await context.dispose()
  }
}

/** Every rendering of the scan a user can obtain over the REST API, as one string. */
async function restViews(api: ApiClient, scanId: string): Promise<string> {
  const views: unknown[] = [
    ok(await api.getScan(scanId), 'getScan'),
    ok(await api.listScans({ limit: 200 }), 'listScans'),
    ok(await api.call('listAnalyses', { path: { scanId }, query: { limit: 1000 } }), 'listAnalyses'),
    ok(await api.call('queryAnalyses', { path: { scanId }, body: { filter: {}, limit: 1000 } }), 'queryAnalyses'),
  ]
  // NDJSON: read raw (the ApiClient parses every *json* body as one JSON document).
  const inline = await api.request.get(`/api/scans/${scanId}/export`, { params: { format: 'jsonl' } })
  expect(inline.status()).toBe(200)
  views.push(await inline.text())
  views.push(await downloadExport(api, scanId, 'jsonl'), await downloadExport(api, scanId, 'csv'))
  for (const item of ok(await api.call<{ items: Analysis[] }>('listAnalyses', { path: { scanId } }), 'listAnalyses').items) {
    views.push(ok(await api.call('getAnalysis', { path: { analysisId: item.id } }), 'getAnalysis'))
  }
  return views.map((view) => (typeof view === 'string' ? view : JSON.stringify(view))).join('\n')
}

function expectAbsent(text: string, secrets: string[], where: string): void {
  for (const secret of secrets) expect(text.includes(secret), `${where} contains a secret value`).toBe(false)
}

test.describe('secret masking', () => {
  test(
    'schema-zoo: the task secret is *** in scans, analyses, exports, test runs and MCP, reaches the task, and survives a restart',
    { tag: ['@SEC-014'] },
    async ({ api, mcpKey, shared, scans }) => {
      test.setTimeout(180_000)
      const { task, revision } = await shared.fixture('schema-zoo')
      // describe records the secret path (its default: the test below).
      expect(revision.description?.secretPaths.taskConfig).toEqual(['/api_token'])

      const secret = secretValue('zoo')
      const started = await scans.start({ revision: revision.ref, taskConfig: { api_token: secret, text: 'masked' } })
      expect(started.taskConfig).toMatchObject({ api_token: MASK, text: 'masked' })
      expectAbsent(JSON.stringify(started), [secret], 'startScan')
      await scans.wait(started.id)

      // The task received the plaintext: it reports its hash.
      const analyses = ok(await api.call<{ items: Analysis[] }>('listAnalyses', { path: { scanId: started.id } }), 'listAnalyses').items
      expect(analyses).toHaveLength(1)
      expect((analyses[0]!.result as { api_token_sha256: string }).api_token_sha256).toBe(sha256(secret))
      expect(ok(await api.getScan(started.id), 'getScan').taskConfig).toMatchObject({ api_token: MASK })
      expectAbsent(await restViews(api, started.id), [secret], 'a REST view of the scan')

      // MCP returns the same masked representations.
      const viaMcp = JSON.stringify([
        await callJson(mcpKey, 'get_scan', { scanId: started.id }),
        await callJson(mcpKey, 'query_analyses', { scanId: started.id, filter: {} }),
        await callJson(mcpKey, 'get_analysis', { analysisId: analyses[0]!.id }),
      ])
      expect(viaMcp).toContain(MASK)
      expectAbsent(viaMcp, [secret], 'an MCP result')

      // A restarted clone runs with the original secret, copied server-side.
      const restarted = await api.call<Scan>('restartScan', { path: { scanId: started.id }, body: {} })
      expect(restarted.status, JSON.stringify(restarted.body)).toBe(201)
      scans.track(restarted.body.id)
      expect(restarted.body.taskConfig).toMatchObject({ api_token: MASK })
      await scans.wait(restarted.body.id)
      const cloned = ok(await api.call<{ items: Analysis[] }>('listAnalyses', { path: { scanId: restarted.body.id } }), 'listAnalyses').items
      expect((cloned[0]!.result as { api_token_sha256: string }).api_token_sha256).toBe(sha256(secret))
      expectAbsent(await restViews(api, restarted.body.id), [secret], 'a REST view of the clone')

      // Test runs mask the same way, in REST and MCP.
      const testSecret = secretValue('test-run')
      const run = await api.call<TestRun>('testTask', { path: { task: task.name }, body: { taskConfig: { api_token: testSecret } }, query: { wait: 120 } })
      expect(run.status, JSON.stringify(run.body)).toBe(201)
      const finished = ok(await api.call<TestRun>('getTestRun', { path: { testRunId: run.body.id }, query: { wait: 120 } }), 'getTestRun')
      expect(finished.state, JSON.stringify(finished.errors)).toBe('completed')
      expect(finished.input.taskConfig).toMatchObject({ api_token: MASK })
      expect((finished.analyses![0]!.result as { api_token_sha256: string }).api_token_sha256).toBe(sha256(testSecret))
      const testRunViews = JSON.stringify([run.body, finished, await callJson(mcpKey, 'get_test_run', { testRunId: run.body.id })])
      expectAbsent(testRunViews, [testSecret], 'a test run view')
    },
  )

  test(
    'secrets in the scan config, the analysis config and the result are *** everywhere while the task sees them',
    { tag: ['@SEC-014'] },
    async ({ api, mcpKey, shared, scans }) => {
      test.setTimeout(180_000)
      const { revision } = await shared.generated('secret-paths', SECRET_PATHS_TASK)
      expect(revision.description?.secretPaths).toMatchObject({ scanConfig: ['/seed'], analysisConfig: ['/key'], result: ['/echo'] })
      expect([...revision.description!.secretPaths.taskConfig].sort()).toEqual(['/fallback', '/token'])
      const token = secretValue('token')
      const fallback = secretValue('fallback')
      const seed = secretValue('seed')
      const scan = await scans.start({ revision: revision.ref, taskConfig: { token, fallback }, scanConfig: { count: 2, seed } })
      expect(scan.taskConfig).toMatchObject({ token: MASK, fallback: MASK })
      expect(scan.scanConfig).toMatchObject({ seed: MASK, count: 2 })
      await scans.wait(scan.id)
      expect(await scans.counts(scan.id)).toEqual({ succeeded: 2 })

      const keys = [0, 1].map((n) => `key-${seed}-${n}`)
      const analyses = ok(await api.call<{ items: Analysis[] }>('listAnalyses', { path: { scanId: scan.id } }), 'listAnalyses').items
      for (const analysis of analyses) {
        const n = (analysis.config as { n: number }).n
        expect(analysis.config).toEqual({ n, key: MASK })
        expect(analysis.result).toEqual({ n, echo: MASK, token_sha256: sha256(token), key_sha256: sha256(keys[n]!), fallback_sha256: sha256(fallback) })
      }
      const secrets = [token, fallback, seed, ...keys]
      expectAbsent(await restViews(api, scan.id), secrets, 'a REST view')
      expectAbsent(JSON.stringify(await callJson(mcpKey, 'query_analyses', { scanId: scan.id, filter: {} })), secrets, 'query_analyses over MCP')
    },
  )

  test(
    'describe drops the default of a nullable writeOnly field, so an omitted secret gets the task’s own default',
    { tag: ['@SEC-014'] },
    async ({ api, shared, scans }) => {
      for (const [fixture, property] of [
        ['schema-zoo', 'api_token'],
        ['secret-paths', 'fallback'],
      ] as const) {
        const { revision } = fixture === 'schema-zoo' ? await shared.fixture(fixture) : await shared.generated(fixture, SECRET_PATHS_TASK)
        const schema = (revision.description?.schemas.taskConfig as { properties: Record<string, Record<string, unknown>> }).properties[property]!
        expect.soft(schema, `${fixture}.${property}`).not.toHaveProperty('default')
      }
      // The harm: without the field, the task must see its native default, not the masked string describe exported.
      const { revision } = await shared.generated('secret-paths', SECRET_PATHS_TASK)
      const scan = await scans.start({ revision: revision.ref, scanConfig: { count: 1, seed: secretValue('seed') } })
      await scans.wait(scan.id)
      const [analysis] = ok(await api.call<{ items: Analysis[] }>('listAnalyses', { path: { scanId: scan.id } }), 'listAnalyses').items
      expect((analysis!.result as { fallback_sha256: string }).fallback_sha256).toBe(sha256(SECRET_PATHS_FALLBACK))
    },
  )

  test('queries that reference a secret path are refused; plain projections are masked', { tag: ['@SEC-015'] }, async ({ api, shared, scans }) => {
    test.setTimeout(180_000)
    const { revision } = await shared.generated('secret-paths', SECRET_PATHS_TASK)
    const seed = secretValue('seed')
    const scan = await scans.start({ revision: revision.ref, scanConfig: { count: 2, seed } })
    await scans.wait(scan.id)

    const refused: { operation: string; body: Record<string, unknown> }[] = [
      { operation: 'queryAnalyses', body: { filter: { 'config.key': `key-${seed}-0` } } },
      { operation: 'queryAnalyses', body: { filter: { 'result.echo': { $regex: '^key-' } } } },
      { operation: 'queryAnalyses', body: { filter: { $expr: { $eq: [{ $substrCP: ['$config.key', 0, 1] }, 'k'] } } } },
      { operation: 'queryAnalyses', body: { filter: {}, sort: { 'result.echo': 1 } } },
      { operation: 'queryAnalyses', body: { filter: {}, projection: { leak: { $concat: ['$config.key', ''] } } } },
      { operation: 'queryAnalyses', body: { filter: {}, projection: { leak: '$result' } } },
      // $jsonSchema tests values without a `$path`, and patternProperties without naming the field.
      { operation: 'queryAnalyses', body: { filter: { $jsonSchema: { properties: { config: { properties: { key: { pattern: '^key-' } } } } } } } },
      { operation: 'queryAnalyses', body: { filter: { $jsonSchema: { properties: { result: { patternProperties: { '^e': { pattern: '^key-' } } } } } } } },
      { operation: 'aggregateAnalyses', body: { pipeline: [{ $group: { _id: '$result.echo', n: { $sum: 1 } } }] } },
      { operation: 'aggregateAnalyses', body: { pipeline: [{ $match: { 'config.key': { $gt: '' } } }] } },
      { operation: 'aggregateAnalyses', body: { pipeline: [{ $replaceRoot: { newRoot: '$config' } }] } },
      { operation: 'aggregateAnalyses', body: { pipeline: [{ $project: { all: '$$ROOT' } }] } },
      { operation: 'exportScan', body: { format: 'jsonl', filter: { 'config.key': { $exists: true } } } },
      { operation: 'exportScan', body: { format: 'jsonl', filter: { $jsonSchema: { properties: { config: { properties: { key: { pattern: '^k' } } } } } } } },
    ]
    for (const { operation, body } of refused) {
      const response = await api.call(operation, { path: { scanId: scan.id }, body })
      expect.soft(response.status, `${operation} ${JSON.stringify(body)}: ${JSON.stringify(response.body)}`).toBe(400)
      expect.soft(errorCode(response), JSON.stringify(body)).toBe('queryRejected')
    }

    // Plain projections of secret paths (and of their parents) are allowed and masked.
    const projected = ok(
      await api.call<{ items: Record<string, unknown>[] }>('queryAnalyses', {
        path: { scanId: scan.id },
        body: { filter: {}, projection: { seq: 1, 'config.key': 1, result: 1 }, sort: { seq: 1 } },
      }),
      'queryAnalyses',
    ).items
    expect(projected).toHaveLength(2)
    for (const item of projected) expect(item).toMatchObject({ config: { key: MASK }, result: { echo: MASK } })
    // Stages that pass documents through unchanged never carry a secret either.
    const passed = ok(
      await api.call<{ items: unknown[] }>('aggregateAnalyses', { path: { scanId: scan.id }, body: { pipeline: [{ $facet: { all: [{ $match: {} }] } }] } }),
      'aggregateAnalyses',
    )
    expect(JSON.stringify(passed)).not.toContain(seed)
  })

  test('the instance information shows no secret values', { tag: ['@SEC-014'] }, async ({ adminApi }) => {
    const stack = stackEnv()
    const info = JSON.stringify(ok(await adminApi.getInstanceInfo(), 'getInstanceInfo'))
    for (const name of ['SCANTOR_SECRET', 'SCANTOR_MONGO_PASSWORD', 'SCANTOR_RABBITMQ_PASSWORD', 'SCANTOR_S3_SECRET_KEY', 'SCANTOR_ADMIN_PASSWORD']) {
      const value = stack[name]
      if (value) expect(info.includes(value), `getInstanceInfo shows ${name}`).toBe(false)
    }
  })
})
