import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Node, NodeDaemonConfig, NodeResolverReport, NodeWithToken } from '#shared/types/nodes'
import { ok, type ApiClient, type ApiResponse } from './api-client'
import { CONTAINERS, docker, stackEnv, type DockerOptions, type ExecResult } from './docker'
import { env } from './env'
import { containerImage, copyImageInto, pollFor, type HealthcheckInspect, type WorkerInspect } from './security'
import { unique } from './unique'

// The node resolver and daemon overrides from outside (docs/nodes.md §6.11, §6.12): the resolver containers of a
// Docker engine, DNS lookups along the workers' path (a container on the worker network whose DNS server is the
// resolver's gateway address, asking Docker's embedded DNS like a worker), a lookup loop for replacements, and
// throwaway nodes whose daemon runs in a private Docker engine, where a test may change what the shared nodes must
// keep (overrides, restarts, other DNS modes; docs/testing.md §9 rule 4).
//
// An engine is the argument prefix that selects a Docker engine: [] for the runner's (the built-in node),
// REMOTE_ENGINE for remote-1's DinD, `-H tcp://…` for a throwaway node's engine.

export type Engine = string[]

/** The Docker engine of the built-in node (the runner's own). */
export const BUILTIN_ENGINE: Engine = []
/** The Docker engine inside remote-1's DinD. */
export const REMOTE_ENGINE: Engine = ['exec', CONTAINERS.remoteNode, 'docker']

/** The worker network of the built-in node and of every other node. */
export const BUILTIN_NETWORK = 'scantor-sandbox'
export const WORKER_NETWORK = 'scantor-workers'

/** The name a node resolver answers itself, with `scantor-resolver node=<nodeId> spec=<specHash>` (docs/nodes.md §6.11). */
export const PROBE_NAME = 'resolver.scantor.invalid'

const SECOND_NS = 1_000_000_000

/** The healthcheck of the node resolver container: its own check of the state file and the upstream servers. */
export const RESOLVER_HEALTHCHECK: HealthcheckInspect = {
  Test: ['CMD', '/usr/local/bin/scantor', 'node', 'resolver', 'healthcheck'],
  Interval: 10 * SECOND_NS,
  Timeout: 5 * SECOND_NS,
  Retries: 3,
  StartPeriod: 30 * SECOND_NS,
  StartInterval: 1 * SECOND_NS,
}

/** `docker <engine…> <args>`. */
export function engineDocker(engine: Engine, args: string[], options: DockerOptions = {}): Promise<ExecResult> {
  return docker([...engine, ...args], options)
}

/**
 * The SCANTOR_NODE_DNS_* settings of tests/docker/stack.env: what the built-in node gets through compose and remote-1
 * through join-remote-node.mjs, so every node daemon of the suite resolves through the runner's dnsmasq.
 */
export function nodeDnsEnv(): Record<string, string> {
  const settings: Record<string, string> = {}
  for (const line of readFileSync(join(env.paths.tests, 'docker', 'stack.env'), 'utf8').split('\n')) {
    const match = /^(SCANTOR_NODE_DNS_[A-Z0-9_]+)=(.*)$/.exec(line)
    if (match) settings[match[1]!] = match[2]!
  }
  return settings
}

/** The test CA as PEM (SCANTOR_CA_CERT of the stack's .env, which the node daemons trust). */
export function testCaPem(): string {
  return (stackEnv().SCANTOR_CA_CERT ?? '').replace(/^"|"$/g, '').replaceAll('\\n', '\n').trim()
}

export async function getNode(adminApi: ApiClient, nodeId: string): Promise<Node> {
  return ok(await adminApi.call<Node>('getNode', { path: { nodeId } }), 'getNode')
}

/** Polls getNode until `accept` holds; throws with the last node's state, resolver and daemon configuration. */
export async function waitForNode(adminApi: ApiClient, nodeId: string, what: string, accept: (node: Node) => boolean, timeoutMs = 120_000): Promise<Node> {
  let last: Node | undefined
  return pollFor(
    async () => {
      last = await getNode(adminApi, nodeId)
      return accept(last) ? last : undefined
    },
    timeoutMs,
    () =>
      `node ${nodeId}: no ${what} within ${timeoutMs / 1000} s; last: ${JSON.stringify({ state: last?.state, resolver: last?.info?.resolver, daemonConfig: last?.daemonConfig, maxWorkers: last?.info?.maxWorkers })}`,
    1000,
  )
}

/** Waits until the node reports its node resolver ready (optionally with a spec other than `notSpec`). */
export function waitForResolverReady(adminApi: ApiClient, nodeId: string, options: { notSpec?: string; timeoutMs?: number } = {}): Promise<Node> {
  return waitForNode(
    adminApi,
    nodeId,
    options.notSpec ? 'ready node resolver with a new spec' : 'ready node resolver',
    (node) => node.info?.resolver?.state === 'ready' && (!options.notSpec || node.info.resolver.spec !== options.notSpec),
    options.timeoutMs ?? 180_000,
  )
}

/** The resolver report of a node that has one (fails the test otherwise). */
export function resolverOf(node: Node): NodeResolverReport {
  const resolver = node.info?.resolver
  if (!resolver) throw new Error(`node ${node.name} reports no node resolver: ${JSON.stringify(node.info)}`)
  return resolver
}

/** The daemon configuration of a node whose daemon reported one (fails the test otherwise). */
export function daemonConfigOf(node: Node): NodeDaemonConfig {
  if (!node.daemonConfig) throw new Error(`node ${node.name} has no daemon configuration: ${JSON.stringify(node.daemonConfig)}`)
  return node.daemonConfig
}

/** updateNodeDaemonOverrides (a JSON merge patch). */
export function patchDaemonOverrides(adminApi: ApiClient, nodeId: string, body: unknown): Promise<ApiResponse<Node>> {
  return adminApi.call<Node>('updateNodeDaemonOverrides', { path: { nodeId }, body })
}

/** deleteNodeDaemonOverrides. */
export function deleteDaemonOverrides(adminApi: ApiClient, nodeId: string): Promise<ApiResponse<Node>> {
  return adminApi.call<Node>('deleteNodeDaemonOverrides', { path: { nodeId } })
}

/** Waits until the node's daemon has applied the current revision of its daemon overrides. */
export function waitForOverridesApplied(adminApi: ApiClient, nodeId: string, accept: (config: NodeDaemonConfig) => boolean = () => true, timeoutMs = 120_000) {
  return waitForNode(
    adminApi,
    nodeId,
    'applied daemon overrides',
    (node) => {
      const config = node.daemonConfig
      return !!config && !config.pending && config.appliedOverridesRev === config.overridesRev && accept(config)
    },
    timeoutMs,
  )
}

// ── containers and networks of an engine ────────────────────────────────────────────────────────────

/** `docker inspect` of a node resolver or its probe container. */
export interface ResolverInspect {
  Id: string
  Name: string
  /** the image id */
  Image: string
  Config: {
    Image: string
    User: string
    Entrypoint: string[] | null
    Cmd: string[] | null
    Env: string[] | null
    Labels: Record<string, string>
    Healthcheck?: HealthcheckInspect | null
    StopTimeout?: number | null
  }
  HostConfig: WorkerInspect['HostConfig'] & { UsernsMode?: string; Dns?: string[] | null; Tmpfs?: Record<string, string> | null }
  Mounts: unknown[]
  State: { Status: string; Running: boolean; StartedAt: string; Health?: { Status: string; Log?: { ExitCode: number; Output: string }[] } }
}

/** The node resolver containers of a node on an engine (running or not), oldest first. */
export async function resolverContainers(engine: Engine, nodeId: string): Promise<ResolverInspect[]> {
  const ids = (await engineDocker(engine, ['ps', '-a', '-q', '--filter', 'label=scantor.kind=resolver', '--filter', `label=scantor.node=${nodeId}`])).stdout
    .split('\n')
    .filter(Boolean)
  const inspected: ResolverInspect[] = []
  for (const id of ids) {
    const result = await engineDocker(engine, ['inspect', id], { allowFailure: true })
    // A replaced resolver can be gone between the listing and its inspection.
    if (result.exitCode === 0) inspected.push((JSON.parse(result.stdout) as ResolverInspect[])[0]!)
  }
  return inspected.sort((a, b) => Date.parse(a.State.StartedAt) - Date.parse(b.State.StartedAt))
}

/** The one running resolver container of a node, once there is exactly one and it serves `spec` (when given). */
export async function servingResolver(engine: Engine, nodeId: string, spec?: string, timeoutMs = 120_000): Promise<ResolverInspect> {
  let last: ResolverInspect[] = []
  return pollFor(
    async () => {
      last = await resolverContainers(engine, nodeId)
      const [only] = last
      return last.length === 1 && only!.State.Running && (!spec || only!.Config.Labels['scantor.spec-hash'] === spec) ? only : undefined
    },
    timeoutMs,
    () =>
      `node ${nodeId} has not exactly one running resolver${spec ? ` with spec ${spec}` : ''}: ${JSON.stringify(last.map((c) => [c.Name, c.State.Status, c.Config.Labels['scantor.spec-hash']]))}`,
  )
}

/**
 * Waits until Docker reports a container of an engine `healthy` and returns the first line of the newest successful
 * probe's output (the resolver prints its stats there); fails on `unhealthy` or when the container stops.
 */
export async function waitForHealthyOn(engine: Engine, container: string, timeoutMs = 90_000): Promise<string> {
  let last: ResolverInspect['State'] | undefined
  return pollFor(
    async () => {
      last = JSON.parse((await engineDocker(engine, ['inspect', '--format', '{{json .State}}', container])).stdout) as ResolverInspect['State']
      if (!last.Running) throw new Error(`${container} stopped before it was healthy: ${JSON.stringify(last)}`)
      if (last.Health?.Status === 'unhealthy') throw new Error(`${container} is unhealthy: ${JSON.stringify(last.Health)}`)
      if (last.Health?.Status !== 'healthy') return undefined
      const passed = (last.Health.Log ?? []).filter((entry) => entry.ExitCode === 0).at(-1)
      return (passed?.Output ?? '').split('\n')[0] ?? ''
    },
    timeoutMs,
    () => `${container} did not turn healthy within ${timeoutMs / 1000} s: ${JSON.stringify(last?.Health)}`,
  )
}

/** The IPv4 gateway and subnet of a network of an engine. */
export async function networkAddresses(engine: Engine, network: string): Promise<{ gateway: string; subnet: string }> {
  const format = '{{range .IPAM.Config}}{{if .Gateway}}{{.Gateway}} {{.Subnet}}{{"\\n"}}{{end}}{{end}}'
  const lines = (await engineDocker(engine, ['network', 'inspect', '--format', format, network])).stdout.split('\n').filter(Boolean)
  const v4 = lines.map((line) => line.trim().split(' ')).find(([gateway]) => /^\d+\.\d+\.\d+\.\d+$/.test(gateway ?? ''))
  if (!v4) throw new Error(`network ${network} has no IPv4 gateway: ${JSON.stringify(lines)}`)
  return { gateway: v4[0]!, subnet: v4[1]! }
}

// ── lookups along the workers' path ─────────────────────────────────────────────────────────────────

/** One busybox `nslookup` (the scantor image is Alpine), parsed. */
export interface Lookup {
  /** the addresses of the answer */
  addresses: string[]
  /** [name, target] of every CNAME of the answer */
  cnames: [string, string][]
  /** the strings of the TXT records of the answer */
  texts: string[]
  /**
   * The response code of a failed lookup (NXDOMAIN, SERVFAIL, REFUSED, …: "server can't find"), NODATA for an empty
   * answer, TIMEOUT when no reply arrived ("No answer", "connection timed out"), PARSE for an unparsable reply; null for
   * an answer with records
   */
  error: string | null
  output: string
}

/**
 * Parses busybox `nslookup` output (networking/nslookup.c): `Name:\t<name>` and `Address: <ip>` per address,
 * `<name>\tcanonical name = <target>`, `<name>\ttext = "<string>"`, `** server can't find <name>: <RCODE>` for a failed
 * lookup, `*** Can't find <name>: No answer` for a question without a reply, and no record at all for NODATA.
 */
export function parseNslookup(output: string): Lookup {
  const all = (pattern: RegExp) => [...output.matchAll(pattern)]
  // The server's own lines read `Address:\t<ip>:53`; the answers `Address: <ip>`.
  const addresses = all(/^Address: (\S+)\s*$/gm).map((m) => m[1]!)
  const cnames = all(/^(\S+)\t+canonical name = (\S+?)\.?\s*$/gm).map((m): [string, string] => [m[1]!, m[2]!])
  const texts = all(/^\S+\t+text = "(.*)"\s*$/gm).map((m) => m[1]!)
  const records = /^Name:\t|^\S+\t+[a-z ]+ = /m.test(output)
  const failure = /\*\* server can't find \S+: (\S+)/.exec(output)
  let error: string | null = null
  if (failure) error = failure[1]!
  else if (/Can't find \S+: No answer|timed out|no servers could be reached/i.test(output)) error = 'TIMEOUT'
  else if (/Can't find \S+: Parse error/.test(output)) error = 'PARSE'
  else if (!records) error = 'NODATA'
  return { addresses, cnames, texts, error, output }
}

/** The node id and spec hash of a resolver's answer to PROBE_NAME. */
export function probeAnswer(lookup: Lookup): { node: string; spec: string } | null {
  for (const text of lookup.texts) {
    const match = /^scantor-resolver node=(\S+) spec=(sha256:[0-9a-f]{64})$/.exec(text)
    if (match) return { node: match[1]!, spec: match[2]! }
  }
  return null
}

/**
 * A long-running test container (label scantor.test=true) on a network of an engine that asks DNS questions with
 * busybox `nslookup` through `docker exec`: with `dns` set to a resolver's gateway address it resolves exactly like a
 * worker (Docker's embedded DNS forwards to it); `lookup(…, server)` asks a server directly.
 */
export class DnsClient {
  private constructor(
    readonly engine: Engine,
    readonly name: string,
  ) {}

  static async start(engine: Engine, network: string, options: { dns?: string; image?: string } = {}): Promise<DnsClient> {
    const image = options.image ?? (await containerImage(CONTAINERS.node))
    const name = unique('scantor-test-dns-client')
    await engineDocker(engine, [
      ...['run', '-d', '--name', name, '--label', 'scantor.test=true', '--network', network],
      ...(options.dns ? ['--dns', options.dns] : []),
      ...['--entrypoint', 'sleep', image, '3600'],
    ])
    return new DnsClient(engine, name)
  }

  /** `docker exec` of a command in the client (never fails on a non-zero exit). */
  exec(command: string[]): Promise<ExecResult> {
    return engineDocker(this.engine, ['exec', this.name, ...command], { allowFailure: true, timeoutMs: 60_000 })
  }

  /** `nslookup -type=<type> <name> [server]`. */
  async lookup(name: string, type = 'a', server?: string): Promise<Lookup> {
    const result = await engineDocker(this.engine, ['exec', this.name, 'nslookup', `-type=${type}`, name, ...(server ? [server] : [])], {
      allowFailure: true,
      timeoutMs: 60_000,
    })
    return parseNslookup(result.stdout + result.stderr)
  }

  /**
   * Starts a loop that asks for PROBE_NAME (TXT, answered by the resolver itself) and for `name` (A, expecting
   * `address`, answered through the resolver's upstream servers) about five times a second. Every round prints one
   * line: `ok <n> <spec>` when both answers arrived (the spec hash of the resolver that answered), `fail <n> <output>`
   * otherwise. `lines()` are the rounds so far; `stop()` ends the loop and returns all of them.
   */
  startLoop(name: string, address: string): { lines: () => string[]; stop: () => Promise<string[]> } {
    const script = [
      'n=0',
      'while [ ! -e /tmp/stop-loop ]; do',
      '  n=$((n + 1))',
      `  txt=$(nslookup -type=txt ${PROBE_NAME} 2>&1)`,
      '  a=$(nslookup -type=a "$1" 2>&1)',
      `  spec=$(printf '%s\\n' "$txt" | sed -n 's/.*scantor-resolver node=[^ ]* spec=\\(sha256:[0-9a-f]*\\).*/\\1/p' | head -n 1)`,
      `  if [ -n "$spec" ] && printf '%s\\n' "$a" | grep -qx "Address: $2"; then echo "ok $n $spec"; else echo "fail $n $(printf '%s %s' "$txt" "$a" | tr '\\n\\t' '  ')"; fi`,
      '  sleep 0.2',
      'done',
      'echo "end $n"',
    ].join('\n')
    const child = spawn('docker', [...this.engine, 'exec', this.name, 'sh', '-c', script, 'sh', name, address], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let errors = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (errors += chunk))
    const exited = new Promise<number | null>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    return {
      lines: () => output.split('\n').filter((line) => line.startsWith('ok ') || line.startsWith('fail ')),
      stop: async () => {
        await engineDocker(this.engine, ['exec', this.name, 'touch', '/tmp/stop-loop'])
        let timer: NodeJS.Timeout | undefined
        const code = await Promise.race([
          exited,
          new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`the lookup loop did not end: ${errors.slice(-2000)}`)), 60_000))),
        ]).finally(() => clearTimeout(timer))
        const lines = output.split('\n').filter(Boolean)
        if (code !== 0 || lines.at(-1)?.startsWith('end ') !== true)
          throw new Error(`the lookup loop exited with ${code}: ${errors.slice(-2000)}\n${output.slice(-2000)}`)
        return lines.slice(0, -1)
      },
    }
  }

  async remove(): Promise<void> {
    await engineDocker(this.engine, ['rm', '-f', this.name], { allowFailure: true })
  }
}

/** Runs `body` with a DnsClient that is removed afterwards. */
export async function withDnsClient<T>(
  engine: Engine,
  network: string,
  options: { dns?: string; image?: string },
  body: (client: DnsClient) => Promise<T>,
): Promise<T> {
  const client = await DnsClient.start(engine, network, options)
  try {
    return await body(client)
  } finally {
    await client.remove()
  }
}

// ── throwaway nodes ─────────────────────────────────────────────────────────────────────────────────

export interface ThrowawayNodeOptions {
  /** prefix of the node's name */
  prefix?: string
  /** daemon environment added to (or replacing) the join variables, the test CA and nodeDnsEnv() */
  env?: Record<string, string>
  /** false: prepare the engine only; the test calls startDaemon() itself */
  daemon?: boolean
}

/**
 * A node of its own, in a pool no other test selects, whose daemon runs inside a private Docker engine: a DinD on the
 * network `scantor` like the remote node, with the stack's DNS (dnsmasq at 172.17.0.1) and the test CA trusted for the
 * registry and its token realm, so the daemon can pull task images and its node resolver and egress helper act on that
 * engine's host network namespace, never on the runner's. The daemon is started with the join command of createNode,
 * the test CA and the node resolver settings of the stack (nodeDnsEnv). `dispose()` removes the engine with
 * everything in it and deletes the node.
 */
export class ThrowawayNode {
  private constructor(
    private readonly adminApi: ApiClient,
    readonly created: NodeWithToken,
    /** the DinD container on the runner's engine */
    readonly dind: string,
    readonly engine: Engine,
    /** the scantor image the daemon runs (copied into the engine) */
    readonly image: string,
    readonly daemonEnv: Record<string, string>,
  ) {}

  static async start(adminApi: ApiClient, options: ThrowawayNodeOptions = {}): Promise<ThrowawayNode> {
    const created = ok(await adminApi.createNode({ name: unique(options.prefix ?? 'throwaway'), pool: unique('isolated') }), 'createNode')
    const dind = unique('scantor-test-node-dind')
    try {
      const registryHost = stackEnv().SCANTOR_REGISTRY_PUBLIC_HOST!
      const trust = [
        'bundle=/etc/ssl/certs/ca-certificates.crt',
        'cat /run/scantor-test/ca.crt >> "$bundle"',
        'mkdir -p "/etc/docker/certs.d/$SCANTOR_REGISTRY_PUBLIC_HOST"',
        'cp /run/scantor-test/ca.crt "/etc/docker/certs.d/$SCANTOR_REGISTRY_PUBLIC_HOST/ca.crt"',
        'exec dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock --host=tcp://0.0.0.0:2375 --tls=false --dns=172.17.0.1 \\',
        '  --bip=10.42.0.1/24 --default-address-pool=base=10.43.0.0/16,size=24',
      ].join('\n')
      await docker([
        ...['run', '-d', '--privileged', '--name', dind, '--label', 'scantor.test=true', '--network', 'scantor'],
        ...['-e', 'DOCKER_TLS_CERTDIR=', '-e', `SCANTOR_REGISTRY_PUBLIC_HOST=${registryHost}`, '-v', `${env.caCertFile}:/run/scantor-test/ca.crt:ro`],
        ...['--entrypoint', 'sh', await containerImage(CONTAINERS.remoteNode), '-euc', trust],
      ])
      const address = (await docker(['inspect', '--format', '{{(index .NetworkSettings.Networks "scantor").IPAddress}}', dind])).stdout.trim()
      const engine = ['-H', `tcp://${address}:2375`]
      await pollFor(
        async () => ((await docker([...engine, 'version'], { allowFailure: true })).exitCode === 0 ? true : undefined),
        90_000,
        async () => `the private Docker engine ${dind} did not start: ${(await docker(['logs', '--tail', '50', dind], { allowFailure: true })).stderr}`,
        250,
      )
      const image = await containerImage(CONTAINERS.node)
      await copyImageInto(image, dind)
      const daemonEnv = {
        SCANTOR_URL: created.join.env.SCANTOR_URL,
        SCANTOR_NODE_TOKEN: created.token,
        SCANTOR_CA_CERT: testCaPem(),
        ...nodeDnsEnv(),
        ...options.env,
      }
      const node = new ThrowawayNode(adminApi, created, dind, engine, image, daemonEnv)
      if (options.daemon !== false) await node.startDaemon()
      return node
    } catch (error) {
      await docker(['rm', '-fv', dind], { allowFailure: true })
      await adminApi.deleteNode(created.node.id)
      throw error
    }
  }

  get id(): string {
    return this.created.node.id
  }

  get name(): string {
    return this.created.node.name
  }

  get pool(): string {
    return this.created.node.pool
  }

  /** `docker <args>` on the node's engine. */
  docker(args: string[], options: DockerOptions = {}): Promise<ExecResult> {
    return engineDocker(this.engine, args, options)
  }

  /** Runs the join command (`scantor-node`) on the engine and waits until the node is online. */
  async startDaemon(): Promise<void> {
    await this.docker([
      ...['run', '-d', '--name', 'scantor-node', '-v', '/var/run/docker.sock:/var/run/docker.sock'],
      ...Object.entries(this.daemonEnv).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
      ...[this.image, 'node'],
    ])
    await this.waitFor('online', (node) => node.state === 'online', 90_000)
  }

  /** A daemon restart (`docker restart scantor-node`): a new daemon instance on the same engine. */
  async restartDaemon(): Promise<void> {
    await this.docker(['restart', '-t', '30', 'scantor-node'], { timeoutMs: 90_000 })
  }

  getNode(): Promise<Node> {
    return getNode(this.adminApi, this.id)
  }

  waitFor(what: string, accept: (node: Node) => boolean, timeoutMs = 120_000): Promise<Node> {
    return waitForNode(this.adminApi, this.id, what, accept, timeoutMs).catch(async (error: unknown) => {
      throw new Error(`${(error as Error).message}\ndaemon log:\n${await this.daemonLog()}`)
    })
  }

  /** The tail of the daemon's log, for failure messages. */
  async daemonLog(): Promise<string> {
    const logs = await this.docker(['logs', '--tail', '60', 'scantor-node'], { allowFailure: true })
    return (logs.stdout + logs.stderr).replaceAll(this.created.token, '<token>')
  }

  /** The worker network's IPv4 gateway (the resolver's address) and subnet. */
  workerNetwork(): Promise<{ gateway: string; subnet: string }> {
    return networkAddresses(this.engine, WORKER_NETWORK)
  }

  resolverContainers(): Promise<ResolverInspect[]> {
    return resolverContainers(this.engine, this.id)
  }

  /** Removes the engine with everything in it and deletes the node. */
  async dispose(): Promise<void> {
    await docker(['rm', '-fv', this.dind], { allowFailure: true, timeoutMs: 120_000 })
    const deleted = await this.adminApi.deleteNode(this.id)
    if (deleted.status !== 204 && deleted.status !== 404) throw new Error(`deleteNode ${this.name} answered ${deleted.status}`)
  }
}

/** Runs `body` with a throwaway node that is removed afterwards. */
export async function withThrowawayNode<T>(adminApi: ApiClient, options: ThrowawayNodeOptions, body: (node: ThrowawayNode) => Promise<T>): Promise<T> {
  const node = await ThrowawayNode.start(adminApi, options)
  try {
    return await body(node)
  } finally {
    await node.dispose()
  }
}
