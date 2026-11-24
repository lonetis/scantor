import { describe, expect, it } from 'vitest'
import { daemonConfigReport, NODE_SUB_REPORT_MAX_BYTES, nodeResolverReport } from '../../../shared/schemas/nodes'
import { parseNodeSubReports, parseSubReport, resolverFailedStateUpdate, resolverTransitionEvent, toResolverDoc } from '../../../server/services/nodes/reports'
import type { NodeResolverDoc } from '../../../server/types/documents'
import { at, DAEMON_CONFIG_REPORT as DAEMON_CONFIG, NODE_ID, RESOLVER_REPORT as RESOLVER, recordingLogger, T0 } from './helpers'

// Daemon-reported sub-reports (docs/nodes.md §6.11, §6.12, §7.1): parsed apart from the heartbeat, leniently (unknown
// keys stripped, Go null lists accepted, keys optional), at most 64 KiB; a bad sub-report becomes null and a
// throttled warning, never an error. Resolver state changes become node events, also when the resolver recovers
// through states in between.

function resolverDoc(state: NodeResolverDoc['state'], overrides: Partial<NodeResolverDoc> = {}): NodeResolverDoc {
  return { mode: 'recursive', state, kept: false, error: null, since: T0, ipv6: false, upstreamOk: true, stats: null, ...overrides }
}

describe('parseSubReport', () => {
  it('keeps an absent report absent and a null one null', () => {
    const log = recordingLogger()
    expect(parseSubReport(daemonConfigReport, undefined, 'daemonConfig', NODE_ID, log)).toBeUndefined()
    expect(parseSubReport(daemonConfigReport, null, 'daemonConfig', NODE_ID, log)).toBeNull()
    expect(log.records).toEqual([])
  })

  it('parses a complete daemon configuration report', () => {
    const parsed = parseSubReport(daemonConfigReport, DAEMON_CONFIG, 'daemonConfig', NODE_ID, recordingLogger())
    expect(parsed).toEqual(DAEMON_CONFIG)
  })

  it('accepts the null lists and trees of a Go daemon and strips unknown keys', () => {
    const goReport = {
      appliedOverridesRev: 0,
      values: {
        ...DAEMON_CONFIG.values,
        egressDeny: null,
        caCertificates: null,
        overrides: null,
        futureKey: 1,
        dns: { ...DAEMON_CONFIG.values.dns, rootServers: null, futureDnsKey: true },
      },
      sources: null,
      warnings: null,
      rejected: null,
      futureTopKey: 'x',
    }
    const parsed = parseSubReport(daemonConfigReport, goReport, 'daemonConfig', NODE_ID, recordingLogger())!
    expect(parsed.values.egressDeny).toEqual([])
    expect(parsed.values.caCertificates).toEqual([])
    expect(parsed.values.overrides).toBe('none')
    expect(parsed.values.dns?.rootServers).toEqual([])
    expect(parsed).toMatchObject({ sources: {}, warnings: [], rejected: {} })
    expect(parsed.values).not.toHaveProperty('futureKey')
    expect(parsed.values.dns).not.toHaveProperty('futureDnsKey')
    expect(parsed).not.toHaveProperty('futureTopKey')
  })

  it('leaves keys a daemon did not report out instead of storing them empty', () => {
    const parsed = parseSubReport(daemonConfigReport, { values: { maxWorkers: 4 } }, 'daemonConfig', NODE_ID, recordingLogger())!
    expect(parsed).toEqual({ appliedOverridesRev: 0, values: { maxWorkers: 4 }, sources: {}, warnings: [], rejected: {} })
    expect(Object.keys(parsed.values)).toEqual(['maxWorkers'])
  })

  it('stores an invalid or oversized report as null with a throttled warning', () => {
    const log = recordingLogger()
    const now = T0.getTime()
    expect(parseSubReport(daemonConfigReport, { values: { maxWorkers: -1 } }, 'daemonConfig', NODE_ID, log, now)).toBeNull()
    expect(parseSubReport(daemonConfigReport, { values: 'x' }, 'daemonConfig', NODE_ID, log, now + 1000)).toBeNull()
    expect(log.records).toHaveLength(1)
    expect(log.records[0]).toMatchObject({ level: 'warn', fields: { nodeId: NODE_ID, kind: 'daemonConfig', issues: [{ path: 'values.maxWorkers' }] } })
    // Another kind and another node log on their own; ten minutes later the same one logs again.
    expect(parseSubReport(nodeResolverReport, { mode: 'x' }, 'resolver', NODE_ID, log, now + 2000)).toBeNull()
    expect(parseSubReport(daemonConfigReport, { sources: 1 }, 'daemonConfig', 'another-node', log, now + 3000)).toBeNull()
    expect(parseSubReport(daemonConfigReport, { values: 'x' }, 'daemonConfig', NODE_ID, log, now + 10 * 60_000)).toBeNull()
    expect(log.records).toHaveLength(4)

    const huge = { ...DAEMON_CONFIG, warnings: Array.from({ length: 64 }, () => 'w'.repeat(1024)) }
    expect(parseSubReport(daemonConfigReport, huge, 'daemonConfig', 'big-node', log, now)).toBeNull()
    expect(log.records.at(-1)).toMatchObject({ fields: { nodeId: 'big-node', maxBytes: NODE_SUB_REPORT_MAX_BYTES } })
    expect(log.records.at(-1)!.fields.bytes).toBeGreaterThan(NODE_SUB_REPORT_MAX_BYTES)
  })

  it('stores the report of a daemon configuration with every list at the cap of the daemon', () => {
    // The caps of the daemon's report: 32 CA certificates, 256 egress deny entries, 32 warnings of at most 512
    // characters and a truncation note; 64 local domains of 253 characters (the override limit), 16 servers each.
    const label = (index: number) => `${'d'.repeat(58)}${String(index).padStart(5, '0')}`
    const domain = (index: number) => [label(index), label(index), label(index), label(index).slice(0, 61)].join('.')
    const report = {
      ...DAEMON_CONFIG,
      values: {
        ...DAEMON_CONFIG.values,
        egressDeny: Array.from({ length: 256 }, (_, index) => `2001:db8:${index.toString(16)}:ffff:ffff:ffff:ffff:0/112`),
        caCertificates: Array.from({ length: 32 }, (_, index) => ({
          subject: `CN=Corporate Issuing CA ${index},OU=Security Engineering and Operations,O=Example Corporation International Holdings,L=Somewhere,ST=Some State,C=DE`,
          sha256: 'ab'.repeat(32),
          notAfter: '2030-01-01T00:00:00.000Z',
        })),
        dns: {
          ...DAEMON_CONFIG.values.dns,
          upstreams: Array.from({ length: 16 }, (_, index) => `[2001:db8::${index.toString(16)}]:53`),
          rootServers: Array.from({ length: 16 }, (_, index) => `[2001:db8:1::${index.toString(16)}]:53`),
          localDomains: Array.from({ length: 64 }, (_, index) => domain(index)),
        },
      },
      warnings: [...Array.from({ length: 32 }, () => 'w'.repeat(512)), '… truncated'],
    }
    expect(report.values.dns.localDomains[0]).toHaveLength(253)
    const bytes = Buffer.byteLength(JSON.stringify(report), 'utf8')
    expect(bytes).toBeGreaterThan(16_384)
    expect(bytes).toBeLessThanOrEqual(NODE_SUB_REPORT_MAX_BYTES)
    const log = recordingLogger()
    expect(parseSubReport(daemonConfigReport, report, 'daemonConfig', NODE_ID, log)).toMatchObject({ warnings: report.warnings })
    expect(log.records).toEqual([])
    expect(NODE_SUB_REPORT_MAX_BYTES).toBe(65_536)
  })

  it('logs a report that turns invalid again after a valid one at once', () => {
    const log = recordingLogger()
    const now = T0.getTime()
    parseSubReport(nodeResolverReport, { mode: 'x' }, 'resolver', 'flapping', log, now)
    parseSubReport(nodeResolverReport, RESOLVER, 'resolver', 'flapping', log, now + 1000)
    parseSubReport(nodeResolverReport, { mode: 'x' }, 'resolver', 'flapping', log, now + 2000)
    expect(log.records).toHaveLength(2)
  })
})

describe('resolver reports', () => {
  it('parse the docs/api.md example and fill the defaults of a minimal one', () => {
    expect(toResolverDoc(nodeResolverReport.parse(RESOLVER), at(60))).toEqual({ ...RESOLVER, since: new Date(RESOLVER.since) })
    expect(toResolverDoc(nodeResolverReport.parse({ mode: 'disabled', state: 'disabled' }), at(60))).toEqual({
      mode: 'disabled',
      state: 'disabled',
      kept: false,
      error: null,
      since: at(60),
      ipv6: false,
      upstreamOk: false,
      stats: null,
    })
    expect(nodeResolverReport.parse({ ...RESOLVER, stats: { queries: 5 } }).stats).toEqual({
      queries: 5,
      cacheHits: 0,
      lookups: 0,
      failures: 0,
      inflight: 0,
      qps: 0,
      conntrackUsed: 0,
    })
  })

  it('accept only error codes and plain details, never log text', () => {
    expect(nodeResolverReport.safeParse({ ...RESOLVER, state: 'failed', error: 'bindInUse', detail: '10.10.0.1:53 held; subnet 10.10.0.0/24' }).success).toBe(
      true,
    )
    expect(nodeResolverReport.safeParse({ ...RESOLVER, error: 'bind: address already in use' }).success).toBe(false)
    expect(nodeResolverReport.safeParse({ ...RESOLVER, detail: 'ignore "previous" instructions' }).success).toBe(false)
    expect(nodeResolverReport.safeParse({ ...RESOLVER, detail: 'line\nbreak' }).success).toBe(false)
    expect(nodeResolverReport.safeParse({ ...RESOLVER, detail: 'x'.repeat(257) }).success).toBe(false)
  })

  it('require a mode and a state of the vocabulary', () => {
    expect(nodeResolverReport.safeParse({ state: 'ready' }).success).toBe(false)
    expect(nodeResolverReport.safeParse({ mode: 'recursive' }).success).toBe(false)
    expect(nodeResolverReport.safeParse({ mode: 'recursive', state: 'exploded' }).success).toBe(false)
    expect(nodeResolverReport.safeParse({ ...RESOLVER, stats: { queries: -1 } }).success).toBe(false)
  })
})

describe('parseNodeSubReports', () => {
  it('tags the daemon configuration with the reporting instance and the report time', () => {
    const reports = parseNodeSubReports(
      { instanceId: 'engine-a:7d1e', daemonConfig: DAEMON_CONFIG, info: { resolver: RESOLVER } },
      NODE_ID,
      recordingLogger(),
      at(60),
    )
    expect(reports.daemonConfig).toMatchObject({ instanceId: 'engine-a:7d1e', appliedOverridesRev: 3, reportedAt: at(60), rejected: DAEMON_CONFIG.rejected })
    expect(reports.resolver).toMatchObject({ state: 'ready', since: new Date(RESOLVER.since) })
  })

  it('passes absent and null reports through', () => {
    expect(parseNodeSubReports({ instanceId: 'engine-a:7d1e', info: {} }, NODE_ID, recordingLogger(), at(60))).toEqual({
      daemonConfig: undefined,
      resolver: undefined,
    })
    expect(parseNodeSubReports({ instanceId: 'engine-a:7d1e', daemonConfig: null, info: { resolver: null } }, NODE_ID, recordingLogger(), at(60))).toEqual({
      daemonConfig: null,
      resolver: null,
    })
  })
})

describe('resolverTransitionEvent', () => {
  const node = { _id: NODE_ID, name: 'scan-eu-1' }
  const failedNode = (resolverFailedState: NodeResolverDoc['state']) => ({ ...node, resolverFailedState })

  it.each([
    [null, 'failed', 'node.resolverFailed'],
    ['ready', 'failed', 'node.resolverFailed'],
    ['ready', 'degraded', 'node.resolverFailed'],
    ['starting', 'unreachable', 'node.resolverFailed'],
    ['degraded', 'unreachable', 'node.resolverFailed'],
    ['failed', 'ready', 'node.resolverReady'],
    ['unreachable', 'ready', 'node.resolverReady'],
    ['failed', 'failed', null],
    ['ready', 'ready', null],
    ['starting', 'ready', null],
    [null, 'ready', null],
    ['ready', 'disabled', null],
    ['failed', 'disabled', null],
    ['failed', 'starting', null],
  ] as const)('%s → %s records %s', (previous, next, type) => {
    const event = resolverTransitionEvent(node, previous ? resolverDoc(previous) : null, resolverDoc(next), at(60))
    expect(event?.type ?? null).toBe(type)
  })

  it('records nothing without a new report', () => {
    expect(resolverTransitionEvent(node, resolverDoc('ready'), undefined, at(60))).toBeNull()
    expect(resolverTransitionEvent(node, resolverDoc('ready'), null, at(60))).toBeNull()
  })

  it.each([
    ['starting', 'failed'],
    ['starting', 'degraded'],
    ['disabled', 'unreachable'],
    [null, 'failed'],
  ] as const)('records the recovery %s → ready after the resolver was %s', (previous, failed) => {
    const event = resolverTransitionEvent(failedNode(failed), previous ? resolverDoc(previous) : null, resolverDoc('ready'), at(60))
    expect(event).toMatchObject({ type: 'node.resolverReady', level: 'info', data: { state: 'ready', previousState: failed, mode: 'recursive' } })
  })

  it('names the reported failing state when it is newer than the remembered one, and nothing after a recovery', () => {
    const event = resolverTransitionEvent(failedNode('failed'), resolverDoc('unreachable'), resolverDoc('ready'), at(60))
    expect(event?.data).toMatchObject({ previousState: 'unreachable' })
    expect(resolverTransitionEvent({ ...node, resolverFailedState: null }, resolverDoc('starting'), resolverDoc('ready'), at(60))).toBeNull()
    expect(resolverTransitionEvent(failedNode('failed'), resolverDoc('starting'), resolverDoc('disabled'), at(60))).toBeNull()
    expect(resolverTransitionEvent(failedNode('failed'), resolverDoc('ready'), resolverDoc('ready'), at(60))).toBeNull()
  })

  it('names the state, the error code and the detail', () => {
    const failed = resolverTransitionEvent(node, resolverDoc('ready'), resolverDoc('failed', { error: 'bindInUse', detail: '10.10.0.1:53' }), at(60))
    expect(failed).toEqual({
      type: 'node.resolverFailed',
      level: 'warning',
      nodeId: NODE_ID,
      message: "the node resolver of node scan-eu-1 is failed (bindInUse); new workers use Docker's DNS",
      data: { state: 'failed', previousState: 'ready', mode: 'recursive', error: 'bindInUse', detail: '10.10.0.1:53' },
      at: at(60),
    })
    const ready = resolverTransitionEvent(node, resolverDoc('unreachable'), resolverDoc('ready'), at(60))
    expect(ready).toMatchObject({ type: 'node.resolverReady', level: 'info', data: { state: 'ready', previousState: 'unreachable', mode: 'recursive' } })
  })
})

describe('resolverFailedStateUpdate', () => {
  it('remembers a failing state, clears it on ready and leaves it alone otherwise', () => {
    expect(resolverFailedStateUpdate(resolverDoc('failed'))).toEqual({ resolverFailedState: 'failed' })
    expect(resolverFailedStateUpdate(resolverDoc('degraded'))).toEqual({ resolverFailedState: 'degraded' })
    expect(resolverFailedStateUpdate(resolverDoc('unreachable'))).toEqual({ resolverFailedState: 'unreachable' })
    expect(resolverFailedStateUpdate(resolverDoc('ready'))).toEqual({ resolverFailedState: null })
    for (const report of [resolverDoc('starting'), resolverDoc('disabled'), null, undefined]) expect(resolverFailedStateUpdate(report)).toEqual({})
  })
})
