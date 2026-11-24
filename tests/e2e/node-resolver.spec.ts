import type { Node } from '#shared/types/nodes'
import type { Worker } from '#shared/types/workers'
import { ok } from '../helpers/api-client'
import { allAnalyses, pollUntil, scanWorkers } from '../helpers/e2e-runtime'
import { extendRuntime } from '../helpers/e2e-runtime-fixtures'
import { inPool } from '../helpers/e2e-runtime-nodes'
import { FIXTURES_DNS_SERVER, fixturesDnsQueries } from '../helpers/fixtures-server'
import {
  BUILTIN_ENGINE,
  BUILTIN_NETWORK,
  daemonConfigOf,
  engineDocker,
  networkAddresses,
  patchDaemonOverrides,
  PROBE_NAME,
  probeAnswer,
  REMOTE_ENGINE,
  resolverOf,
  servingResolver,
  waitForNode,
  waitForOverridesApplied,
  waitForResolverReady,
  withDnsClient,
  withThrowawayNode,
  WORKER_NETWORK,
  type Engine,
} from '../helpers/node-resolver'
import { SMALL_SETTINGS } from '../helpers/scans'
import { waitForRunningWorker } from '../helpers/security'
import { expect, test as base } from '../fixtures'

// The node resolver and daemon overrides end to end (docs/nodes.md §6.11, §6.12): how workers of the shared nodes
// resolve (read only, docs/testing.md §9 rule 4), and on nodes of their own whose daemons run in private Docker engines
// (helpers/node-resolver.ts ThrowawayNode): the blue/green replacement after a dns override, iterative resolution from
// the fixtures server's root zone, and overrides of a real daemon. Specs never count the queries that reached an
// upstream server (retries and the overlap of a replacement make them vary) and wait for a new resolver's spec hash and
// the old one's removal after an override.

const test = extendRuntime(base)

test.describe.configure({ timeout: 600_000 })

/** The master's hosts resolve through the host nameservers of every node: the runner's dnsmasq answers 172.17.0.1. */
const FIXTURES_HOST = 'fixtures.scantor.localhost'
const DOCKER0 = '172.17.0.1'

interface NetprobeResult {
  addresses: Record<string, string[]>
  texts: Record<string, string[]>
  errors: Record<string, string>
}

/** HostConfig.Dns of a container of an engine. */
async function containerDns(engine: Engine, container: string): Promise<string[] | null> {
  return JSON.parse((await engineDocker(engine, ['inspect', '--format', '{{json .HostConfig.Dns}}', container])).stdout) as string[] | null
}

test.describe('the shared nodes', () => {
  test('workers on the built-in node and on remote-1 resolve through their node resolver', { tag: ['@NODE-037'] }, async ({ api, adminApi, shared, scans }) => {
    const { revision } = await shared.fixture('netprobe')
    const nodes = ok(await adminApi.listNodes(), 'listNodes').items
    const builtin = nodes.find((node) => node.builtIn)!
    const remote = nodes.find((node) => node.name === 'remote-1')!
    const cases: [Node, Engine, string, Record<string, unknown>][] = [
      [builtin, BUILTIN_ENGINE, BUILTIN_NETWORK, { nodeSelector: { pool: builtin.pool, labels: {} } }],
      [remote, REMOTE_ENGINE, WORKER_NETWORK, { nodeSelector: { pool: 'remote', labels: {} } }],
    ]
    await Promise.all(
      cases.map(async ([node, engine, network, selector]) => {
        const report = resolverOf(node)
        const { gateway } = await networkAddresses(engine, network)
        expect(report, node.name).toMatchObject({ mode: 'recursive', state: 'ready', address: gateway, error: null, upstreamOk: true })
        expect(report.stats, node.name).toEqual(expect.objectContaining({ queries: expect.any(Number), qps: expect.any(Number) }))
        const resolver = await servingResolver(engine, node.id, report.spec)

        // netprobe holds its analysis, so the running worker's container can be read.
        const scan = await scans.start({
          revision: revision.ref,
          taskConfig: { mode: 'resolve', names: [FIXTURES_HOST], txt: [PROBE_NAME], hold_seconds: 30 },
          settings: { ...SMALL_SETTINGS, ...selector },
        })
        const worker = await waitForRunningWorker(api, scan.id, 'runner', 240_000)
        expect(worker.nodeId, node.name).toBe(node.id)
        expect(await containerDns(engine, `scantor-w-${worker.id}`), node.name).toEqual([gateway])

        await scans.wait(scan.id, { timeoutMs: 240_000 })
        const [analysis] = await allAnalyses(api, scan.id)
        expect(analysis?.status, JSON.stringify(analysis)).toBe('succeeded')
        const result = analysis!.result as unknown as NetprobeResult
        expect(result.errors, node.name).toEqual({})
        expect(result.addresses[FIXTURES_HOST], node.name).toEqual([DOCKER0])
        expect(result.texts[PROBE_NAME], node.name).toEqual([`scantor-resolver node=${node.id} spec=${resolver.Config.Labels['scantor.spec-hash']}`])
      }),
    )
  })
})

test.describe('a node of its own', () => {
  test(
    'a dns override replaces the node resolver blue/green while lookups through the worker network keep being answered',
    { tag: ['@NODE-039'] },
    async ({ adminApi }) => {
      await withThrowawayNode(adminApi, { prefix: 'resolver-swap' }, async (node) => {
        const before = resolverOf(await waitForResolverReady(adminApi, node.id))
        const old = await servingResolver(node.engine, node.id, before.spec)
        const { gateway } = await node.workerNetwork()

        await withDnsClient(node.engine, WORKER_NETWORK, { dns: gateway }, async (client) => {
          expect(probeAnswer(await client.lookup(PROBE_NAME, 'txt'))?.spec).toBe(before.spec)
          const loop = client.startLoop(FIXTURES_HOST, DOCKER0)
          let stopped = false
          try {
            await pollUntil(
              'lookups answered by the first resolver',
              async () => loop.lines(),
              (lines) => lines.length >= 10,
            )

            // A new cache size is a new resolver spec: the daemon starts the new resolver next to the old one.
            const cacheSizeBytes = 32 * 1024 * 1024
            ok(await patchDaemonOverrides(adminApi, node.id, { dns: { cacheSizeBytes } }), 'updateNodeDaemonOverrides')
            const applied = await waitForOverridesApplied(adminApi, node.id, (config) => config.values.dns.cacheSizeBytes === cacheSizeBytes)
            expect(daemonConfigOf(applied).sources.dns?.cacheSizeBytes).toBe('override')
            const after = resolverOf(await waitForResolverReady(adminApi, node.id, { notSpec: before.spec }))
            const current = await servingResolver(node.engine, node.id, after.spec)
            expect(current.Id).not.toBe(old.Id)
            expect(current.Name).toBe(`/scantor-dns-${node.id}-${after.spec!.slice('sha256:'.length, 'sha256:'.length + 12)}`)

            const served = loop.lines().length
            await pollUntil(
              'lookups answered after the replacement',
              async () => loop.lines(),
              (lines) => lines.length >= served + 10,
            )
            const lines = await loop.stop()
            stopped = true
            const failures = lines.filter((line) => line.startsWith('fail '))
            expect(failures, 'lookups that failed during the replacement').toEqual([])
            const specs = lines.map((line) => line.split(' ')[2])
            expect(specs[0]).toBe(before.spec)
            expect(specs).toContain(after.spec)
            expect(specs.slice(-5)).toEqual(Array(5).fill(after.spec))
          } finally {
            if (!stopped) await loop.stop().catch(() => undefined)
          }
        })
      })
    },
  )

  test('in iterative mode the node resolver resolves from its root server', { tag: ['@NODE-041'] }, async ({ adminApi }) => {
    const since = new Date(Date.now() - 1000)
    const env = { SCANTOR_NODE_DNS_MODE: 'iterative', SCANTOR_NODE_DNS_ROOT_SERVERS: FIXTURES_DNS_SERVER }
    await withThrowawayNode(adminApi, { prefix: 'resolver-iterative', env }, async (node) => {
      const ready = await waitForResolverReady(adminApi, node.id)
      const report = resolverOf(ready)
      expect(report).toMatchObject({ mode: 'iterative', state: 'ready', upstreamOk: true })
      const config = daemonConfigOf(ready)
      expect(config.values.dns).toMatchObject({ mode: 'iterative', rootServers: [FIXTURES_DNS_SERVER] })
      expect(config.sources.dns).toMatchObject({ mode: 'env', rootServers: 'env' })
      const { gateway } = await node.workerNetwork()

      await withDnsClient(node.engine, WORKER_NETWORK, { dns: gateway }, async (client) => {
        const address = await client.lookup('a.scantor.test')
        expect(address, address.output).toMatchObject({ error: null, addresses: ['192.0.2.10'] })
        const cname = await client.lookup('www.scantor.test')
        expect(cname, cname.output).toMatchObject({ error: null, cnames: [['www.scantor.test', 'a.scantor.test']], addresses: ['192.0.2.10'] })
        const chain = await client.lookup('alias.scantor.test')
        expect(chain, chain.output).toMatchObject({
          error: null,
          cnames: [
            ['alias.scantor.test', 'www.scantor.test'],
            ['www.scantor.test', 'a.scantor.test'],
          ],
          addresses: ['192.0.2.10'],
        })
        const text = await client.lookup('a.scantor.test', 'txt')
        expect(text, text.output).toMatchObject({ error: null, texts: ['scantor fixtures'] })
        const v6 = await client.lookup('v6.scantor.test', 'aaaa')
        expect(v6, v6.output).toMatchObject({ error: null, addresses: ['2001:db8::10'] })
        const nodata = await client.lookup('v6.scantor.test', 'a')
        expect(nodata.error, nodata.output).toBe('NODATA')
        const missing = await client.lookup('missing.scantor.test')
        expect(missing.error, missing.output).toBe('NXDOMAIN')

        // The master's hosts still go to the host nameservers, and the resolver answers its own name.
        const master = await client.lookup(FIXTURES_HOST)
        expect(master.addresses, master.output).toEqual([DOCKER0])
        expect(probeAnswer(await client.lookup(PROBE_NAME, 'txt'))).toEqual({ node: node.id, spec: report.spec })
      })

      // The answers came from the root server: the fixtures DNS server was asked for them.
      const asked = await fixturesDnsQueries(since)
      for (const name of ['a.scantor.test.', 'www.scantor.test.', 'missing.scantor.test.']) {
        expect(
          asked.some((query) => query.name === name),
          `the fixtures DNS server got no query for ${name}`,
        ).toBe(true)
      }
    })
  })

  test(
    'daemon overrides change the running daemon: capacity, the settings of new workers, and a restart ends them',
    { tag: ['@NODE-045'] },
    async ({ api, adminApi, shared, scans }) => {
      const { revision } = await shared.fixture('netprobe')
      await withThrowawayNode(adminApi, { prefix: 'daemon-overrides' }, async (node) => {
        const reported = await node.waitFor('a daemon configuration', (n) => !!n.daemonConfig)
        // The daemon's values from its environment and the capacity it reports with them.
        const env = daemonConfigOf(reported).values
        const envMaxWorkers = reported.info!.maxWorkers

        // Above the daemon's own setting.
        const maxWorkers = envMaxWorkers + 2
        const patched = ok(await patchDaemonOverrides(adminApi, node.id, { maxWorkers, pidsLimit: 2048, nofile: 32768 }), 'updateNodeDaemonOverrides')
        expect(patched.daemonConfig).toMatchObject({ pending: true, overrides: { maxWorkers, pidsLimit: 2048, nofile: 32768 } })
        const applied = await waitForOverridesApplied(adminApi, node.id, (config) => config.values.maxWorkers === maxWorkers)
        expect(applied.info?.maxWorkers).toBe(maxWorkers)
        expect(daemonConfigOf(applied)).toMatchObject({
          values: { maxWorkers, pidsLimit: 2048, nofile: 32768 },
          sources: { maxWorkers: 'override', pidsLimit: 'override', nofile: 'override' },
        })

        // A worker created now gets the overridden settings, and the node resolver as its DNS server.
        await waitForResolverReady(adminApi, node.id)
        const { gateway } = await node.workerNetwork()
        const scan = await scans.start({
          revision: revision.ref,
          taskConfig: { mode: 'resolve', names: [FIXTURES_HOST], txt: [PROBE_NAME], hold_seconds: 30 },
          settings: inPool(node.pool),
        })
        const worker = await waitForRunningWorker(api, scan.id, 'runner', 360_000)
        const inspect = JSON.parse((await node.docker(['inspect', `scantor-w-${worker.id}`])).stdout)[0] as {
          HostConfig: { PidsLimit: number; Ulimits: { Name: string; Soft: number; Hard: number }[]; Dns: string[] | null }
        }
        expect(inspect.HostConfig.PidsLimit).toBe(2048)
        expect(inspect.HostConfig.Ulimits).toEqual([{ Name: 'nofile', Soft: 32768, Hard: 32768 }])
        expect(inspect.HostConfig.Dns).toEqual([gateway])
        await scans.wait(scan.id, { timeoutMs: 240_000 })
        const [analysis] = await allAnalyses(api, scan.id)
        expect((analysis?.result as unknown as NetprobeResult | undefined)?.texts[PROBE_NAME]?.[0]).toMatch(
          new RegExp(`^scantor-resolver node=${node.id} spec=sha256:[0-9a-f]{64}$`),
        )

        // A restarted daemon is a new instance: the overrides end and the environment's values are back.
        const restartedAt = Date.now()
        await node.restartDaemon()
        const back = await node.waitFor(
          'the restarted daemon without overrides',
          (n) =>
            n.state === 'online' &&
            n.info?.maxWorkers === envMaxWorkers &&
            !!n.daemonConfig &&
            Object.keys(n.daemonConfig.overrides).length === 0 &&
            n.daemonConfig.values.maxWorkers === env.maxWorkers,
          120_000,
        )
        expect(daemonConfigOf(back)).toMatchObject({ values: { maxWorkers: env.maxWorkers, pidsLimit: env.pidsLimit, nofile: env.nofile }, pending: false })
        expect(daemonConfigOf(back).sources.maxWorkers).not.toBe('override')
        const cleared = ok(
          await adminApi.call<{ items: { type: string; at: string }[] }>('listNodeEvents', {
            path: { nodeId: node.id },
            query: { type: 'node.daemonOverridesCleared' },
          }),
          'listNodeEvents',
        ).items
        expect(cleared.filter((event) => Date.parse(event.at) >= restartedAt)).toHaveLength(1)
      })
    },
  )

  test(
    'a maxWorkers override raises the placement capacity of a node above its daemon’s setting',
    { tag: ['@NODE-045'] },
    async ({ api, adminApi, shared, scans, fakeNodes }) => {
      // A fake daemon that applies overrides like the real one (helpers/fake-daemon.ts): it reports one worker until
      // the override reaches it. A probe copy of its own: workers on a fake node count as pulls of their image.
      const node = await fakeNodes.start({ info: { maxWorkers: 1 }, daemonConfig: {} })
      const { revision } = await shared.generated('probe', 'daemon-overrides')
      const scan = await scans.start({ revision: revision.ref, scanConfig: { times: 3 }, settings: inPool(node.pool, { workers: 3 }) })
      const states = (workers: Worker[]) => workers.map((worker) => worker.state).sort()
      await pollUntil(
        'one worker placed, three pending',
        () => scanWorkers(api, scan.id),
        (workers) => JSON.stringify(states(workers)) === JSON.stringify(['assigned', 'pending', 'pending', 'pending']),
        { timeoutMs: 120_000 },
      )

      await waitForNode(adminApi, node.id, 'a daemon configuration', (n) => !!n.daemonConfig, 30_000)
      ok(await patchDaemonOverrides(adminApi, node.id, { maxWorkers: 4 }), 'updateNodeDaemonOverrides')
      expect(await node.syncOverrides()).toMatchObject({ values: { maxWorkers: 4 } })
      const applied = await waitForOverridesApplied(adminApi, node.id)
      expect(applied.info?.maxWorkers).toBe(4)
      await pollUntil(
        'all four workers placed',
        () => scanWorkers(api, scan.id),
        (workers) => workers.filter((w) => w.state === 'assigned').length === 4,
        {
          timeoutMs: 120_000,
        },
      )
    },
  )
})
