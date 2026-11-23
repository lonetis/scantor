import { readFile, writeFile } from 'node:fs/promises'
import { request, type APIRequestContext, type APIResponse } from '@playwright/test'
import { CONTAINERS, docker, DockerError, type ExecResult } from './docker'
import { env } from './env'
import { reserve } from './limiter'
import type { LogLine } from './orchestrator'
import { unique } from './unique'

// The Cloudflare Tunnel of the test stack (docs/testing.md §7.3, §7.8): the stand-in `tunnel` service of
// tests/docker/stack.tests.yml, a proxy with the network alias `cloudflared` on scantor-tunnel (the network the real
// cloudflared shares with the orchestrator only) that serves SCANTOR_TUNNEL_URL and forwards every request to
// orchestrator:3000. Request contexts and sessions on the tunnel URL, requests from other peers (containers on
// scantor-sandbox or scantor-scripts, the stand-in itself towards a throwaway orchestrator that joined scantor-tunnel)
// and the stack orchestrator's JSON log lines. Browsers keep sessions per host: a session cookie of the public URL is
// never sent to the tunnel URL and the other way round, so a page or context that uses both origins carries both
// cookies.

/** The tunnel URL's `Host` (with its port, as clients send it). */
export const TUNNEL_HOST = new URL(env.tunnelUrl).host

/** The `/api` prefixes the orchestrator refuses through the tunnel (server/utils/tunnel.ts TUNNEL_REFUSED_PREFIXES). */
export const TUNNEL_REFUSED_PREFIXES = ['/api/node', '/api/runtime', '/api/script-runtime', '/api/tools', '/api/registry', '/api/editor'] as const

/** Whether a path (no query) lies at or below a refused prefix; `/api/nodes` does not. */
export function isTunnelRefusedPath(path: string): boolean {
  return TUNNEL_REFUSED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

/**
 * A request context on the tunnel URL with the tunnel origin as `Origin` (better-auth and the CSRF check of a tunnel
 * request trust only it) and the long-poll timeout of helpers/users.ts newApiContext.
 */
export function newTunnelContext(options: { storageState?: string; headers?: Record<string, string> } = {}): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: env.tunnelUrl,
    timeout: 150_000,
    extraHTTPHeaders: { Origin: env.tunnelUrl, ...options.headers },
    storageState: options.storageState,
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `POST /api/auth/sign-in/email` through the tunnel URL, through the shared limiter (better-auth's limits are shared
 * by the origins). A 429 is waited out and the sign-in retried with a new limiter slot until `timeoutMs`; any other
 * answer is returned as is.
 */
export async function signInThroughTunnel(
  context: APIRequestContext,
  email: string,
  password: string,
  headers: Record<string, string> = {},
  timeoutMs = 90_000,
): Promise<APIResponse> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await reserve('/sign-in/email')
    const response = await context.post('/api/auth/sign-in/email', { data: { email, password }, headers })
    if (response.status() !== 429 || Date.now() > deadline) return response
    const retryAfter = Number(response.headers()['x-retry-after'] ?? '60')
    await sleep((Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, 1), 61) : 60) * 1000 + Math.random() * 2000)
  }
}

/** A tunnel context signed in as the account; dispose it after use. */
export async function tunnelSession(email: string, password: string): Promise<APIRequestContext> {
  const context = await newTunnelContext()
  try {
    const response = await signInThroughTunnel(context, email, password)
    if (response.status() !== 200) throw new Error(`sign-in of ${email} through the tunnel URL answered ${response.status()}: ${await response.text()}`)
    return context
  } catch (error) {
    await context.dispose()
    throw error
  }
}

interface StorageState {
  cookies: unknown[]
  origins: unknown[]
}

/**
 * Signs the account in through the tunnel URL and writes a storage state to `file` that holds that session and the
 * cookies of `publicState` (a storage state file of the public URL), so one browser context is signed in on both
 * origins. Returns `file`.
 */
export async function writeTunnelState(file: string, account: { email: string; password: string }, publicState?: string): Promise<string> {
  const context = await tunnelSession(account.email, account.password)
  try {
    const tunnel = (await context.storageState()) as StorageState
    const base = publicState ? (JSON.parse(await readFile(publicState, 'utf8')) as StorageState) : { cookies: [], origins: [] }
    await writeFile(file, JSON.stringify({ cookies: [...base.cookies, ...tunnel.cookies], origins: [...base.origins, ...tunnel.origins] }))
    return file
  } finally {
    await context.dispose()
  }
}

// ── other peers ──────────────────────────────────────────────────────────────────────────────────────

/** The status of busybox `wget -S` output; throws with the output when no response arrived. */
function wgetStatus(args: string[], result: ExecResult): number {
  const match = /HTTP\/1\.[01] (\d{3})/.exec(`${result.stderr}\n${result.stdout}`)
  if (!match) throw new DockerError(args, result)
  return Number(match[1])
}

/** busybox wget arguments of one request with the given `Host`; the body (if any) is POSTed. */
function wgetArgs(url: string, host: string, method: 'GET' | 'POST'): string[] {
  return ['wget', '-q', '-S', '-O', '/dev/null', '-T', '20', '--header', `Host: ${host}`, ...(method === 'POST' ? ['--post-data', ''] : []), url]
}

/** The image of a stack container (the node image brings busybox `sh`, `wget` and `sleep`). */
async function imageOf(container: string): Promise<string> {
  return (await docker(['inspect', '--format', '{{.Config.Image}}', container])).stdout.trim()
}

/**
 * A long-running container on one network (label scantor.test=true, removed by `dispose`), optionally with a network
 * alias, that sends requests to the orchestrator's internal address `http://orchestrator:3000` with any `Host`.
 */
export class NetworkPeer {
  private constructor(readonly name: string) {}

  static async start(network: string, alias?: string): Promise<NetworkPeer> {
    const name = unique('scantor-test-tunnel-peer')
    const image = await imageOf(CONTAINERS.node)
    await docker([
      'run',
      '-d',
      '--name',
      name,
      '--label',
      'scantor.test=true',
      '--network',
      network,
      ...(alias ? ['--network-alias', alias] : []),
      '--entrypoint',
      'sleep',
      image,
      '600',
    ])
    return new NetworkPeer(name)
  }

  /** The status of one request from this container. */
  async status(host: string, path: string, method: 'GET' | 'POST' = 'GET'): Promise<number> {
    const args = ['exec', this.name, ...wgetArgs(`http://orchestrator:3000${path}`, host, method)]
    return wgetStatus(args, await docker(args, { allowFailure: true }))
  }

  async dispose(): Promise<void> {
    await docker(['rm', '-f', this.name], { allowFailure: true })
  }
}

/** The status of one request from a throwaway container on `network` (see NetworkPeer). */
export async function statusFromNetwork(network: string, host: string, path: string, method: 'GET' | 'POST' = 'GET'): Promise<number> {
  const peer = await NetworkPeer.start(network)
  try {
    return await peer.status(host, path, method)
  } finally {
    await peer.dispose()
  }
}

/**
 * The status of one request that the stand-in tunnel itself sends (`docker exec` of its busybox wget), so the peer is
 * the container with the alias `cloudflared`; for throwaway orchestrators, which the stand-in does not route to
 * (`url` is their address on scantor-tunnel, connectToTunnelNetwork).
 */
export async function statusFromTunnelPeer(url: string, host: string, method: 'GET' | 'POST' = 'GET'): Promise<number> {
  const args = ['exec', CONTAINERS.tunnel, ...wgetArgs(url, host, method)]
  return wgetStatus(args, await docker(args, { allowFailure: true }))
}

/** The network the tunnel shares with the orchestrator only (docs/deployment.md §5). */
export const TUNNEL_NETWORK = 'scantor-tunnel'

/** A container's address on one network ('' when it is not attached to it). */
export async function containerAddress(container: string, network: string): Promise<string> {
  const { stdout } = await docker(['inspect', '--format', `{{with index .NetworkSettings.Networks "${network}"}}{{.IPAddress}}{{end}}`, container])
  return stdout.trim()
}

/** The address of the stand-in tunnel on scantor-tunnel, the socket peer the orchestrator sees for it. */
export async function tunnelPeerAddress(): Promise<string> {
  return containerAddress(CONTAINERS.tunnel, TUNNEL_NETWORK)
}

/**
 * Attaches a throwaway orchestrator to scantor-tunnel, as compose attaches the stack's, and returns its dashboard URL
 * there (`http://<address>:3000`), which the stand-in tunnel reaches.
 */
export async function connectToTunnelNetwork(container: string): Promise<string> {
  await docker(['network', 'connect', TUNNEL_NETWORK, container])
  return `http://${await containerAddress(container, TUNNEL_NETWORK)}:3000`
}

/** The addresses the stack orchestrator's own resolver returns for a host name ([] when it does not resolve). */
export async function orchestratorLookup(host: string): Promise<string[]> {
  const script = `require('node:dns').promises.lookup(${JSON.stringify(host)}, { all: true }).then((r) => console.log(JSON.stringify(r.map((e) => e.address))), () => console.log('[]'))`
  const { stdout } = await docker(['exec', CONTAINERS.orchestrator, 'node', '-e', script])
  return JSON.parse(stdout.trim()) as string[]
}

// ── the stack orchestrator's log ─────────────────────────────────────────────────────────────────────

/** The JSON log lines the stack's orchestrator wrote since `since` (other output lines are skipped). */
export async function orchestratorLogLines(since: Date): Promise<LogLine[]> {
  const { stdout, stderr } = await docker(['logs', '--since', since.toISOString(), CONTAINERS.orchestrator], { timeoutMs: 60_000 })
  const lines: LogLine[] = []
  for (const line of `${stdout}\n${stderr}`.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      lines.push(JSON.parse(line) as LogLine)
    } catch {
      // A partial line at the end of the running container's output.
    }
  }
  return lines
}

/** Polls the stack orchestrator's log since `since` until a line matches; returns it. */
export async function waitForOrchestratorLog(since: Date, predicate: (line: LogLine) => boolean, timeoutMs = 30_000): Promise<LogLine> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = (await orchestratorLogLines(since)).find(predicate)
    if (found) return found
    if (Date.now() > deadline) throw new Error(`no matching log line of ${CONTAINERS.orchestrator} since ${since.toISOString()} within ${timeoutMs / 1000} s`)
    await sleep(1000)
  }
}
