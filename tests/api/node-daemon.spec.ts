import { readFileSync } from 'node:fs'
import type { ItemList, Page } from '#shared/types/common'
import type { Event } from '#shared/types/events'
import type { Node, NodeResolverReport } from '#shared/types/nodes'
import { ok, type ApiClient, type ApiResponse } from '../helpers/api-client'
import { NodeTracker, type FakeNode } from '../helpers/api-platform-nodes'
import { ENVIRONMENT_ONLY_SERVER, FAKE_RESOLVER_STATS, fakeResolverReport } from '../helpers/fake-daemon'
import { withPlatformAdmin, withWorkerTenant } from '../helpers/api-platform-tenant'
import { temporaryApiKey } from '../helpers/api-platform-users'
import { scantor } from '../helpers/cli'
import { stackEnv } from '../helpers/docker'
import { stackKeys } from '../helpers/keys'
import { daemonConfigOf, deleteDaemonOverrides, getNode, patchDaemonOverrides, waitForNode, waitForOverridesApplied } from '../helpers/node-resolver'
import { expect, test as base, unique } from '../fixtures'

// What node daemons report about their node resolver and their configuration, and the daemon overrides of the admin
// (docs/nodes.md §6.11, §6.12; docs/api.md §4.17, §7.1, §7.3). Fake daemons (helpers/api-platform-nodes.ts with
// helpers/fake-daemon.ts) report what a test needs and apply overrides like the real daemon; the built-in node and
// remote-1 are only read (docs/testing.md §9 rule 4). Throwaway nodes with real daemons cover the daemon's side in
// e2e/node-resolver.spec.ts.

const test = base.extend<{ nodes: NodeTracker }>({
  // An admin of the worker and a tenant with a uniquely named session (helpers/api-platform-tenant.ts).
  adminApi: [async ({ openapi }, use) => withPlatformAdmin(openapi, use), { scope: 'worker', timeout: 150_000 }],
  user: [
    async ({ adminApi, openapi }, use, workerInfo) => withWorkerTenant(adminApi, openapi, `w${workerInfo.workerIndex}`, use),
    { scope: 'worker', timeout: 150_000 },
  ],
  nodes: async ({ adminApi, openapi }, use) => {
    const tracker = new NodeTracker(adminApi, openapi)
    await use(tracker)
    await tracker.dispose()
  },
})

test.describe.configure({ timeout: 180_000 })

async function nodeEvents(adminApi: ApiClient, nodeId: string, type: string): Promise<Event[]> {
  return ok(await adminApi.call<Page<Event>>('listNodeEvents', { path: { nodeId }, query: { type, limit: 100 } }), 'listNodeEvents').items
}

/** Expects a stored resolver report equal to the one a daemon sent (the fields it sent; `since` as a time). */
function expectResolver(stored: NodeResolverReport | null | undefined, sent: NodeResolverReport): void {
  const { since, ...rest } = sent
  expect(stored).toMatchObject(Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)))
  expect(Date.parse(stored!.since)).toBe(Date.parse(since))
}

/** The node's events of a type recorded at or after `since` (epoch ms), newest first. */
async function eventsSince(adminApi: ApiClient, nodeId: string, type: string, since: number): Promise<Event[]> {
  return (await nodeEvents(adminApi, nodeId, type)).filter((event) => Date.parse(event.at) >= since)
}

/** Expects 409 daemonOverridesUnavailable with the reason. */
function expectUnavailable(response: ApiResponse<Node>, reason: 'noInstance' | 'notReported' | 'notAllowed'): Record<string, unknown> {
  expect(response.status, JSON.stringify(response.body)).toBe(409)
  const error = (response.body as unknown as { error: { code: string; details?: Record<string, unknown> } }).error
  expect(error.code).toBe('daemonOverridesUnavailable')
  expect(error.details).toMatchObject({ reason })
  return error.details!
}

/** Waits until the node shows the daemon configuration of its current daemon instance. */
const reported = (adminApi: ApiClient, node: FakeNode) => waitForNode(adminApi, node.id, 'a daemon configuration', (n) => !!n.daemonConfig, 30_000)

test.describe('the node resolver report', () => {
  test('info.resolver holds the report of hello and status, and its state changes are events', { tag: ['@NODE-038'] }, async ({ adminApi, nodes }) => {
    const fake = await nodes.fake({ resolver: { state: 'starting', upstreamOk: false, stats: null } })
    await fake.online()
    expectResolver((await getNode(adminApi, fake.id)).info?.resolver, fake.resolver!)

    // Ready, with stats: a resolver that never failed records nothing.
    await fake.setResolver({ state: 'ready', upstreamOk: true, spec: `sha256:${'1a'.repeat(32)}`, since: new Date().toISOString() })
    await waitForNode(adminApi, fake.id, 'a ready resolver', (node) => node.info?.resolver?.state === 'ready', 30_000)
    expectResolver((await getNode(adminApi, fake.id)).info?.resolver, fake.resolver!)
    expect(await nodeEvents(adminApi, fake.id, 'node.resolverFailed')).toEqual([])
    expect(await nodeEvents(adminApi, fake.id, 'node.resolverReady')).toEqual([])

    // Failed: one warning, however often the daemon reports the same state.
    const failedAt = Date.now()
    await fake.setResolver({ state: 'failed', error: 'bindInUse', detail: '10.99.0.1:53', upstreamOk: false, stats: null, since: new Date().toISOString() })
    await fake.report()
    const failed = await waitForNode(adminApi, fake.id, 'a failed resolver', (node) => node.info?.resolver?.state === 'failed', 30_000)
    expectResolver(failed.info?.resolver, fake.resolver!)
    await expect
      .poll(async () => (await eventsSince(adminApi, fake.id, 'node.resolverFailed', failedAt)).map((event) => [event.level, event.nodeId, event.data]), {
        timeout: 15_000,
      })
      .toEqual([['warning', fake.id, { state: 'failed', previousState: 'ready', mode: 'recursive', error: 'bindInUse', detail: '10.99.0.1:53' }]])

    // Back to ready: one resolverReady.
    const readyAt = Date.now()
    await fake.setResolver({ state: 'ready', error: null, detail: undefined, upstreamOk: true, stats: { ...FAKE_RESOLVER_STATS, queries: 5 } })
    await fake.report()
    await waitForNode(adminApi, fake.id, 'a ready resolver again', (node) => node.info?.resolver?.state === 'ready', 30_000)
    await expect
      .poll(async () => (await eventsSince(adminApi, fake.id, 'node.resolverReady', readyAt)).map((event) => [event.level, event.nodeId, event.data]), {
        timeout: 15_000,
      })
      .toEqual([['info', fake.id, { state: 'ready', previousState: 'failed', mode: 'recursive' }]])

    // Degraded (its upstream servers do not answer) is a failure too.
    const degradedAt = Date.now()
    await fake.setResolver({ state: 'degraded', error: 'upstreamUnreachable', upstreamOk: false })
    await expect.poll(async () => (await eventsSince(adminApi, fake.id, 'node.resolverFailed', degradedAt)).length, { timeout: 15_000 }).toBe(1)
    expect(await nodeEvents(adminApi, fake.id, 'node.resolverFailed')).toHaveLength(2)

    // A malformed report never fails the heartbeat: the status is accepted and the report stored as null.
    await fake.stopHeartbeat()
    const before = (await getNode(adminApi, fake.id)).lastSeenAt!
    const malformed = await fake.daemon.status(fake.reportedInfo, [], { resolver: { state: 'exploded', stats: 'many', since: 7 } })
    expect(malformed.status, JSON.stringify(malformed.body)).toBe(200)
    const after = await getNode(adminApi, fake.id)
    expect(after.info?.resolver ?? null).toBeNull()
    expect(Date.parse(after.lastSeenAt!)).toBeGreaterThanOrEqual(Date.parse(before))
    expect(after.state).toBe('online')
  })

  test(
    'a resolver that recovers through starting or a daemon restart records node.resolverReady with the state it recovered from',
    { tag: ['@NODE-038'] },
    async ({ adminApi, nodes }) => {
      const fake = await nodes.fake({ resolver: { state: 'starting', upstreamOk: false, stats: null } })
      await fake.online()
      await fake.setResolver({ state: 'ready', upstreamOk: true, stats: { ...FAKE_RESOLVER_STATS } })
      const ready = (event: Event) => [event.level, event.data]

      // Failed, then the daemon starts the resolver again: starting records nothing, ready records the recovery from
      // failed.
      const failedAt = Date.now()
      await fake.setResolver({ state: 'failed', error: 'crashLoop', upstreamOk: false, stats: null })
      expect((await eventsSince(adminApi, fake.id, 'node.resolverFailed', failedAt)).map((event) => event.data)).toEqual([
        { state: 'failed', previousState: 'ready', mode: 'recursive', error: 'crashLoop' },
      ])
      await fake.setResolver({ state: 'starting', error: null })
      expect(await eventsSince(adminApi, fake.id, 'node.resolverReady', failedAt)).toEqual([])
      await fake.setResolver({ state: 'ready', upstreamOk: true, stats: { ...FAKE_RESOLVER_STATS } })
      expect((await eventsSince(adminApi, fake.id, 'node.resolverReady', failedAt)).map(ready)).toEqual([
        ['info', { state: 'ready', previousState: 'failed', mode: 'recursive' }],
      ])

      // Degraded, then a daemon restart: the new instance's hello carries no resolver report yet (the stored one goes),
      // its first status reports starting, and ready again records the recovery from degraded.
      const degradedAt = Date.now()
      await fake.setResolver({ state: 'degraded', error: 'upstreamUnreachable', upstreamOk: false })
      expect((await eventsSince(adminApi, fake.id, 'node.resolverFailed', degradedAt)).map((event) => event.data)).toEqual([
        { state: 'degraded', previousState: 'ready', mode: 'recursive', error: 'upstreamUnreachable' },
      ])
      fake.resolver = null
      await fake.restartDaemon()
      expect((await getNode(adminApi, fake.id)).info?.resolver ?? null).toBeNull()
      await fake.setResolver({ state: 'starting', error: null, upstreamOk: false, stats: null })
      expect(await eventsSince(adminApi, fake.id, 'node.resolverReady', degradedAt)).toEqual([])
      await fake.setResolver({ state: 'ready', upstreamOk: true, stats: { ...FAKE_RESOLVER_STATS } })
      expect((await eventsSince(adminApi, fake.id, 'node.resolverReady', degradedAt)).map(ready)).toEqual([
        ['info', { state: 'ready', previousState: 'degraded', mode: 'recursive' }],
      ])

      // The recovery ended the failure: a later daemon restart (hello with starting, then ready) records nothing.
      const restartedAt = Date.now()
      fake.resolver = fakeResolverReport({ state: 'starting', upstreamOk: false, stats: null })
      await fake.restartDaemon()
      await fake.setResolver({ state: 'ready', upstreamOk: true, stats: { ...FAKE_RESOLVER_STATS } })
      expect(await eventsSince(adminApi, fake.id, 'node.resolverReady', restartedAt)).toEqual([])
      expect(await nodeEvents(adminApi, fake.id, 'node.resolverFailed')).toHaveLength(2)
    },
  )

  test('overlapping status reports record each resolver state change once', { tag: ['@NODE-038'] }, async ({ adminApi, nodes }) => {
    const fake = await nodes.fake({ resolver: {} })
    await fake.online()
    await waitForNode(adminApi, fake.id, 'a ready resolver', (node) => node.info?.resolver?.state === 'ready', 30_000)
    // The fake daemon sends one report at a time; here four go at once, as when a slow report overlaps the next one.
    await fake.stopHeartbeat()
    const overlapping = async (resolver: NodeResolverReport) => {
      const answers = await Promise.all(Array.from({ length: 4 }, () => fake.daemon.status(fake.reportedInfo, [], { resolver })))
      for (const answer of answers) expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    }

    const unreachableAt = Date.now()
    await overlapping(fakeResolverReport({ state: 'unreachable', error: 'probeFailed' }))
    expect((await eventsSince(adminApi, fake.id, 'node.resolverFailed', unreachableAt)).map((event) => event.data)).toEqual([
      { state: 'unreachable', previousState: 'ready', mode: 'recursive', error: 'probeFailed' },
    ])
    const readyAt = Date.now()
    await overlapping(fakeResolverReport())
    expect((await eventsSince(adminApi, fake.id, 'node.resolverReady', readyAt)).map((event) => event.data)).toEqual([
      { state: 'ready', previousState: 'unreachable', mode: 'recursive' },
    ])
  })

  test('a daemon without a node resolver reports none', { tag: ['@NODE-038'] }, async ({ adminApi, nodes }) => {
    const fake = await nodes.fake()
    await fake.online()
    const node = await getNode(adminApi, fake.id)
    expect(node.info?.resolver ?? null).toBeNull()
    expect(node.daemonConfig ?? null).toBeNull()
  })
})

test.describe('the daemon configuration', () => {
  test('the shared nodes report their configuration with sources and without any secret', { tag: ['@NODE-043'] }, async ({ adminApi, env }) => {
    const nodes = ok(await adminApi.listNodes(), 'listNodes').items
    const builtinId = nodes.find((node) => node.builtIn)!.id
    const remoteId = nodes.find((node) => node.name === 'remote-1')!.id
    const stack = stackEnv()
    const remoteToken = (JSON.parse(readFileSync(env.paths.remoteNode, 'utf8')) as { token: string }).token
    const secrets = [stackKeys().builtinNodeToken(), stack.SCANTOR_SECRET!, remoteToken]

    // The built-in node: its daemon gets the stack's node settings through compose (tests/docker/stack.env).
    const builtin = await getNode(adminApi, builtinId)
    const config = daemonConfigOf(builtin)
    expect(config.values).toMatchObject({
      builtIn: true,
      maxWorkers: Number(stack.SCANTOR_BUILTIN_NODE_MAX_WORKERS),
      overrides: 'all',
      dns: { mode: 'recursive', upstreams: ['172.17.0.1'], maxLookups: 100 },
    })
    expect(config.sources).toMatchObject({ maxWorkers: 'env', dns: { upstreams: 'env', maxLookups: 'env' } })
    expect(config.warnings).toEqual(expect.any(Array))
    expect(config.overrides).toEqual({})
    expect(config.rejected).toEqual({})
    expect(config).toMatchObject({ pending: false, appliedOverridesRev: config.overridesRev })
    expect(Number.isNaN(Date.parse(config.reportedAt))).toBe(false)
    // Every setting is reported: the values have a source each.
    for (const key of Object.keys(config.values).filter((k) => k !== 'dns')) expect(config.sources, key).toHaveProperty(key)
    for (const key of Object.keys(config.values.dns)) expect(config.sources.dns, `dns.${key}`).toHaveProperty(key)

    // remote-1: joined with the stack's resolver settings only, so its mode is a default.
    const remote = daemonConfigOf(await getNode(adminApi, remoteId))
    expect(remote.values).toMatchObject({ url: stack.SCANTOR_PUBLIC_URL, builtIn: false, dns: { mode: 'recursive', upstreams: ['172.17.0.1'] } })
    expect(remote.sources).toMatchObject({ url: 'env', dns: { mode: 'default', upstreams: 'env' } })

    // Only with include=daemonConfig does the list carry it.
    const plain = ok(await adminApi.listNodes(), 'listNodes').items
    for (const node of plain) expect(node, node.name).not.toHaveProperty('daemonConfig')
    const included = ok(await adminApi.call<ItemList<Node>>('listNodes', { query: { include: 'daemonConfig' } }), 'listNodes').items
    expect(included.find((node) => node.id === builtinId)?.daemonConfig?.values).toEqual(config.values)
    expect((await adminApi.call('listNodes', { query: { include: 'everything' } })).status).toBe(400)

    for (const body of [builtin, remote, included]) {
      const text = JSON.stringify(body)
      for (const secret of secrets) expect(text.includes(secret), 'a secret in the daemon configuration').toBe(false)
      expect(text).not.toMatch(/snt_[A-Za-z0-9_-]{20,}/)
    }
  })

  test(
    'a fake daemon’s report is represented with its values, sources and warnings; a malformed one is stored as null',
    { tag: ['@NODE-043'] },
    async ({ adminApi, nodes }) => {
      const warnings = ['SCANTOR_NODE_PIDS_LIMIT: "lots" is not a number, using the default']
      const fake = await nodes.fake({ daemonConfig: { fromEnv: ['maxWorkers', 'dns.mode'], warnings, values: { dns: { mode: 'iterative' } } } })
      await fake.online()
      const node = await reported(adminApi, fake)
      const report = fake.config!.report()
      const config = daemonConfigOf(node)
      expect(config).toMatchObject({ overridesRev: 0, appliedOverridesRev: 0, pending: false, overriddenBy: null, overriddenAt: null })
      expect(config.values).toEqual(report.values)
      expect(config.sources).toEqual(report.sources)
      expect(config.warnings).toEqual(warnings)
      expect(config.overrides).toEqual({})
      expect(config.rejected).toEqual({})
      expect(config.sources).toMatchObject({ url: 'env', maxWorkers: 'env', pidsLimit: 'default', dns: { mode: 'env', upstreams: 'default' } })
      expect(config.values.dns.mode).toBe('iterative')

      // A malformed daemon configuration never fails the heartbeat: it is stored as null.
      await fake.stopHeartbeat()
      const malformed = await fake.daemon.status(fake.reportedInfo, [], { daemonConfig: { values: 'everything', appliedOverridesRev: 'one' } })
      expect(malformed.status, JSON.stringify(malformed.body)).toBe(200)
      expect((await getNode(adminApi, fake.id)).daemonConfig ?? null).toBeNull()
    },
  )

  test(
    'a daemon configuration at the caps of the daemon’s report is stored whole, one above 64 KiB as null',
    { tag: ['@NODE-043'] },
    async ({ adminApi, nodes }) => {
      // The largest reports a daemon sends (helpers/fake-daemon.ts DAEMON_REPORT_CAPS): its environment holds more CA
      // certificates, deny entries and warnings than the report lists, and 64 local domains of 253 characters.
      const caCertificates = Array.from({ length: 40 }, (_, i) => ({
        subject: `CN=scantor test authority ${i},OU=${'x'.repeat(280)}`,
        sha256: i.toString(16).padStart(64, '0'),
        notAfter: '2036-01-01T00:00:00Z',
      }))
      const egressDeny = Array.from({ length: 300 }, (_, i) => `2001:db8:${i.toString(16)}:ffff:ffff:ffff:ffff:0/112`)
      const warnings = Array.from({ length: 40 }, (_, i) => `SCANTOR_NODE_PIDS_LIMIT: value ${i} ${'w'.repeat(600)}`)
      const localDomains = Array.from(
        { length: 64 },
        (_, i) => `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${String(i).padStart(2, '0')}${'d'.repeat(59)}`,
      )
      const fake = await nodes.fake({
        daemonConfig: {
          values: { caCertificates, egressDeny, dns: { localDomains } },
          fromEnv: ['caCertificates', 'egressDeny', 'dns.localDomains'],
          warnings,
        },
      })
      const report = fake.config!.report()
      expect(report.values.caCertificates).toHaveLength(32)
      expect(report.values.egressDeny).toHaveLength(256)
      expect(report.warnings).toHaveLength(32)
      expect(report.warnings.at(-1)).toBe(
        'the daemon configuration report is truncated: it lists 32 of 40 certificates of SCANTOR_CA_CERT, 256 of 300 CIDRs of SCANTOR_NODE_EGRESS_DENY, 31 of 40 warnings (the daemon applies every certificate and CIDR)',
      )
      const bytes = Buffer.byteLength(JSON.stringify(report), 'utf8')
      expect(bytes).toBeGreaterThan(48 * 1024)
      expect(bytes).toBeLessThanOrEqual(64 * 1024)

      await fake.online()
      const config = daemonConfigOf(await reported(adminApi, fake))
      expect(config.values.caCertificates).toEqual(report.values.caCertificates)
      expect(config.values.egressDeny).toEqual(report.values.egressDeny)
      expect(config.values.dns.localDomains).toEqual(localDomains)
      expect(config.warnings).toEqual(report.warnings)
      expect(config.sources).toMatchObject({ caCertificates: 'env', egressDeny: 'env', dns: { localDomains: 'env' } })

      // Above 64 KiB the report is stored as null, and the status still succeeds.
      await fake.stopHeartbeat()
      const oversized = { ...report, warnings: Array.from({ length: 64 }, (_, i) => `${i} ${'w'.repeat(1000)}`) }
      expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeGreaterThan(64 * 1024)
      const answer = await fake.daemon.status(fake.reportedInfo, [], { daemonConfig: oversized })
      expect(answer.status, JSON.stringify(answer.body)).toBe(200)
      expect((await getNode(adminApi, fake.id)).daemonConfig ?? null).toBeNull()
    },
  )

  test('scantor nodes daemon-config prints every setting with its value, source and variable', { tag: ['@NODE-043'] }, async ({ adminApi, nodes }) => {
    const key = await temporaryApiKey(adminApi, unique('daemon-config-cli'))
    try {
      const human = await scantor(['nodes', 'daemon-config', 'builtin'], { token: key.key, timeoutMs: 60_000 })
      expect(human.exitCode, human.stderr).toBe(0)
      for (const text of ['dns.upstreams', 'SCANTOR_NODE_DNS_UPSTREAMS', '172.17.0.1', 'maxWorkers', 'SCANTOR_NODE_MAX_WORKERS', 'env']) {
        expect(human.stdout, text).toContain(text)
      }
      const json = await scantor(['nodes', 'daemon-config', 'builtin', '-o', 'json'], { token: key.key, timeoutMs: 60_000 })
      expect(json.exitCode, json.stderr).toBe(0)
      const text = JSON.stringify(json.json)
      expect(text).toContain('172.17.0.1')
      expect(text).not.toContain(stackKeys().builtinNodeToken())

      // A node without a reported daemon configuration: the command says so instead of printing a table.
      const old = await nodes.fake()
      await old.online()
      const none = await scantor(['nodes', 'daemon-config', old.id], { token: key.key, timeoutMs: 60_000 })
      expect(none.exitCode, none.stderr).toBe(0)
      expect(none.stdout).toContain(`node ${old.name} has not reported a valid daemon configuration`)
    } finally {
      await key.dispose()
    }
  })
})

test.describe('daemon overrides', () => {
  test(
    'a merge patch sets the overrides of the current instance, the daemon applies them, and DELETE removes them',
    { tag: ['@NODE-044'] },
    async ({ adminApi, nodes }) => {
      const adminId = ok(await adminApi.getAccount(), 'getAccount').id
      // The daemon's SCANTOR_NODE_EGRESS_DENY holds a public range (TEST-NET-1), which the API cannot know about.
      const fake = await nodes.fake({ daemonConfig: { values: { egressDeny: ['169.254.0.0/16', '192.0.2.0/24'] }, fromEnv: ['egressDeny'] } })
      await fake.online()
      await reported(adminApi, fake)
      expect(await fake.syncOverrides()).toEqual({ rev: 0, values: {} })

      const upstreams = ['9.9.9.9', '149.112.112.112:53', '[2620:fe::fe]:53']
      const patched = ok(await patchDaemonOverrides(adminApi, fake.id, { maxWorkers: 4, dns: { mode: 'iterative', upstreams } }), 'updateNodeDaemonOverrides')
      expect(patched.id).toBe(fake.id)
      const first = patched.daemonConfig!
      expect(first.overrides).toEqual({ maxWorkers: 4, dns: { mode: 'iterative', upstreams } })
      expect(first).toMatchObject({ pending: true, overriddenBy: adminId })
      expect(first.overridesRev).toBeGreaterThan(0)
      expect(first.overriddenAt).not.toBeNull()
      const rev = first.overridesRev

      // The daemon reads them with its assignments and applies them; the node then shows them in effect.
      expect(await fake.syncOverrides()).toEqual({ rev, values: first.overrides })
      const applied = await waitForOverridesApplied(adminApi, fake.id, (config) => config.appliedOverridesRev === rev)
      expect(applied.daemonConfig).toMatchObject({
        pending: false,
        values: { maxWorkers: 4, dns: { mode: 'iterative', upstreams } },
        sources: { maxWorkers: 'override', pidsLimit: 'default', dns: { mode: 'override', upstreams: 'override', maxLookups: 'default' } },
      })
      expect(applied.daemonConfig!.rejected).toEqual({})
      expect(applied.info?.maxWorkers).toBe(4)

      // null removes a key and leaves the others; `dns: null` removes every dns override.
      const withoutMode = ok(await patchDaemonOverrides(adminApi, fake.id, { dns: { mode: null } }), 'updateNodeDaemonOverrides').daemonConfig!
      expect(withoutMode.overridesRev).toBe(rev + 1)
      expect(withoutMode.overrides.maxWorkers).toBe(4)
      expect(withoutMode.overrides.dns?.mode).toBeUndefined()
      expect(withoutMode.overrides.dns?.upstreams).toEqual(upstreams)
      const withoutDns = ok(await patchDaemonOverrides(adminApi, fake.id, { dns: null, pidsLimit: 2048 }), 'updateNodeDaemonOverrides').daemonConfig!
      expect(withoutDns).toMatchObject({ overridesRev: rev + 2, pending: true })
      expect(withoutDns.overrides).toEqual({ maxWorkers: 4, pidsLimit: 2048 })

      // A value the daemon refuses (a root server inside its egress deny list, which only its environment may name):
      // the revision counts as applied, the key shows in `rejected` and its value is not in effect.
      const refused = ok(await patchDaemonOverrides(adminApi, fake.id, { dns: { rootServers: ['192.0.2.1:53'] } }), 'updateNodeDaemonOverrides').daemonConfig!
      await fake.syncOverrides()
      const partly = await waitForOverridesApplied(adminApi, fake.id, (config) => config.appliedOverridesRev === refused.overridesRev)
      expect(partly.daemonConfig).toMatchObject({
        pending: false,
        values: { maxWorkers: 4, pidsLimit: 2048, dns: { rootServers: [] } },
        sources: { pidsLimit: 'override', dns: { rootServers: 'default' } },
        rejected: { dns: { rootServers: ENVIRONMENT_ONLY_SERVER } },
      })

      const changed = await nodeEvents(adminApi, fake.id, 'node.daemonOverridesChanged')
      expect(changed).toHaveLength(4)
      for (const event of changed)
        expect(event).toMatchObject({ type: 'node.daemonOverridesChanged', nodeId: fake.id, level: 'info', data: { by: adminId, cleared: false } })
      expect(changed[0]!.data!.keys).toEqual(expect.arrayContaining([expect.stringMatching(/rootServers/)]))
      expect(changed[1]!.data!.keys).toEqual(expect.arrayContaining(['pidsLimit']))

      // DELETE removes every override, once; repeating it changes nothing.
      const reset = ok(await deleteDaemonOverrides(adminApi, fake.id), 'deleteNodeDaemonOverrides').daemonConfig!
      expect(reset).toMatchObject({ overridesRev: refused.overridesRev + 1, pending: true })
      expect(reset.overrides).toEqual({})
      const again = ok(await deleteDaemonOverrides(adminApi, fake.id), 'deleteNodeDaemonOverrides').daemonConfig!
      expect(again.overridesRev).toBe(reset.overridesRev)
      const afterReset = await nodeEvents(adminApi, fake.id, 'node.daemonOverridesChanged')
      expect(afterReset).toHaveLength(5)
      expect(afterReset[0]).toMatchObject({ data: { by: adminId, cleared: true } })

      // The daemon goes back to its environment.
      expect(await fake.syncOverrides()).toEqual({ rev: reset.overridesRev, values: {} })
      const back = await waitForOverridesApplied(adminApi, fake.id, (config) => config.appliedOverridesRev === reset.overridesRev)
      expect(back.daemonConfig).toMatchObject({ values: { maxWorkers: fake.info.maxWorkers, pidsLimit: fake.config!.env.pidsLimit } })
      expect(back.daemonConfig!.rejected).toEqual({})
      expect(back.daemonConfig!.sources).toMatchObject({ maxWorkers: 'default', pidsLimit: 'default' })
      expect(back.info?.maxWorkers).toBe(fake.info.maxWorkers)
    },
  )

  test(
    'scantor nodes daemon-overrides set and reset change the overrides; set refuses invalid servers before it sends anything',
    { tag: ['@NODE-044'] },
    async ({ adminApi, nodes }) => {
      const fake = await nodes.fake({ daemonConfig: {} })
      await fake.online()
      await reported(adminApi, fake)
      const key = await temporaryApiKey(adminApi, unique('daemon-overrides-cli'))
      try {
        const cli = (args: string[]) => scantor(['nodes', 'daemon-overrides', ...args], { token: key.key, timeoutMs: 60_000 })
        const set = await cli(['set', fake.id, '--max-workers', '3', '--dns-upstreams', '9.9.9.9,[2620:fe::fe]:53'])
        expect(set.exitCode, set.stderr).toBe(0)
        const config = daemonConfigOf(await getNode(adminApi, fake.id))
        expect(config.overrides).toEqual({ maxWorkers: 3, dns: { upstreams: ['9.9.9.9', '[2620:fe::fe]:53'] } })

        // A usage error (exit 2) names the problem; the overrides stay as they are.
        const refused: [string[], string][] = [
          [['--dns-upstreams', '10.0.0.2'], 'private and special-purpose servers can only be configured in the node environment (SCANTOR_NODE_DNS_*)'],
          [['--dns-root-servers', '172.17.0.1:53'], 'private and special-purpose servers can only be configured in the node environment (SCANTOR_NODE_DNS_*)'],
          [['--dns-upstreams', '::1'], 'private and special-purpose servers can only be configured in the node environment (SCANTOR_NODE_DNS_*)'],
          [['--dns-upstreams', '0.0.0.0'], 'is not a unicast address'],
          [['--dns-root-servers', 'fe80::1'], 'IPv6 link-local addresses are not supported'],
          [['--dns-upstreams', 'fe80::1%eth0'], 'zoned addresses are not supported'],
        ]
        for (const [flags, message] of refused) {
          const result = await cli(['set', fake.id, ...flags])
          expect(result.exitCode, `${flags.join(' ')}: ${result.stderr}`).toBe(2)
          expect(result.stderr, flags.join(' ')).toContain(message)
        }
        expect(daemonConfigOf(await getNode(adminApi, fake.id))).toMatchObject({ overridesRev: config.overridesRev, overrides: config.overrides })

        const reset = await cli(['reset', fake.id])
        expect(reset.exitCode, reset.stderr).toBe(0)
        expect(daemonConfigOf(await getNode(adminApi, fake.id)).overrides).toEqual({})
      } finally {
        await key.dispose()
      }
    },
  )

  test('the hello of another daemon instance ends the overrides of the previous one', { tag: ['@NODE-044'] }, async ({ adminApi, nodes }) => {
    const fake = await nodes.fake({ daemonConfig: {} })
    await fake.online()
    await reported(adminApi, fake)
    ok(await patchDaemonOverrides(adminApi, fake.id, { workerLogMaxFiles: 5 }), 'updateNodeDaemonOverrides')
    await fake.syncOverrides()
    await waitForOverridesApplied(adminApi, fake.id, (config) => config.values.workerLogMaxFiles === 5)

    // The same instance saying hello again keeps them.
    ok(await fake.daemon.hello(fake.reportedInfo, [], fake.daemonReport()), 'nodeHello')
    expect(daemonConfigOf(await getNode(adminApi, fake.id)).overrides).toEqual({ workerLogMaxFiles: 5 })
    expect(await nodeEvents(adminApi, fake.id, 'node.daemonOverridesCleared')).toEqual([])

    // A restarted daemon is a new instance: its hello ends them, and the assignments carry none.
    await fake.restartDaemon()
    const node = await getNode(adminApi, fake.id)
    expect(daemonConfigOf(node).overrides).toEqual({})
    expect(daemonConfigOf(node).values.workerLogMaxFiles).toBe(fake.config!.env.workerLogMaxFiles)
    const cleared = await nodeEvents(adminApi, fake.id, 'node.daemonOverridesCleared')
    expect(cleared).toHaveLength(1)
    expect(cleared[0]).toMatchObject({ nodeId: fake.id })
    expect((await fake.syncOverrides()).values).toEqual({})
  })

  test(
    'overrides need a daemon instance that reported its configuration and allows the keys, and valid values',
    { tag: ['@NODE-044'] },
    async ({ adminApi, api, nodes }) => {
      // An unjoined node has no daemon instance.
      const pending = ok(await nodes.create({ name: unique('overrides-pending'), pool: unique('pool') }), 'createNode')
      expectUnavailable(await patchDaemonOverrides(adminApi, pending.node.id, { maxWorkers: 2 }), 'noInstance')

      // A daemon older than daemon overrides reports no configuration. The reset needs none: it is idempotent.
      const old = await nodes.fake()
      await old.online()
      const notReported = await patchDaemonOverrides(adminApi, old.id, { maxWorkers: 2 })
      expectUnavailable(notReported, 'notReported')
      expect(notReported.body).toMatchObject({
        error: { message: `node ${old.name} has not reported a valid daemon configuration (an old daemon or an invalid report; see the orchestrator log)` },
      })
      expect(ok(await deleteDaemonOverrides(adminApi, old.id), 'deleteNodeDaemonOverrides').daemonConfig ?? null).toBeNull()

      // A daemon whose SCANTOR_NODE_OVERRIDES allows only some keys.
      const restricted = await nodes.fake({ daemonConfig: { values: { overrides: ['maxWorkers', 'dns.mode'] }, fromEnv: ['overrides'] } })
      await restricted.online()
      await reported(adminApi, restricted)
      const details = expectUnavailable(
        await patchDaemonOverrides(adminApi, restricted.id, { maxWorkers: 2, pidsLimit: 100, dns: { upstreams: ['9.9.9.9'] } }),
        'notAllowed',
      )
      expect(details.keys).toEqual(expect.arrayContaining(['pidsLimit', 'dns.upstreams']))
      expect(details.keys).not.toContain('maxWorkers')
      expect(daemonConfigOf(await getNode(adminApi, restricted.id)).overrides).toEqual({})
      const allowed = ok(await patchDaemonOverrides(adminApi, restricted.id, { maxWorkers: 2, dns: { mode: 'disabled' } }), 'updateNodeDaemonOverrides')
      expect(allowed.daemonConfig!.overrides).toEqual({ maxWorkers: 2, dns: { mode: 'disabled' } })

      // Invalid bodies: 400 validationFailed, nothing stored.
      const invalid: unknown[] = [
        {},
        { maxWorkers: 0 },
        { maxWorkers: 100_001 },
        { maxWorkers: 1.5 },
        { logLevel: 'trace' },
        { shmSizeBytes: 1024 },
        { dns: { mode: 'forwarding' } },
        { dns: { upstreams: [] } },
        { dns: { upstreams: ['not-an-address'] } },
        { dns: { upstreams: Array.from({ length: 17 }, (_, i) => `192.0.2.${i + 1}`) } },
        { dns: { rootServers: ['host'] } },
        { dns: { localDomains: ['not a domain'] } },
        { dns: { cacheSizeBytes: 1024 } },
        { dns: { color: 'blue' } },
        { url: 'https://elsewhere.example' },
        { egressDeny: [] },
        { unknownKey: 1 },
      ]
      for (const body of invalid) {
        const response = await patchDaemonOverrides(adminApi, restricted.id, body)
        expect(response.status, JSON.stringify(body)).toBe(400)
        expect(response.body, JSON.stringify(body)).toMatchObject({ error: { code: 'validationFailed' } })
      }

      // DNS servers: unicast addresses without zone, and none in a private or special-purpose range (loopback, RFC 1918,
      // link-local, CGNAT, …), which only the node environment may name (SCANTOR_NODE_DNS_*): the node resolver trusts
      // only the environment's servers there. The stack's own upstream (172.17.0.1) is no exception.
      const notUnicast = 'must be a unicast address (not unspecified or multicast)'
      const servers: [unknown, string, string][] = [
        [{ dns: { upstreams: ['10.0.0.2'] } }, 'dns.upstreams.0', ENVIRONMENT_ONLY_SERVER],
        [{ dns: { upstreams: ['9.9.9.9', '127.0.0.1:5353'] } }, 'dns.upstreams.1', ENVIRONMENT_ONLY_SERVER],
        [{ dns: { upstreams: ['172.17.0.1'] } }, 'dns.upstreams.0', ENVIRONMENT_ONLY_SERVER],
        [{ dns: { upstreams: ['100.100.100.100'] } }, 'dns.upstreams.0', ENVIRONMENT_ONLY_SERVER],
        [{ dns: { upstreams: ['169.254.169.254'] } }, 'dns.upstreams.0', ENVIRONMENT_ONLY_SERVER],
        [{ dns: { upstreams: ['::1'] } }, 'dns.upstreams.0', ENVIRONMENT_ONLY_SERVER],
        [{ dns: { upstreams: ['::ffff:10.0.0.1'] } }, 'dns.upstreams.0', ENVIRONMENT_ONLY_SERVER],
        [{ dns: { rootServers: ['192.168.1.53'] } }, 'dns.rootServers.0', ENVIRONMENT_ONLY_SERVER],
        [{ dns: { rootServers: ['198.41.0.4', '[fd00::53]:53'] } }, 'dns.rootServers.1', ENVIRONMENT_ONLY_SERVER],
        [{ dns: { upstreams: ['0.0.0.0'] } }, 'dns.upstreams.0', notUnicast],
        [{ dns: { upstreams: ['224.0.0.1'] } }, 'dns.upstreams.0', notUnicast],
        [{ dns: { rootServers: ['[::]:53'] } }, 'dns.rootServers.0', notUnicast],
        [{ dns: { upstreams: ['fe80::1'] } }, 'dns.upstreams.0', 'IPv6 link-local addresses are not supported'],
        [{ dns: { upstreams: ['fe80::1%eth0'] } }, 'dns.upstreams.0', 'zoned addresses are not supported'],
        [{ dns: { upstreams: ['1.2.3.4:'] } }, 'dns.upstreams.0', 'must be an IP address, ip:port, [v6]:port or host'],
        [{ dns: { rootServers: ['1.2.3.4::53'] } }, 'dns.rootServers.0', 'must be an IP address, ip:port or [v6]:port'],
      ]
      for (const [body, path, message] of servers) {
        const response = await patchDaemonOverrides(adminApi, restricted.id, body)
        expect(response.status, JSON.stringify(body)).toBe(400)
        const error = (response.body as unknown as { error: { code: string; details: { issues: { path: string; message: string }[] } } }).error
        expect(error.code, JSON.stringify(body)).toBe('validationFailed')
        expect(error.details.issues, JSON.stringify(body)).toContainEqual({ path, message })
      }
      expect(daemonConfigOf(await getNode(adminApi, restricted.id)).overrides).toEqual({ maxWorkers: 2, dns: { mode: 'disabled' } })
      // Public servers next to those ranges are valid: this daemon only does not allow the key.
      expectUnavailable(
        await patchDaemonOverrides(adminApi, restricted.id, { dns: { upstreams: ['172.32.0.1', '100.128.0.1:53', '192.0.2.53'] } }),
        'notAllowed',
      )

      // Changing the node record or revoking its token answers the node without its daemon configuration.
      const updated = ok(await adminApi.call<Node>('updateNode', { path: { nodeId: restricted.id }, body: { labels: { zone: 'x' } } }), 'updateNode')
      expect(updated).not.toHaveProperty('daemonConfig')

      // A revoked node has no daemon instance any more.
      const revoked = ok(await adminApi.call<Node>('revokeNodeToken', { path: { nodeId: restricted.id } }), 'revokeNodeToken')
      expect(revoked).not.toHaveProperty('daemonConfig')
      expectUnavailable(await patchDaemonOverrides(adminApi, restricted.id, { maxWorkers: 3 }), 'noInstance')

      // Unknown nodes are 404, users get 403.
      const unknown = '00000000-0000-4000-8000-000000000000'
      expect((await patchDaemonOverrides(adminApi, unknown, { maxWorkers: 2 })).status).toBe(404)
      expect((await deleteDaemonOverrides(adminApi, unknown)).status).toBe(404)
      for (const response of [await patchDaemonOverrides(api, old.id, { maxWorkers: 2 }), await deleteDaemonOverrides(api, old.id)]) {
        expect(response.status).toBe(403)
        expect(response.body).toMatchObject({ error: { code: 'adminRequired' } })
      }
    },
  )
})
