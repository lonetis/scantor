import type { Node } from '#shared/types/nodes'
import { ok } from '../helpers/api-client'
import {
  BUILTIN_ENGINE,
  BUILTIN_NETWORK,
  networkAddresses,
  PROBE_NAME,
  probeAnswer,
  REMOTE_ENGINE,
  RESOLVER_HEALTHCHECK,
  resolverOf,
  servingResolver,
  ThrowawayNode,
  waitForHealthyOn,
  withDnsClient,
  WORKER_NETWORK,
  type Engine,
  type ResolverInspect,
} from '../helpers/node-resolver'
import { captureContainers, pollFor } from '../helpers/security'
import { expect, test } from '../fixtures'

// The node resolver as a container scantor creates (docs/nodes.md §6.11, docs/security.md T23): its spec on a node of
// its own whose daemon runs in a private Docker engine (helpers/node-resolver.ts ThrowawayNode), and its client ACL on
// the shared nodes, which the tests only read.

const MiB = 1024 * 1024
/** The log driver of one-shot containers (internal/container OneShotLogConfig): readable whatever the engine's default. */
const ONE_SHOT_LOG_CONFIG = { Type: 'local', Config: { 'max-size': '1m', 'max-file': '1', compress: 'false' } }
const MANAGED = { 'traefik.enable': 'false', 'com.docker.compose.project': 'scantor-managed', 'com.docker.compose.service': '', 'scantor.managed': 'true' }

/** Name → value of a container's Env list. */
const envMap = (env: string[] | null) =>
  Object.fromEntries((env ?? []).map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]))

/** Docker reports capabilities with or without the CAP_ prefix, depending on the engine version. */
const capabilities = (caps: string[] | null | undefined) => (caps ?? []).map((cap) => cap.replace(/^CAP_/, '')).sort()

/** A Go byte size (GOMEMLIMIT): a number of bytes with an optional binary unit. */
function goBytes(value: string | undefined): number {
  const match = /^(\d+)(B|KiB|MiB|GiB)?$/.exec(value ?? '')
  if (!match) throw new Error(`not a Go byte size: ${value}`)
  return Number(match[1]) * { B: 1, KiB: 1024, MiB, GiB: 1024 * MiB }[(match[2] ?? 'B') as 'B' | 'KiB' | 'MiB' | 'GiB']
}

/** The local addresses of the listening sockets of port 53 in a network namespace (busybox netstat). */
function port53Listeners(netstat: string): string[] {
  return netstat
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => /^(udp|tcp)6?$/.test(fields[0] ?? '') && /:53$/.test(fields[3] ?? ''))
    .map((fields) => `${fields[0]} ${fields[3]}`)
}

test.describe('the node resolver container', () => {
  test(
    'every node runs one hardened node resolver on the host network that binds only its gateway, and probes it with a one-shot container',
    { tag: ['@NODE-036', '@SEC-007', '@OPS-008'] },
    async ({ adminApi }) => {
      test.setTimeout(420_000)
      const node = await ThrowawayNode.start(adminApi, { prefix: 'resolver-spec', daemon: false })
      try {
        // The probes run while the resolver turns ready: capture them at their create event.
        const probes = await captureContainers(
          { 'scantor.kind': 'resolverProbe' },
          async () => {
            await node.startDaemon()
            await node.waitFor('a ready node resolver', (n) => n.info?.resolver?.state === 'ready', 180_000)
          },
          { engine: node.engine },
        )
        const report = resolverOf(await node.getNode())
        const { gateway, subnet } = await node.workerNetwork()
        expect(report).toMatchObject({ mode: 'recursive', state: 'ready', address: gateway, kept: false, error: null, upstreamOk: true })

        // One resolver per node, named after its spec hash.
        const resolver = await servingResolver(node.engine, node.id, report.spec)
        const spec = resolver.Config.Labels['scantor.spec-hash']!
        expect(spec).toMatch(/^sha256:[0-9a-f]{64}$/)
        expect(resolver.Name).toBe(`/scantor-dns-${node.id}-${spec.slice('sha256:'.length, 'sha256:'.length + 12)}`)
        expect(resolver.Config.Labels).toMatchObject({ ...MANAGED, 'scantor.kind': 'resolver', 'scantor.node': node.id, 'scantor.spec-hash': spec })

        // The daemon's own image, the resolver command and its configuration.
        const daemon = JSON.parse((await node.docker(['inspect', 'scantor-node'])).stdout)[0] as { Image: string }
        expect(resolver.Image).toBe(daemon.Image)
        expect(resolver.Config.Entrypoint).toEqual(['/usr/local/bin/scantor'])
        const cmd = resolver.Config.Cmd ?? []
        expect(cmd.slice(0, 6)).toEqual(['node', 'resolver', 'serve', '--spec-hash', spec, '--config'])
        expect(cmd).toHaveLength(7)
        const config = JSON.parse(cmd[6]!) as Record<string, unknown>
        expect(config).toMatchObject({
          nodeId: node.id,
          listen: `${gateway}:53`,
          mode: 'recursive',
          upstreams: ['172.17.0.1:53'],
          useHostNameservers: false,
          rootServers: [],
          maxLookups: 100,
          cacheBytes: 256 * MiB,
        })
        // The servers of the daemon's environment are trusted for their route, whatever their address (172.17.0.1 is
        // private): every environment upstream and root server, and nothing else.
        expect(config.trustedServers).toEqual(['172.17.0.1:53'])
        expect(config.clients).toEqual(expect.arrayContaining([subnet]))
        expect(config.denyServers).toEqual(expect.arrayContaining(['169.254.0.0/16']))
        expect(config.localNames).toEqual(expect.arrayContaining(['scantor.localhost', 'fixtures.scantor.localhost']))
        expect(resolver.Config.User).toBe('0:0')
        const env = envMap(resolver.Config.Env)
        expect(Number(env.GOMAXPROCS)).toBeGreaterThanOrEqual(1)
        expect(Number(env.GOMAXPROCS)).toBeLessThanOrEqual(16)
        expect(resolver.Config.StopTimeout).toBe(10)

        // The hardening of docs/nodes.md §6.11.
        const host = resolver.HostConfig
        expect(host.NetworkMode).toBe('host')
        expect(host.UsernsMode ?? '').toBe('')
        expect(host.CapDrop).toEqual(['ALL'])
        expect(capabilities(host.CapAdd)).toEqual(['NET_BIND_SERVICE'])
        expect(host.SecurityOpt).toContain('no-new-privileges:true')
        expect(host.Privileged).toBe(false)
        expect(host.ReadonlyRootfs).toBe(true)
        expect(host.Tmpfs).toEqual({ '/run': 'size=1m' })
        expect(host.PidsLimit).toBe(1024)
        expect(host.Memory).toBe(2 * 256 * MiB + 768 * MiB)
        expect(host.MemorySwap).toBe(host.Memory)
        expect(goBytes(env.GOMEMLIMIT)).toBeGreaterThanOrEqual(host.Memory * 0.79)
        expect(goBytes(env.GOMEMLIMIT)).toBeLessThanOrEqual(host.Memory * 0.81)
        expect(host.Ulimits).toEqual([{ Name: 'nofile', Soft: 65536, Hard: 65536 }])
        expect(host.RestartPolicy.Name).toBe('no')
        expect(host.LogConfig).toEqual({ Type: 'local', Config: { 'max-size': '10m', 'max-file': '3' } })
        expect(host.Init ?? false).toBe(false)
        expect(host.Binds ?? []).toEqual([])
        expect(host.Mounts ?? []).toEqual([])
        expect(resolver.Mounts).toEqual([])
        expect(Object.keys(host.PortBindings ?? {})).toEqual([])

        // OPS-008: its own healthcheck, which prints the resolver's stats.
        expect(resolver.Config.Healthcheck).toEqual(RESOLVER_HEALTHCHECK)
        const stats = JSON.parse(await waitForHealthyOn(node.engine, resolver.Id)) as Record<string, unknown>
        expect(stats).toMatchObject({ v: 1, ready: true, node: node.id, spec, mode: 'recursive', listen: `${gateway}:53`, upstreamOk: true })
        expect(stats).toEqual(
          expect.objectContaining({
            hostNameservers: expect.any(Array),
            queries: expect.any(Number),
            overloaded: expect.any(Number),
            queryBudgetExceeded: expect.any(Number),
            tcpRejected: expect.any(Number),
            cacheBytes: expect.any(Number),
          }),
        )
        // Its own address is never one of its host nameservers.
        expect(stats.hostNameservers).not.toContain(gateway)

        // Port 53 only on the gateway of the worker network, over UDP and TCP, never on a wildcard address.
        await withDnsClient(node.engine, 'host', {}, async (client) => {
          const netstat = await client.exec(['netstat', '-lnut'])
          expect(netstat.exitCode, netstat.stderr).toBe(0)
          const listeners = port53Listeners(netstat.stdout)
          expect([...new Set(listeners)].sort(), netstat.stdout).toEqual([`tcp ${gateway}:53`, `udp ${gateway}:53`])
        })

        // The one-shot probe: unprivileged on the worker network, with the resolver as its DNS server, logging with the
        // local driver whatever the engine's default (its result is read from its log), and gone after it ran.
        expect(probes.length, 'the resolver was probed').toBeGreaterThan(0)
        for (const probe of probes as unknown as ResolverInspect[]) {
          expect(probe.Name).toBe(`/scantor-dnsprobe-${node.id}`)
          expect(probe.Config.Labels).toMatchObject({ ...MANAGED, 'scantor.kind': 'resolverProbe', 'scantor.node': node.id })
          expect(probe.Image).toBe(daemon.Image)
          expect(probe.Config.Entrypoint).toEqual(['/usr/local/bin/scantor'])
          expect(probe.Config.Cmd).toEqual(['node', 'resolver', 'probe'])
          expect(probe.Config.User).toBe('65534:65534')
          expect(envMap(probe.Config.Env).GOMAXPROCS).toBe('2')
          expect(probe.Config.Healthcheck).toEqual({ Test: ['NONE'] })
          expect(probe.HostConfig.NetworkMode).toBe(WORKER_NETWORK)
          expect(probe.HostConfig.Dns).toEqual([gateway])
          expect(probe.HostConfig.CapDrop).toEqual(['ALL'])
          expect(capabilities(probe.HostConfig.CapAdd)).toEqual([])
          expect(probe.HostConfig.SecurityOpt).toContain('no-new-privileges:true')
          expect(probe.HostConfig.ReadonlyRootfs).toBe(true)
          expect(probe.HostConfig.PidsLimit).toBe(128)
          expect(probe.HostConfig.Memory).toBe(64 * MiB)
          expect(probe.HostConfig.RestartPolicy.Name).toBe('no')
          expect(probe.HostConfig.LogConfig).toEqual(ONE_SHOT_LOG_CONFIG)
          await expect.poll(async () => (await node.docker(['inspect', probe.Id], { allowFailure: true })).exitCode, { timeout: 60_000 }).not.toBe(0)
        }

        // Still one resolver: the probe is no second one.
        expect((await node.resolverContainers()).map((c) => c.Id)).toEqual([resolver.Id])
      } finally {
        await node.dispose()
      }
    },
  )
})

test.describe('the node resolver’s clients', () => {
  test('a node resolver answers its worker network and refuses queries from any other network of its host', { tag: ['@NODE-042'] }, async ({ adminApi }) => {
    test.setTimeout(240_000)
    const nodes = ok(await adminApi.listNodes(), 'listNodes').items
    const builtin = nodes.find((node) => node.builtIn)!
    const remote = nodes.find((node) => node.name === 'remote-1')!
    // The built-in node's other network is the stack's own; remote-1's the default bridge of its Docker host.
    const cases: [Node, Engine, string, string][] = [
      [builtin, BUILTIN_ENGINE, BUILTIN_NETWORK, 'scantor'],
      [remote, REMOTE_ENGINE, WORKER_NETWORK, 'bridge'],
    ]
    await Promise.all(
      cases.map(async ([node, engine, network, other]) => {
        const report = resolverOf(node)
        const { gateway } = await networkAddresses(engine, network)
        expect(report.address, node.name).toBe(gateway)

        // From the worker network: answered, through Docker's embedded DNS like a worker and asked directly.
        await withDnsClient(engine, network, { dns: gateway }, async (client) => {
          const embedded = await client.lookup(PROBE_NAME, 'txt')
          expect(probeAnswer(embedded), `${node.name}: ${embedded.output}`).toEqual({ node: node.id, spec: report.spec })
          const direct = await client.lookup(PROBE_NAME, 'txt', gateway)
          expect(probeAnswer(direct)?.node, `${node.name}: ${direct.output}`).toBe(node.id)
        })

        // From another network of the same host, to the same address: REFUSED, without an answer.
        await withDnsClient(engine, other, {}, async (client) => {
          const refused = await pollFor(
            async () => {
              const lookup = await client.lookup(PROBE_NAME, 'txt', gateway)
              return lookup.error === 'TIMEOUT' ? undefined : lookup
            },
            60_000,
            () => `${node.name}: the resolver at ${gateway} never answered a client on ${other}`,
            1000,
          )
          expect(refused.error, `${node.name}: ${refused.output}`).toBe('REFUSED')
          expect(refused.texts).toEqual([])
        })
      }),
    )
  })
})
