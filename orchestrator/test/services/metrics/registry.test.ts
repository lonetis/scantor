import { describe, expect, it } from 'vitest'
import { metricsRegistry } from '../../../server/services/metrics/catalogue'
import { isMeasuredPath, routeLabel } from '../../../server/services/metrics/http'
import { MetricsRegistry } from '../../../server/services/metrics/registry'
import { readRepoFile } from '../../helpers/repo'

// /api/metrics (docs/deployment.md §13.1): the Prometheus text exposition and the metric catalogue, which must
// match the documented table exactly (names, types and labels).

describe('MetricsRegistry', () => {
  it('renders counters, gauges and histograms in the text format 0.0.4', () => {
    const registry = new MetricsRegistry()
    const counter = registry.counter('test_total', 'A counter', ['kind'])
    const gauge = registry.gauge('test_gauge', 'A gauge\nwith a newline')
    const histogram = registry.histogram('test_seconds', 'A histogram', ['op'], [0.1, 1])
    counter.inc({ kind: 'a"b\\c\nd' }, 2)
    gauge.set(undefined, 1.5)
    histogram.observe({ op: 'x' }, 0.5)
    histogram.observe({ op: 'x' }, 3)
    expect(registry.render()).toBe(
      [
        '# HELP test_total A counter',
        '# TYPE test_total counter',
        'test_total{kind="a\\"b\\\\c\\nd"} 2',
        '# HELP test_gauge A gauge\\nwith a newline',
        '# TYPE test_gauge gauge',
        'test_gauge 1.5',
        '# HELP test_seconds A histogram',
        '# TYPE test_seconds histogram',
        'test_seconds_bucket{op="x",le="0.1"} 0',
        'test_seconds_bucket{op="x",le="1"} 1',
        'test_seconds_bucket{op="x",le="+Inf"} 2',
        'test_seconds_sum{op="x"} 3.5',
        'test_seconds_count{op="x"} 2',
        '',
      ].join('\n'),
    )
  })

  it('rejects unknown or missing labels, decreasing counters and duplicate names', () => {
    const registry = new MetricsRegistry()
    const counter = registry.counter('c_total', 'c', ['a'])
    expect(() => counter.inc({ b: 'x' } as never)).toThrow()
    expect(() => counter.inc()).toThrow()
    expect(() => counter.inc({ a: 'x' }, -1)).toThrow()
    expect(() => registry.gauge('c_total', 'again')).toThrow()
  })

  it('replaces gauge samples at scrape time', () => {
    const registry = new MetricsRegistry()
    const gauge = registry.gauge('g', 'g', ['state'])
    gauge.replace([[{ state: 'a' }, 1]])
    gauge.replace([[{ state: 'b' }, 2]])
    expect(registry.render()).not.toContain('state="a"')
    expect(gauge.get({ state: 'b' })).toBe(2)
  })
})

describe('metric catalogue', () => {
  /** Names and types of the §13.1 table (one row may name several metrics). */
  function documentedMetrics(): Map<string, string> {
    const section = readRepoFile('docs/deployment.md').split('### 13.1 Metrics')[1]!.split('### 13.2')[0]!
    const metrics = new Map<string, string>()
    for (const line of section.split('\n')) {
      const cells = line.split('|').map((cell) => cell.trim())
      if (cells.length < 5 || !cells[1]!.startsWith('`scantor_')) continue
      for (const match of cells[1]!.matchAll(/`(scantor_[a-z_]+)`/g)) metrics.set(match[1]!, cells[2]!)
    }
    return metrics
  }

  it('declares exactly the documented metrics with their types', () => {
    const documented = documentedMetrics()
    const declared = metricsRegistry.describe()
    expect(declared.map((metric) => metric.name).sort()).toEqual([...documented.keys()].sort())
    for (const metric of declared) expect(metric.type, metric.name).toBe(documented.get(metric.name))
  })

  // The documented labels of §13.1, spelled out (the table lists label values next to their names).
  it('uses the documented label names', () => {
    const expected: Record<string, string[]> = {
      scantor_build_info: ['version'],
      scantor_scans: ['state'],
      scantor_scan_queue_messages: ['scanId', 'state'],
      scantor_ingest_messages_total: ['kind', 'outcome'],
      scantor_dead_letters_total: ['source', 'reason'],
      scantor_analyses_completed_total: ['status'],
      scantor_workers: ['state', 'role'],
      scantor_nodes: ['state'],
      scantor_node_heartbeat_age_seconds: ['node'],
      scantor_node_disk_free_bytes: ['node'],
      scantor_node_workers_capacity: ['node'],
      scantor_rabbitmq_alarm: ['type'],
      scantor_jobs: ['kind', 'state'],
      scantor_editors: ['state'],
      scantor_helper_duration_seconds: ['op', 'outcome'],
      scantor_http_requests_total: ['method', 'route', 'status'],
      scantor_http_request_duration_seconds: ['method', 'route'],
    }
    for (const metric of metricsRegistry.describe()) expect([...metric.labelNames], metric.name).toEqual(expected[metric.name] ?? [])
  })
})

describe('HTTP request metrics', () => {
  it('measures API, MCP and discovery traffic only', () => {
    expect(isMeasuredPath('/api/scans')).toBe(true)
    expect(isMeasuredPath('/mcp')).toBe(true)
    expect(isMeasuredPath('/.well-known/oauth-authorization-server/api/auth')).toBe(true)
    expect(isMeasuredPath('/scans/123')).toBe(false)
    expect(isMeasuredPath('/_icons/lucide.json')).toBe(false)
  })

  it('labels requests with the route template, never the raw path', () => {
    expect(routeLabel('/api/scans/5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f', '/api/scans/{scanId}')).toBe('/api/scans/{scanId}')
    expect(routeLabel('/api/auth/sign-in/email', undefined)).toBe('/api/auth/*')
    expect(routeLabel('/api/does-not-exist/123', undefined)).toBe('unmatched')
  })
})
