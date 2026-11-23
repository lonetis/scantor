import { isIP } from 'node:net'
import { dashboardListenerUrl, rawRequest, type RawResponse } from '../helpers/api-auth'
import { ThrowawayOrchestrator, type LogLine } from '../helpers/orchestrator'
import { mapLimit } from '../helpers/security'
import { withSecurityTenants } from '../helpers/security-tenants'
import {
  connectToTunnelNetwork,
  newTunnelContext,
  signInThroughTunnel,
  statusFromNetwork,
  statusFromTunnelPeer,
  TUNNEL_HOST,
  tunnelPeerAddress,
  waitForOrchestratorLog,
} from '../helpers/tunnel'
import { createUser, deleteUser } from '../helpers/users'
import { expect, test as base, unique } from '../fixtures'

// The tunnel's request classification (docs/auth.md §4.5, security.md TUN-1…TUN-3, TUN-7): a request is a tunnel
// request only when its socket peer is the compose service `cloudflared` and its Host is the tunnel URL's host; exactly
// one of the two is 421 Misdirected Request. Through the tunnel the machine, tools, registry and editor prefixes do not
// exist, and the client IP is the rightmost X-Forwarded-For entry. The stack's stand-in tunnel (docs/testing.md §7.3)
// is the `cloudflared` peer; other peers are the runner on the dashboard listener and containers on scantor-sandbox and
// scantor-scripts (a container there that claims the alias `cloudflared` is in chaos/tunnel.spec.ts, because it takes
// the name over from the stand-in). Throwaway orchestrators show the behaviour without a tunnel URL and the
// configuration checks.

const test = withSecurityTenants(base)

// Only the client IP test needs a user, which it creates; the others must not sign in on the shared stack.
test.use({ storageState: { cookies: [], origins: [] } })

function expectMisdirected(response: RawResponse, label: string): void {
  expect(response.status, `${label}: ${response.text().slice(0, 200)}`).toBe(421)
  expect(response.headers['content-type'], label).toMatch(/^text\/plain/)
  expect(response.text(), label).toContain('Misdirected Request')
}

/**
 * The warning about a misdirected tunnel request of one kind: middleware/00.request.ts logs each kind at most once a
 * minute (a misrouted tunnel repeats it per request), so a test looks back further than that.
 */
function misdirectedWarning(kind: 'tunnel host from another peer' | 'another host from cloudflared') {
  return (line: LogLine) => line.level === 'warn' && String(line.msg).startsWith('misdirected tunnel request refused with 421') && line.kind === kind
}

test.describe('tunnel requests', () => {
  test('the tunnel host from any other peer and any other host from the tunnel peer get 421 before any route', { tag: ['@TUNNEL-002'] }, async ({ env }) => {
    // A warning of the minute before the test's own mismatches stands for them (one per kind and minute).
    const since = new Date(Date.now() - 2 * 60_000)
    const paths = ['/api/health', '/', '/mcp', '/api/auth/get-session', '/api/node/hello']
    for (const path of paths) {
      // The runner straight to the dashboard listener, with the tunnel URL's Host.
      expectMisdirected(await rawRequest(`${dashboardListenerUrl()}${path}`, { headers: { Host: TUNNEL_HOST } }), `listener ${path}`)
      // The stand-in tunnel (the cloudflared peer) with the public and the editor host.
      expectMisdirected(await rawRequest(`${env.tunnelUrl}${path}`, { headers: { Host: env.domain } }), `tunnel peer, public host ${path}`)
      expectMisdirected(await rawRequest(`${env.tunnelUrl}${path}`, { headers: { Host: new URL(env.editorUrl).host } }), `tunnel peer, editor host ${path}`)
    }
    // The tunnel host is not served by Traefik at all: it has no router for it.
    const traefik = await rawRequest(`https://${new URL(env.tunnelUrl).hostname}/api/health`)
    expect(traefik.status).toBe(404)
    expect(traefik.text()).toContain('404 page not found')
    // The control: both together are a tunnel request.
    const served = await rawRequest(`${env.tunnelUrl}/api/health`)
    expect(served.status).toBe(200)
    // The orchestrator reports both kinds of misdirected tunnel requests as rate-limited warnings.
    await waitForOrchestratorLog(since, misdirectedWarning('tunnel host from another peer'))
    await waitForOrchestratorLog(since, misdirectedWarning('another host from cloudflared'))
  })

  test('containers on scantor-sandbox and scantor-scripts get 421 for the tunnel host', { tag: ['@TUNNEL-002'] }, async ({ env }) => {
    test.setTimeout(180_000)
    for (const network of ['scantor-sandbox', 'scantor-scripts']) {
      expect(await statusFromNetwork(network, TUNNEL_HOST, '/api/health'), `${network}, tunnel host`).toBe(421)
      expect(await statusFromNetwork(network, TUNNEL_HOST, '/api/node/hello', 'POST'), `${network}, tunnel host`).toBe(421)
      // The control: the same container reaches the orchestrator with the public host.
      expect(await statusFromNetwork(network, env.domain, '/api/health'), `${network}, public host`).toBe(200)
    }
  })

  test('the client IP of a tunnel request is the rightmost X-Forwarded-For entry', { tag: ['@TUNNEL-004', '@AUTH-012'] }, async ({ adminApi }) => {
    const user = await createUser(adminApi, { prefix: 'tunnel-ip' })
    const tunnel = await newTunnelContext()
    try {
      const since = new Date()
      const spoofed = '203.0.113.7'
      const forwarded = '198.51.100.9'
      const requestId = unique('tunnel-ip')
      const signedIn = await signInThroughTunnel(tunnel, user.email, user.password, {
        'X-Forwarded-For': `${spoofed}, ${forwarded}`,
        'x-scantor-client-ip': spoofed,
        'X-Request-Id': requestId,
      })
      expect(signedIn.status(), await signedIn.text()).toBe(200)

      const sessions = (await (await tunnel.get('/api/auth/list-sessions')).json()) as { ipAddress?: string | null }[]
      expect(sessions).toHaveLength(1)
      const address = sessions[0]!.ipAddress ?? ''
      expect(isIP(address), address).not.toBe(0)
      // Neither a client-supplied entry nor the tunnel's own address: the address the tunnel saw, which it appended.
      expect([spoofed, forwarded]).not.toContain(address)
      expect(address).not.toBe(await tunnelPeerAddress())

      const line = await waitForOrchestratorLog(since, (candidate) => candidate.msg === 'request' && candidate.requestId === requestId)
      expect(line).toMatchObject({ path: '/api/auth/sign-in/email', origin: 'tunnel', status: 200, clientIp: address })
    } finally {
      await tunnel.dispose()
      await deleteUser(adminApi, user.id)
    }
  })

  test('the refused prefixes answer 404 through the tunnel before any body or credential is read', { tag: ['@TUNNEL-003'] }, async ({ env }) => {
    const since = new Date()
    const oversized = JSON.stringify({ padding: 'x'.repeat(1536 * 1024) })
    const cases: { method: string; path: string; headers?: Record<string, string>; body?: string; publicStatus: number }[] = [
      // A runtime body above its 1 MiB cap: 413 on the public URL, so the tunnel's 404 came before the body limit.
      {
        method: 'POST',
        path: '/api/runtime/state',
        headers: { Authorization: 'Bearer not-a-credential', 'Content-Type': 'application/json' },
        body: oversized,
        publicStatus: 413,
      },
      // An invalid credential is 401 on the public URL; the peer check of the script runtime API is 403 there.
      { method: 'POST', path: '/api/node/hello', headers: { Authorization: 'Bearer snt_invalid' }, publicStatus: 401 },
      { method: 'GET', path: '/api/script-runtime/bootstrap', headers: { Authorization: 'Bearer ssr_invalid' }, publicStatus: 403 },
      { method: 'GET', path: '/api/registry/token?service=scantor-registry', publicStatus: 401 },
      { method: 'GET', path: '/api/tools/forward-auth', publicStatus: 401 },
      { method: 'GET', path: '/api/editor', headers: { Authorization: 'Bearer sk_scantor_invalid' }, publicStatus: 401 },
      // The prefix itself and a trailing slash: anonymous requests are 401 on the public URL, which authenticates first.
      { method: 'GET', path: '/api/node', publicStatus: 401 },
      { method: 'GET', path: '/api/node/', publicStatus: 401 },
    ]
    for (const { method, path, headers, body, publicStatus } of cases) {
      const requestId = unique('tunnel-refused')
      const through = await rawRequest(`${env.tunnelUrl}${path}`, { method, headers: { ...headers, 'X-Request-Id': requestId }, body })
      const label = `${method} ${path} through the tunnel`
      expect(through.status, `${label}: ${through.text().slice(0, 200)}`).toBe(404)
      const error = through.json<{ error: { code: string; message: string } }>().error
      expect(error.code, label).toBe('notFound')
      expect(error.message, label).toBe(`no operation at ${path.split('?')[0]}`)
      const line = await waitForOrchestratorLog(since, (candidate) => candidate.msg === 'request' && candidate.requestId === requestId)
      expect(line, label).toMatchObject({ origin: 'tunnel', status: 404, code: 'notFound' })
      expect(line.principal, label).toBeUndefined()

      const direct = await rawRequest(`${env.publicUrl}${path}`, { method, headers, body })
      expect(direct.status, `${method} ${path} on the public URL: ${direct.text().slice(0, 200)}`).toBe(publicStatus)
    }
    // `/api/nodes` (the admin's node list) is no refused prefix: anonymous, it is 401 like on the public URL.
    const nodes = await rawRequest(`${env.tunnelUrl}/api/nodes`)
    expect(nodes.status).toBe(401)
    expect(nodes.json<{ error: { code: string } }>().error.code).toBe('unauthorized')
  })
})

test.describe('the tunnel URL setting', () => {
  let orchestrator: ThrowawayOrchestrator | undefined

  test.afterEach(async () => {
    await orchestrator?.dispose()
    orchestrator = undefined
  })

  test(
    'without SCANTOR_TUNNEL_URL the cloudflared peer is an ordinary client, and with it the same requests are refused',
    { tag: ['@TUNNEL-016'] },
    async ({ env, throwawayInfra }) => {
      test.setTimeout(300_000)
      orchestrator = await ThrowawayOrchestrator.start({ name: 'tunnel-off', infra: throwawayInfra })
      // The stand-in tunnel sends these itself, so the peer is the container with the alias cloudflared, which reaches
      // the throwaway only on scantor-tunnel, as cloudflared reaches the stack's orchestrator.
      let tunnelSide = await connectToTunnelNetwork(orchestrator.container)
      await orchestrator.waitReady()
      const fromTunnel = (path: string, host: string, method: 'GET' | 'POST' = 'GET') => statusFromTunnelPeer(`${tunnelSide}${path}`, host, method)
      expect(await fromTunnel('/api/health', TUNNEL_HOST)).toBe(200)
      expect(await fromTunnel('/api/node/hello', TUNNEL_HOST, 'POST')).toBe(401)
      expect((await rawRequest(`${orchestrator.baseUrl}/api/health`, { headers: { Host: TUNNEL_HOST } })).status).toBe(200)

      orchestrator = await orchestrator.redeploy({ SCANTOR_TUNNEL_URL: env.tunnelUrl })
      tunnelSide = await connectToTunnelNetwork(orchestrator.container)
      await orchestrator.waitReady()
      // cloudflared is resolved after the first tunnel-host request from an unknown peer (at most every 5 s).
      await expect.poll(() => fromTunnel('/api/health', TUNNEL_HOST), { timeout: 30_000, intervals: [1_000] }).toBe(200)
      expect(await fromTunnel('/api/node/hello', TUNNEL_HOST, 'POST')).toBe(404)
      expect(await fromTunnel('/api/health', new URL(orchestrator.publicUrl).host)).toBe(421)
      expectMisdirected(await rawRequest(`${orchestrator.baseUrl}/api/health`, { headers: { Host: TUNNEL_HOST } }), 'the runner with the tunnel host')
    },
  )

  test('an invalid tunnel URL or the cloudflare-tunnel profile without one aborts startup', { tag: ['@TUNNEL-017'] }, async () => {
    const cases: { env: Record<string, string>; problem: RegExp }[] = [
      { env: { SCANTOR_TUNNEL_URL: 'http://tunnel.example.test' }, problem: /must use https/ },
      { env: { SCANTOR_TUNNEL_URL: 'https://tunnel.example.test/scantor' }, problem: /must not contain a path/ },
      { env: { SCANTOR_TUNNEL_URL: 'https://localhost:8443' }, problem: /must name a DNS host/ },
      { env: { SCANTOR_TUNNEL_URL: 'https://192.0.2.10' }, problem: /must name a DNS host/ },
      {
        env: {
          SCANTOR_PUBLIC_URL: 'https://scantor.example.test',
          SCANTOR_EDITOR_URL: 'https://editor.example.test',
          SCANTOR_TUNNEL_URL: 'https://scantor.example.test',
        },
        problem: /must have another host than SCANTOR_PUBLIC_URL/,
      },
      {
        env: {
          SCANTOR_PUBLIC_URL: 'https://scantor.example.test',
          SCANTOR_EDITOR_URL: 'https://editor.example.test',
          SCANTOR_TUNNEL_URL: 'https://editor.example.test',
        },
        problem: /must have another host than SCANTOR_EDITOR_URL/,
      },
      { env: { SCANTOR_DOMAIN: 'example.test', SCANTOR_TUNNEL_URL: 'https://s3.example.test' }, problem: /must not be one of Traefik's hosts/ },
      { env: { COMPOSE_PROFILES: 'cloudflare-tunnel' }, problem: /must be set while COMPOSE_PROFILES contains cloudflare-tunnel/ },
    ]
    await mapLimit(cases, 4, async ({ env, problem }) => {
      const label = JSON.stringify(env)
      const started = await ThrowawayOrchestrator.start({ name: 'tunnel-config', infra: false, env })
      try {
        const { exitCode, ranMs } = await started.waitExit(30_000)
        expect(exitCode, label).toBe(1)
        expect(ranMs, label).toBeLessThan(30_000)
        const lines = await started.logLines()
        const issue = lines.find((line) => line.level === 'error' && line.msg === 'invalid configuration' && line.variable === 'SCANTOR_TUNNEL_URL')
        expect(issue, `${label}: ${JSON.stringify(lines)}`).toBeDefined()
        expect(String(issue!.problem), label).toMatch(problem)
        expect(
          lines.find((line) => line.msg === 'configuration loaded'),
          label,
        ).toBeUndefined()
      } finally {
        await started.dispose()
      }
    })
  })
})
