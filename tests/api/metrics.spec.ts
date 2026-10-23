import { randomUUID } from 'node:crypto'
import { NODE_STATES, SCAN_STATES } from '#shared/utils/enums'
import { ok } from '../helpers/api-client'
import { metricValue, parseMetrics, scrapeMetrics, settleScan, UNPLACEABLE_SETTINGS } from '../helpers/api-results'
import { expect, test as fixturesTest, unique } from '../fixtures'
import { apiResultsTest } from '../helpers/api-results-fixtures'

const test = apiResultsTest(fixturesTest)

// Prometheus metrics (docs/api.md §4.18, docs/deployment.md §13.1): GET /api/metrics is admin only and renders the
// complete metric catalogue in the text format 0.0.4. Counters are shared by the whole suite, so every assertion on
// them is a delta of this test's own traffic (≥, never an absolute value); gauges are checked through objects the
// test owns (its scan's queue gauges) or the shared platform (the two online nodes).

/** The complete catalogue of docs/deployment.md §13.1 with the metric types. */
const CATALOGUE: Record<string, 'counter' | 'gauge' | 'histogram'> = {
  scantor_build_info: 'gauge',
  scantor_scans: 'gauge',
  scantor_scan_queue_messages: 'gauge',
  scantor_ingest_messages_total: 'counter',
  scantor_ingest_lag_messages: 'gauge',
  scantor_ingest_flush_seconds: 'histogram',
  scantor_ingest_batch_size: 'histogram',
  scantor_ingest_whole_batch_failures_total: 'counter',
  scantor_ingest_write_failed_total: 'counter',
  scantor_dead_letters_total: 'counter',
  scantor_breaker_trips_total: 'counter',
  scantor_analyses_completed_total: 'counter',
  scantor_workers: 'gauge',
  scantor_nodes: 'gauge',
  scantor_node_heartbeat_age_seconds: 'gauge',
  scantor_node_disk_free_bytes: 'gauge',
  scantor_node_workers_capacity: 'gauge',
  scantor_rabbitmq_alarm: 'gauge',
  scantor_jobs: 'gauge',
  scantor_editors: 'gauge',
  scantor_helpers_running: 'gauge',
  scantor_helper_duration_seconds: 'histogram',
  scantor_http_requests_total: 'counter',
  scantor_http_request_duration_seconds: 'histogram',
  scantor_registry_gc_last_success_timestamp_seconds: 'gauge',
}

/** Route labels of requests that match no operation (server/services/metrics/http.ts). */
const FIXED_ROUTE_LABELS = ['/mcp', '/api/auth/*', '/api/docs', '/.well-known/*', 'unmatched']

type ErrorBody = { error: { code: string; details?: { issues?: { path: string }[] } } }

/** `# TYPE <name> <type>` declarations of a Prometheus text exposition. */
function declaredTypes(text: string): Map<string, string> {
  const types = new Map<string, string>()
  for (const match of text.matchAll(/^# TYPE (\S+) (\S+)$/gm)) types.set(match[1]!, match[2]!)
  return types
}

/** The family a sample belongs to (histogram samples carry the _bucket, _sum and _count suffixes). */
function familyOf(sample: string, types: ReadonlyMap<string, string>): string | undefined {
  if (types.has(sample)) return sample
  const base = sample.replace(/_(bucket|sum|count)$/, '')
  return types.get(base) === 'histogram' ? base : undefined
}

test.describe('GET /api/metrics', () => {
  test('is admin only and accepts no query parameters', { tag: ['@PLAT-007'] }, async ({ anonApi, api, apiKeyApi, adminApi }) => {
    const anonymous = await anonApi.call<ErrorBody>('getMetrics')
    expect(anonymous.status).toBe(401)
    expect(anonymous.body.error.code).toBe('unauthorized')
    for (const [who, client] of [
      ['session', api],
      ['API key', apiKeyApi],
    ] as const) {
      const denied = await client.call<ErrorBody>('getMetrics')
      expect(denied.status, who).toBe(403)
      expect(denied.body.error.code, who).toBe('adminRequired')
      expect(denied.raw.toString('utf8'), who).not.toContain('scantor_build_info')
    }
    for (const query of [{ format: 'json' }, { name: 'scantor_scans' }, { wait: 1 }]) {
      const rejected = await adminApi.call<ErrorBody>('getMetrics', { query })
      expect(rejected.status, JSON.stringify(query)).toBe(400)
      expect(rejected.body.error.code, JSON.stringify(query)).toBe('validationFailed')
    }
  })

  test('returns the Prometheus text exposition with every family of the catalogue', { tag: ['@PLAT-007'] }, async ({ adminApi, anonApi }) => {
    const response = await adminApi.call('getMetrics')
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4(;|$)/)
    const text = response.raw.toString('utf8')
    const types = declaredTypes(text)
    for (const [name, type] of Object.entries(CATALOGUE)) expect(types.get(name), name).toBe(type)
    for (const name of types.keys()) expect(text, name).toMatch(new RegExp(`^# HELP ${name} \\S`, 'm'))

    // Every sample belongs to a declared family; values are numbers.
    const samples = parseMetrics(text)
    for (const sample of samples) {
      expect(familyOf(sample.name, types), sample.name).toBeDefined()
      expect(Number.isNaN(sample.value), sample.name).toBe(false)
    }

    const version = ok(await anonApi.getHealth(), 'getHealth').version
    expect(samples.filter((sample) => sample.name === 'scantor_build_info')).toEqual([{ name: 'scantor_build_info', labels: { version }, value: 1 }])

    // Scans and nodes are zero-filled for every state; the shared platform has at least two online nodes.
    const scanStates = samples.filter((sample) => sample.name === 'scantor_scans').map((sample) => sample.labels.state)
    expect(scanStates).toEqual(expect.arrayContaining([...SCAN_STATES]))
    const nodeStates = samples.filter((sample) => sample.name === 'scantor_nodes').map((sample) => sample.labels.state)
    expect(nodeStates).toEqual(expect.arrayContaining([...NODE_STATES]))
    expect(metricValue(samples, 'scantor_nodes', { state: 'online' })).toBeGreaterThanOrEqual(2)

    const alarms = samples.filter((sample) => sample.name === 'scantor_rabbitmq_alarm')
    expect(alarms.map((sample) => sample.labels.type).sort()).toEqual(['disk', 'memory'])
    for (const alarm of alarms) expect([0, 1]).toContain(alarm.value)

    for (const sample of samples.filter((candidate) => candidate.name === 'scantor_workers'))
      expect(Object.keys(sample.labels).sort()).toEqual(['role', 'state'])
    for (const sample of samples.filter((candidate) => candidate.name === 'scantor_jobs')) expect(Object.keys(sample.labels).sort()).toEqual(['kind', 'state'])
    for (const sample of samples.filter((candidate) => candidate.name === 'scantor_ingest_messages_total')) {
      expect(['result', 'attempt', 'dead']).toContain(sample.labels.kind)
      expect(['applied', 'duplicate', 'dropped', 'rejected', 'failedRecorded']).toContain(sample.labels.outcome)
    }
    for (const sample of samples.filter((candidate) => candidate.name === 'scantor_dead_letters_total')) {
      expect(['scan', 'results']).toContain(sample.labels.source)
      expect(sample.labels.reason).toEqual(expect.any(String))
    }
  })

  test('the scan gauges follow a running scan', { tag: ['@PLAT-007'] }, async ({ api, adminApi, resultset }) => {
    // No worker is ever placed, so the scan stays running with its queue and RabbitMQ user.
    const scan = await resultset.start({ scanConfig: { items: ['a'] }, settings: UNPLACEABLE_SETTINGS })
    await settleScan(api, scan.id, 'running', 60_000)

    // The queue gauges come from the management API, refreshed at most every 15 s.
    await expect
      .poll(
        async () =>
          (await scrapeMetrics(adminApi))
            .filter((sample) => sample.name === 'scantor_scan_queue_messages' && sample.labels.scanId === scan.id)
            .map((sample) => sample.labels.state)
            .sort(),
        { timeout: 60_000, intervals: [2000] },
      )
      .toEqual(['delayed', 'ready', 'unacked'])
    const samples = await scrapeMetrics(adminApi)
    expect(metricValue(samples, 'scantor_scans', { state: 'running' })).toBeGreaterThanOrEqual(1)
    for (const sample of samples.filter((candidate) => candidate.name === 'scantor_scan_queue_messages' && candidate.labels.scanId === scan.id)) {
      expect(sample.value, sample.labels.state).toBeGreaterThanOrEqual(0)
    }

    // Once the scan is cancelled its queue is deleted and its gauges disappear.
    ok(await api.cancelScan(scan.id), 'cancelScan')
    await settleScan(api, scan.id, 'cancelled', 60_000)
    await expect
      .poll(async () => (await scrapeMetrics(adminApi)).filter((sample) => sample.name === 'scantor_scan_queue_messages' && sample.labels.scanId === scan.id), {
        timeout: 60_000,
        intervals: [2000],
      })
      .toEqual([])
  })

  test('HTTP requests are counted by route pattern, never by raw path', { tag: ['@PLAT-008'] }, async ({ api, adminApi, openapi }) => {
    const scanId = randomUUID()
    const unmatchedPath = `/api/${unique('no-such-route')}`
    const route = { method: 'GET', route: '/api/scans/{scanId}', status: '404' }
    const unmatched = { method: 'GET', route: 'unmatched', status: '404' }
    const before = await scrapeMetrics(adminApi)

    for (let n = 0; n < 3; n++) expect((await api.getScan(scanId)).status).toBe(404)
    expect((await api.request.get(unmatchedPath)).status()).toBe(404)

    // A request is recorded when its response closes, so the counter may trail the response by a moment.
    let after = before
    await expect
      .poll(
        async () => {
          after = await scrapeMetrics(adminApi)
          return metricValue(after, 'scantor_http_requests_total', route) - metricValue(before, 'scantor_http_requests_total', route)
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(3)
    expect(metricValue(after, 'scantor_http_requests_total', unmatched) - metricValue(before, 'scantor_http_requests_total', unmatched)).toBeGreaterThanOrEqual(
      1,
    )
    const durations = after.filter((sample) => sample.name === 'scantor_http_request_duration_seconds_count' && sample.labels.route === '/api/scans/{scanId}')
    expect(durations.map((sample) => sample.labels.method)).toContain('GET')

    // No label anywhere carries the raw paths; every route label is an operation's path template or a fixed label.
    const raw = (await adminApi.call('getMetrics')).raw.toString('utf8')
    expect(raw).not.toContain(scanId)
    expect(raw).not.toContain(unmatchedPath)
    const templates = new Set([...Object.keys(openapi.document.paths), ...FIXED_ROUTE_LABELS])
    const routes = new Set(
      parseMetrics(raw)
        .filter((sample) => sample.name === 'scantor_http_requests_total' || sample.name.startsWith('scantor_http_request_duration_seconds'))
        .map((sample) => sample.labels.route!),
    )
    for (const label of routes) expect(templates.has(label), label).toBe(true)
  })
})
