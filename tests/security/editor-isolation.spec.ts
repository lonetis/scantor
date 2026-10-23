import { randomBytes } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import { ApiClient, ok } from '../helpers/api-client'
import { withPlatformScans, withPlatformTasks } from '../helpers/api-platform-cleanup'
import {
  WORKSPACE_ROOT,
  editorCookieHeader,
  editorOrigin,
  editorStatus,
  execInEditor,
  hostRequest,
  inspectEditor,
  openEditorSession,
  originGet,
  redeem,
  signedInEditor,
  startEditor,
  stopEditor,
  upgradeRequest,
} from '../helpers/api-platform-editor'
import { createPlatformTenant, deletePlatformTenant, withLazyTenant, withPlatformAdmin, withWorkerTenant } from '../helpers/api-platform-tenant'
import { stackEnv } from '../helpers/docker'
import { stackKeys } from '../helpers/keys'
import { newApiContext } from '../helpers/users'
import { expect, test as base } from '../fixtures'

// Editor isolation (docs/editor.md §8, docs/security.md ED-1…ED-10, docs/testing.md §8.6): the editor origin is a
// listener of its own that serves only `/_auth` and the proxy to the caller's own code-server, its one-time codes and
// cookies are bound to one user and one editor start, its WebSockets need the editor origin, code-server cannot set
// cookies, a planted symlink never reaches another socket, and the editor container is hardened and unreachable for
// master workers. Every editor belongs to a dedicated user of the test. The listeners are also called directly on the
// runner's loopback ports (3000 dashboard, 3001 editor), which is how Traefik reaches them, to choose the Host header.

const test = base.extend<{ origin: APIRequestContext }>({
  // An admin of the worker and a tenant with a uniquely named session (helpers/api-platform-tenant.ts).
  adminApi: [async ({ openapi }, use) => withPlatformAdmin(openapi, use), { scope: 'worker', timeout: 150_000 }],
  user: [
    async ({ adminApi, openapi }, use, workerInfo) => withWorkerTenant(adminApi, openapi, `w${workerInfo.workerIndex}`, use),
    { scope: 'worker', timeout: 150_000 },
  ],
  // tasks and scans that never wait for the stack's deletion jobs (helpers/api-platform-cleanup.ts).
  tasks: async ({ api }, use) => withPlatformTasks(api, use),
  scans: async ({ api, tasks: _tasks }, use) => withPlatformScans(api, use),
  freshUserHandle: async ({ adminApi, openapi }, use) => withLazyTenant(adminApi, openapi, 'isolation', use),
  // A sign-in that meets another run's 429 waits it out; it gets its own time, not the test's.
  freshUser: [async ({ freshUserHandle }, use) => use(await freshUserHandle.get()), { scope: 'test', timeout: 150_000 }],
  origin: async ({}, use) => {
    const context = await editorOrigin()
    await use(context)
    await context.dispose()
  },
})

// Tests run as their own `freshUser`; a tenant (one sign-in) is created only for the tests that use `api`.
test.use({ storageState: { cookies: [], origins: [] } })

const DASHBOARD_PORT = 3000
const EDITOR_PORT = 3001
// code-server redirects `/` to the folder of its command line; the workbench page itself is this path, the
// location `/_auth` sends the browser to.
const WORKBENCH = `/?folder=${WORKSPACE_ROOT}`

/** The user id inside a `scantor_editor` cookie value (`v1.<userId>.<startedAtMs>.<expiresAtMs>.<mac>`). */
function cookieParts(value: string): { userId: string; startedAtMs: number; expiresAtMs: number; mac: string } {
  const match = /^v1\.([0-9a-f-]{36})\.(\d+)\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(value)
  if (!match) throw new Error(`not an editor cookie: ${value}`)
  return { userId: match[1]!, startedAtMs: Number(match[2]), expiresAtMs: Number(match[3]), mac: match[4]! }
}

/** The dashboard session cookie of a request context (better-auth's session token). */
async function sessionCookie(context: APIRequestContext): Promise<string> {
  const cookie = (await context.storageState()).cookies.find((entry) => entry.name.endsWith('session_token'))
  if (!cookie) throw new Error('the context has no session cookie')
  return `${cookie.name}=${cookie.value}`
}

// The two long tests (a build and a scan; a code's lifetime) come first, so they run on both workers at once.
test.describe('the editor container', () => {
  test(
    'is hardened, has no Docker socket and cannot be reached from a master worker',
    { tag: ['@EDIT-013', '@EDIT-014'] },
    async ({ adminApi, api, freshApi, freshUser, scans, tasks }) => {
      test.setTimeout(180_000)
      const netprobe = await tasks.fixture('netprobe')
      await startEditor(freshApi)
      const container = await inspectEditor(freshUser.id)
      expect(container).not.toBeNull()
      const stack = stackEnv()

      // EDIT-014: the container spec.
      expect(container!.Name).toBe(`/scantor-editor-${freshUser.id}`)
      expect(container!.Config.User).toBe('1000:1000')
      expect(container!.Config.Labels).toMatchObject({
        'scantor.managed': 'true',
        'scantor.kind': 'editor',
        'scantor.user': freshUser.id,
        'traefik.enable': 'false',
        'com.docker.compose.project': 'scantor-managed',
      })
      const host = container!.HostConfig
      expect(host.ReadonlyRootfs).toBe(true)
      expect(host.CapDrop).toEqual(['ALL'])
      expect(host.CapAdd ?? []).toEqual([])
      expect(host.SecurityOpt).toEqual(['no-new-privileges:true'])
      expect(host.Privileged).toBe(false)
      expect(host.Init).toBe(true)
      expect(host.RestartPolicy.Name).toBe('no')
      expect(host.PidsLimit).toBe(Number(stack.SCANTOR_EDITOR_PIDS_LIMIT))
      expect(host.Memory).toBe(2 * 1024 * 1024 * 1024)
      expect(host.MemorySwap).toBe(host.Memory)
      expect(host.NanoCpus).toBe(Number(stack.SCANTOR_EDITOR_CPUS) * 1e9)
      expect(host.Binds ?? []).toEqual([])
      expect(Object.keys(host.PortBindings ?? {})).toEqual([])
      expect(Object.keys(host.Tmpfs ?? {})).toEqual(['/tmp'])
      const mounts = container!.Mounts.map((mount) => ({ type: mount.Type, name: mount.Name, destination: mount.Destination }))
      expect(mounts.sort((x, y) => x.destination.localeCompare(y.destination))).toEqual(
        [
          { type: 'volume', name: 'scantor-editor-home', destination: '/home/coder' },
          { type: 'volume', name: 'scantor-workspaces', destination: '/home/coder/workspace' },
          { type: 'volume', name: 'scantor-editor-sockets', destination: '/run/scantor-editor' },
          ...(container!.Mounts.some((mount) => mount.Destination === '/tmp') ? [{ type: 'tmpfs', name: undefined, destination: '/tmp' }] : []),
        ].sort((x, y) => x.destination.localeCompare(y.destination)),
      )
      for (const mount of host.Mounts ?? []) expect(mount.VolumeOptions?.Subpath, mount.Target).toBe(freshUser.id)
      expect(JSON.stringify(container!.Mounts)).not.toContain('docker.sock')
      const socketCheck = await execInEditor(freshUser.id, ['sh', '-c', 'ls /var/run/docker.sock /run/docker.sock 2>&1; id -u; id -g; touch /etc/x 2>&1; true'])
      expect(socketCheck.stdout).toContain('No such file or directory')
      expect(socketCheck.stdout).toMatch(/^1000$/m)
      expect(socketCheck.stdout).toContain('Read-only file system')

      // EDIT-013: a worker on the built-in node reaches the orchestrator but not the editor (no editor port listens).
      const address = Object.values(container!.NetworkSettings.Networks)[0]!.IPAddress
      expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
      const targets = [`${address}:8080`, `${address}:80`, `${address}:443`, `${address}:3000`, `${address}:22`, 'orchestrator:3000']
      const scan = await scans.start({ revision: netprobe.revision.id, taskConfig: { mode: 'connect', targets, timeout_seconds: 3 } })
      await scans.wait(scan.id, { timeoutMs: 120_000 })
      const workers = ok(await api.listScanWorkers(scan.id), 'listScanWorkers').items
      const builtin = ok(await adminApi.listNodes(), 'listNodes').items.find((node) => node.builtIn)!
      expect(workers.filter((worker) => worker.role === 'runner').map((worker) => worker.nodeId)).toEqual([builtin.id])
      const analyses = ok(await api.queryAnalyses(scan.id, { filter: {} }), 'queryAnalyses').items as {
        status: string
        result: { reachable: Record<string, boolean>; errors: Record<string, string> }
      }[]
      expect(analyses).toHaveLength(1)
      expect(analyses[0]!.status).toBe('succeeded')
      const { reachable, errors } = analyses[0]!.result
      expect(reachable['orchestrator:3000'], 'the probe works: the orchestrator is reachable').toBe(true)
      for (const target of targets.filter((entry) => entry.startsWith(address))) {
        expect(reachable[target], `${target}: ${errors[target]}`).toBe(false)
      }
      await stopEditor(freshApi)
    },
  )
})

test.describe('editor sessions and cookies', () => {
  test('a session code expires after 60 s', { tag: ['@EDIT-008'] }, async ({ freshApi }) => {
    test.setTimeout(150_000)
    const late = ok(await openEditorSession(freshApi), 'createEditorSession')
    const expiresAt = Date.parse(late.expiresAt)
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(60_000)
    await test.step('wait until the code has expired', async () => {
      await expect.poll(() => Date.now() > expiresAt + 1000, { timeout: 75_000, intervals: [1000] }).toBe(true)
    })
    const expired = await redeem(late.url)
    expect(expired.status).toBe(401)
    expect(expired.cookie).toBeNull()
    expect(expired.body).toContain('invalid, was already used or has expired')
    await stopEditor(freshApi)
  })

  test(
    'codes are single use and bound to their user; each cookie reaches only its own editor, also for admins',
    { tag: ['@EDIT-008', '@EDIT-012'] },
    async ({ adminApi, env, freshApi, freshUser, openapi, origin }) => {
      test.setTimeout(180_000)
      // User B is an admin with an editor of its own.
      const admin = await createPlatformTenant(adminApi, openapi, { prefix: 'isolation-b', role: 'admin' })
      const adminSession = await newApiContext({ storageState: admin.storageState })
      const adminClient = new ApiClient(adminSession, openapi)
      const otherOrigin = await editorOrigin()
      try {
        const a = await signedInEditor(freshApi)
        const b = await signedInEditor(adminClient)
        expect(cookieParts(a.cookie).userId).toBe(freshUser.id)
        expect(cookieParts(b.cookie).userId).toBe(admin.id)

        // Each cookie reaches its own code-server (the window title names the user).
        const pageA = await originGet(origin, WORKBENCH, editorCookieHeader(a.cookie))
        expect(pageA.status).toBe(200)
        expect(pageA.body).toContain(freshUser.email)
        expect(pageA.body).not.toContain(admin.email)
        const pageB = await originGet(otherOrigin, WORKBENCH, editorCookieHeader(b.cookie))
        expect(pageB.status).toBe(200)
        expect(pageB.body).toContain(admin.email)
        expect(pageB.body).not.toContain(freshUser.email)
        // A's cookie with B's identity and A's MAC is no cookie at all.
        const parts = cookieParts(a.cookie)
        const swapped = `v1.${admin.id}.${parts.startedAtMs}.${parts.expiresAtMs}.${parts.mac}`
        expect((await originGet(otherOrigin, WORKBENCH, editorCookieHeader(swapped))).status).toBe(401)

        // One-time codes: a used, an unknown and a malformed code get the 401 page and no cookie.
        const code = ok(await openEditorSession(freshApi), 'createEditorSession')
        const first = await redeem(code.url)
        expect(first.status).toBe(302)
        expect(cookieParts(first.cookie!).userId).toBe(freshUser.id)
        for (const [label, url] of [
          ['a used code', code.url],
          ['an unknown code', `${env.editorUrl}/_auth?code=sec_${randomBytes(32).toString('base64url')}`],
          ['a malformed code', `${env.editorUrl}/_auth?code=${encodeURIComponent('sec_../../x')}`],
          ['no code', `${env.editorUrl}/_auth`],
        ] as const) {
          const answer = await redeem(url)
          expect(answer.status, label).toBe(401)
          expect(answer.cookie, label).toBeNull()
          expect(answer.body, label).toContain('invalid, was already used or has expired')
        }

        // Editor routes act on the caller's own editor, also for an admin: B cannot name or stop A's editor.
        const aBefore = await editorStatus(freshApi)
        const bStatus = await editorStatus(adminClient)
        expect(bStatus.startedAt).not.toBe(aBefore.startedAt)
        const named = await adminClient.call('createEditorSession', { body: { userId: freshUser.id } })
        expect(named.status).toBe(400)
        expect((await adminClient.call('stopEditor')).status).toBe(204)
        expect(await editorStatus(freshApi)).toEqual(aBefore)
        expect((await originGet(origin, WORKBENCH, editorCookieHeader(a.cookie))).status).toBe(200)
        expect((await originGet(otherOrigin, WORKBENCH, editorCookieHeader(b.cookie))).status).toBe(410)

        // A symlinked code-server socket (to the Docker socket, or to another user's socket) is refused (EDIT-012).
        const planted = await execInEditor(freshUser.id, [
          'sh',
          '-c',
          'rm -f /run/scantor-editor/code.sock && ln -s /var/run/docker.sock /run/scantor-editor/code.sock && ls -l /run/scantor-editor',
        ])
        expect(planted.exitCode, planted.stderr).toBe(0)
        expect(planted.stdout).toContain('code.sock -> /var/run/docker.sock')
        // A new connection (a WebSocket always opens one) is refused at the socket check.
        const ws = await upgradeRequest(`${env.editorUrl}/`, { ...editorCookieHeader(a.cookie), Origin: env.editorUrl })
        expect(ws.status).toBe(502)
        // HTTP requests may still ride a pooled keep-alive connection to the real code-server until it idles out; once
        // the proxy has to connect again it answers 502, and the Docker API never answers.
        for (const path of ['/version', '/containers/json']) {
          await expect
            .poll(
              async () => {
                const response = await originGet(origin, path, editorCookieHeader(a.cookie))
                expect(response.body, path).not.toContain('ApiVersion')
                expect(response.body, path).not.toContain('"Id"')
                return response.status
              },
              { timeout: 60_000, intervals: [2000, 4000, 6000, 8000, 10_000], message: `${path} through the planted symlink` },
            )
            .toBe(502)
        }
        // Another user's socket path, as the orchestrator sees it.
        const otherSocket = await execInEditor(freshUser.id, [
          'sh',
          '-c',
          `rm -f /run/scantor-editor/code.sock && ln -s /run/scantor/editor-sockets/${admin.id}/code.sock /run/scantor-editor/code.sock`,
        ])
        expect(otherSocket.exitCode, otherSocket.stderr).toBe(0)
        await startEditor(adminClient)
        const viaLink = await upgradeRequest(`${env.editorUrl}/`, { ...editorCookieHeader(a.cookie), Origin: env.editorUrl })
        expect(viaLink.status).toBe(502)
        const page = await originGet(origin, WORKBENCH, editorCookieHeader(a.cookie))
        expect(page.body).not.toContain(admin.email)
        await stopEditor(adminClient)
        await stopEditor(freshApi)
      } finally {
        await otherOrigin.dispose()
        await adminSession.dispose()
        await deletePlatformTenant(adminApi, admin)
      }
    },
  )

  test(
    'the editor cookie is host-only, HttpOnly, Lax and Secure for 12 h, bound to one editor start',
    { tag: ['@EDIT-010'] },
    async ({ env, freshApi, freshUser, origin }) => {
      test.setTimeout(180_000)
      await startEditor(freshApi)
      const session = ok(await openEditorSession(freshApi), 'createEditorSession')
      const before = Date.now()
      const redeemed = await redeem(session.url)
      expect(redeemed.status).toBe(302)
      expect(redeemed.setCookies).toHaveLength(1)
      const attributes = redeemed.setCookies[0]!.split(';').map((part) => part.trim())
      expect(attributes[0]).toBe(`scantor_editor=${redeemed.cookie}`)
      expect(attributes.slice(1).sort()).toEqual(['HttpOnly', 'Max-Age=43200', 'Path=/', 'SameSite=Lax', 'Secure'])
      expect(attributes.some((attribute) => /^domain=/i.test(attribute))).toBe(false)

      // The value binds the user, the editor's start and an expiry 12 h ahead, signed with the editor-cookie key.
      const parts = cookieParts(redeemed.cookie!)
      const status = await editorStatus(freshApi)
      expect(parts.userId).toBe(freshUser.id)
      expect(parts.startedAtMs).toBe(Date.parse(status.startedAt!))
      expect(parts.expiresAtMs - before).toBeGreaterThan(12 * 3_600_000 - 60_000)
      expect(parts.expiresAtMs - Date.now()).toBeLessThanOrEqual(12 * 3_600_000)
      expect(redeemed.cookie).toBe(stackKeys().editorCookie(freshUser.id, parts.startedAtMs, parts.expiresAtMs))
      expect(redeemed.headers['location']).toBe(WORKBENCH)
      expect((await originGet(origin, WORKBENCH, editorCookieHeader(redeemed.cookie!))).status).toBe(200)
      // A cookie that expired, or that carries another MAC, is refused.
      const expired = stackKeys().editorCookie(freshUser.id, parts.startedAtMs, Date.now() - 1000)
      expect((await originGet(origin, '/', editorCookieHeader(expired))).status).toBe(401)
      expect((await originGet(origin, '/', editorCookieHeader(`${redeemed.cookie!.slice(0, -4)}AAAA`))).status).toBe(401)

      // Stopping the editor ends the cookie; a restarted editor does not accept it either.
      await stopEditor(freshApi)
      const stopped = await originGet(origin, '/', editorCookieHeader(redeemed.cookie!))
      expect(stopped.status).toBe(410)
      await startEditor(freshApi)
      expect((await editorStatus(freshApi)).startedAt).not.toBe(status.startedAt)
      const restarted = await originGet(origin, '/', editorCookieHeader(redeemed.cookie!))
      expect(restarted.status).toBe(410)
      const fresh = await redeem(ok(await openEditorSession(freshApi), 'createEditorSession').url)
      expect((await originGet(origin, WORKBENCH, editorCookieHeader(fresh.cookie!))).status).toBe(200)
      expect(env.editorUrl.startsWith('https://')).toBe(true)
      await stopEditor(freshApi)
    },
  )
})

test.describe('editor listener', () => {
  test(
    'each listener refuses the other host, and the editor origin serves no API and accepts no dashboard credential',
    { tag: ['@EDIT-009'] },
    async ({ adminApi, env, origin }) => {
      const editorHost = new URL(env.editorUrl).host
      // The dashboard listener answers 421 for the editor host; the editor listener for every other host.
      const misdirected = await hostRequest(DASHBOARD_PORT, '/api/health', editorHost)
      expect(misdirected.status).toBe(421)
      expect(String(misdirected.headers['content-type'])).toMatch(/^text\/plain/)
      for (const host of [env.domain, 'evil.example', `127.0.0.1:${EDITOR_PORT}`, `rabbitmq.${env.domain}`, `${editorHost}.evil.example`]) {
        const response = await hostRequest(EDITOR_PORT, '/_auth?code=x', host)
        expect(response.status, host).toBe(421)
        expect(response.body, host).toContain('Misdirected Request')
      }
      const reached = await hostRequest(EDITOR_PORT, '/', editorHost)
      expect(reached.status).toBe(401)

      // Through Traefik: API, MCP and docs paths on the editor origin are the listener's own 401 page, never the API.
      for (const path of ['/api/health', '/api/account', '/api/docs/openapi.json', '/mcp', '/api/tools/forward-auth', '/login']) {
        const response = await originGet(origin, path)
        expect(response.status, path).toBe(401)
        expect(response.headers['content-type'], path).toMatch(/^text\/html/)
        expect(response.body, path).toContain('Not signed in')
        expect(response.body, path).not.toContain('"status"')
      }
      // `/_auth` takes only GET.
      const post = await origin.post('/_auth?code=x', { maxRedirects: 0 })
      expect(post.status()).toBe(405)

      // The dashboard's session cookie, an API key or a bearer token are no credentials on the editor origin.
      const dashboardCookie = await sessionCookie(adminApi.request)
      for (const [label, headers] of [
        ['the dashboard session cookie', { Cookie: dashboardCookie }],
        ['an Authorization header', { Authorization: `Bearer sk_scantor_${randomBytes(24).toString('base64url')}` }],
        ['an X-API-Key header', { 'X-API-Key': `sk_scantor_${randomBytes(24).toString('base64url')}` }],
      ] as const) {
        const response = await originGet(origin, '/', headers)
        expect(response.status, label).toBe(401)
        expect(response.body, label).toContain('Not signed in')
      }

      // The dashboard never trusts the editor origin: a cookie-authenticated mutation from it is refused (the request
      // repeats the admin's current name, so it would change nothing even if it passed).
      const account = ok(await adminApi.getAccount(), 'getAccount')
      const fromEditor = await adminApi.call('updateAccount', { body: { name: account.name }, headers: { Origin: env.editorUrl } })
      expect(fromEditor.status).toBe(403)
    },
  )
})

test.describe('editor origin traffic', () => {
  test(
    'WebSockets need the editor origin, code-server sets no cookies, and every response carries the headers',
    { tag: ['@EDIT-011', '@EDIT-015'] },
    async ({ env, freshApi, freshUser, origin }) => {
      test.setTimeout(180_000)
      const { cookie } = await signedInEditor(freshApi)
      const auth = editorCookieHeader(cookie)

      // WebSocket upgrades: a foreign or missing Origin is refused before anything reaches code-server.
      for (const [label, headers, status] of [
        ['a foreign Origin', { ...auth, Origin: 'https://evil.example' }, 403],
        ['the dashboard origin', { ...auth, Origin: env.publicUrl }, 403],
        ['no Origin', { ...auth }, 403],
        ['no cookie', { Origin: env.editorUrl }, 401],
      ] as const) {
        const answer = await upgradeRequest(`${env.editorUrl}/`, headers)
        expect(answer.status, `${label}: ${answer.error}`).toBe(status)
      }
      const accepted = await upgradeRequest(`${env.editorUrl}/`, { ...auth, Origin: env.editorUrl })
      expect([401, 403, 421, 429, 502, 503]).not.toContain(accepted.status)

      // code-server sets a cookie when a connection token arrives in the query (VS Code's `vscode-tkn`, answered with a
      // 302), asked directly on its socket inside the container; through the proxy no Set-Cookie arrives.
      const tokenPath = `${WORKBENCH}&tkn=scantor-test`
      const direct = await execInEditor(freshUser.id, [
        'sh',
        '-c',
        `exec "$(command -v node || echo /usr/lib/code-server/lib/node)" -e "require('http').get({socketPath: '/run/scantor-editor/code.sock', path: '${tokenPath}'}, (r) => console.log(JSON.stringify({status: r.statusCode, cookies: r.headers['set-cookie'] || []})))"`,
      ])
      expect(direct.exitCode, direct.stderr).toBe(0)
      const directAnswer = JSON.parse(direct.stdout.trim()) as { status: number; cookies: string[] }
      expect(directAnswer.status).toBe(302)
      expect(directAnswer.cookies.some((cookie) => cookie.startsWith('vscode-tkn=scantor-test'))).toBe(true)
      const proxiedToken = await originGet(origin, tokenPath, auth)
      expect(proxiedToken.status).toBe(302)
      expect(proxiedToken.setCookies).toEqual([])
      for (const path of ['/logout', '/', WORKBENCH, '/healthz', '/manifest.json']) {
        const response = await originGet(origin, path, auth)
        expect(response.setCookies, path).toEqual([])
      }

      // Security headers on proxied responses, on /_auth and on the listener's own pages.
      const dashboardOrigin = new URL(env.publicUrl).origin
      // One request per path: a `/_auth` code is single use.
      const checkHeaders = async (path: string, headers: Record<string, string>, referrer: string, label: string) => {
        const response = await originGet(origin, path, headers)
        expect(response.values('content-security-policy'), label).toContain(`frame-ancestors 'self' ${dashboardOrigin}`)
        expect(response.headers['x-content-type-options'], label).toBe('nosniff')
        expect(response.headers['referrer-policy'], label).toBe(referrer)
        expect(response.headers['strict-transport-security'], label).toBe('max-age=31536000')
        return response
      }
      const proxied = await checkHeaders(WORKBENCH, auth, 'same-origin', 'proxied workbench')
      expect(proxied.status).toBe(200)
      // code-server's own policy stays next to the added frame-ancestors header.
      expect(proxied.values('content-security-policy').length).toBeGreaterThanOrEqual(2)
      const redirected = await checkHeaders('/', auth, 'same-origin', 'proxied redirect')
      expect(redirected.status).toBe(302)
      const unauthorized = await checkHeaders('/', {}, 'same-origin', '401 page')
      expect(unauthorized.status).toBe(401)
      expect(unauthorized.headers['cache-control']).toBe('no-store')
      const code = ok(await openEditorSession(freshApi), 'createEditorSession')
      const authPath = `${new URL(code.url).pathname}${new URL(code.url).search}`
      const handoff = await checkHeaders(authPath, {}, 'no-referrer', '/_auth')
      expect(handoff.status).toBe(302)
      expect(handoff.headers['cache-control']).toBe('no-store')
      const failedHandoff = await checkHeaders('/_auth?code=sec_unknown', {}, 'no-referrer', 'failed /_auth')
      expect(failedHandoff.status).toBe(401)
      await stopEditor(freshApi)
      const ended = await checkHeaders('/', auth, 'same-origin', '410 page')
      expect(ended.status).toBe(410)
    },
  )
})
