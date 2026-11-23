import type { APIRequestContext } from '@playwright/test'
import type { Account, CreatedApiKey } from '#shared/types/account'
import type { SetupStatus } from '#shared/types/instance'
import type { Upload } from '#shared/types/uploads'
import { ApiClient, ok } from '../helpers/api-client'
import { setCookiesOf, stackValue } from '../helpers/api-auth'
import { settleScan, UNPLACEABLE_SETTINGS } from '../helpers/api-results'
import { apiResultsTest } from '../helpers/api-results-fixtures'
import { scantor } from '../helpers/cli'
import { newTunnelContext, signInThroughTunnel } from '../helpers/tunnel'
import { newApiContext } from '../helpers/users'
import { expect, test as fixturesTest, unique } from '../fixtures'

// The Cloudflare Tunnel as a second origin (docs/architecture.md §11.9, docs/auth.md §4.5, docs/api.md §4.1): the test
// stack's stand-in tunnel serves the tunnel URL and forwards to orchestrator:3000 (docs/testing.md §7.3). Through it
// the dashboard, the REST API and /mcp answer like on the public URL, with the instance info, sessions, CSRF, security
// headers, passkeys and `wait` of the tunnel origin. Peers, hosts and the refused prefixes are security/tunnel.spec.ts,
// the MCP server mcp/tunnel.spec.ts and the dashboard ui/tunnel.spec.ts.

// The resultset task of the api-results specs, for an unsettled scan that a wait can hold on.
const test = apiResultsTest(fixturesTest)

/** Runs `use` with a context, disposed afterwards. */
async function withContext<T>(context: Promise<APIRequestContext>, use: (context: APIRequestContext) => Promise<T>): Promise<T> {
  const created = await context
  try {
    return await use(created)
  } finally {
    await created.dispose()
  }
}

/** A tunnel context that authenticates with an API key. */
function keyedTunnelContext(apiKey: string): Promise<APIRequestContext> {
  return newTunnelContext({ headers: { Authorization: `Bearer ${apiKey}` } })
}

test.describe('the tunnel URL', () => {
  test('serves the dashboard, the REST API and /mcp', { tag: ['@TUNNEL-001'] }, async ({ env, openapi, user }) => {
    await withContext(newTunnelContext(), async (anonymous) => {
      const health = await anonymous.get('/api/health')
      expect(health.status()).toBe(200)
      expect(((await health.json()) as { status: string }).status).toBe('ok')
      for (const page of ['/', '/login']) {
        const shell = await anonymous.get(page)
        expect(shell.status(), page).toBe(200)
        expect(shell.headers()['content-type'], page).toMatch(/^text\/html/)
      }
      expect((await anonymous.get('/api/docs/openapi.json')).status()).toBe(200)
      const mcp = await anonymous.post('/mcp', {
        headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
        data: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      })
      expect(mcp.status()).toBe(401)
      expect(mcp.headers()['www-authenticate']).toContain(`${env.tunnelUrl}/.well-known/oauth-protected-resource/mcp`)
    })

    await withContext(keyedTunnelContext(user.apiKey), async (context) => {
      const api = new ApiClient(context, openapi)
      expect(ok(await api.getAccount(), 'getAccount').id).toBe(user.id)
      expect((await api.listTasks()).status).toBe(200)
      // Uploads go through the orchestrator, so they work through the tunnel; only presigned downloads need the public URL.
      const name = `${unique('tunnel-upload')}.txt`
      const upload = ok(
        await api.call<Upload>('createUpload', {
          body: Buffer.from('tunnel.example\n'),
          headers: { 'Content-Type': 'text/plain' },
          query: { name, kind: 'list' },
        }),
        'createUpload',
      )
      expect(upload.name).toBe(name)
      expect((await api.call('deleteUpload', { path: { uploadId: upload.id } })).status).toBe(204)
    })
  })

  test('getInstanceInfo and getSetupStatus describe the origin of the request', { tag: ['@TUNNEL-006', '@PLAT-003'] }, async ({ env, openapi, api, user }) => {
    const info = await withContext(keyedTunnelContext(user.apiKey), async (context) =>
      ok(await new ApiClient(context, openapi).getInstanceInfo(), 'getInstanceInfo'),
    )
    const canonical = ok(await api.getInstanceInfo(), 'getInstanceInfo')
    expect(info.origin).toBe('tunnel')
    // The canonical URLs stay those of the public URL; the MCP URL follows the origin.
    expect(info).toMatchObject({ publicUrl: env.publicUrl, tunnelUrl: env.tunnelUrl, editorUrl: env.editorUrl, mcpUrl: env.tunnelMcpUrl })
    expect(info.features).toEqual({ passkeys: true, mcp: true, mcpOAuth: true, editor: false, downloads: false })
    expect(info.limits).toEqual({ ...canonical.limits, waitMaxSeconds: 90 })
    expect({ ...info, origin: canonical.origin, mcpUrl: canonical.mcpUrl, features: canonical.features, limits: canonical.limits }).toEqual(canonical)
    expect(canonical).toMatchObject({ origin: 'public', tunnelUrl: env.tunnelUrl, mcpUrl: env.mcpUrl })
    expect(canonical.features).toMatchObject({ editor: true, downloads: true })

    await withContext(newTunnelContext(), async (anonymous) => {
      expect((await anonymous.get('/api/info')).status()).toBe(401)
      const setup = (await (await anonymous.get('/api/setup/status')).json()) as SetupStatus
      expect(setup).toEqual({ needsSetup: false, passkeysEnabled: true, mcpUrl: env.tunnelMcpUrl })
    })

    // The CLI with SCANTOR_URL set to the tunnel URL sees the tunnel origin.
    const instance = await scantor(['instance', '-o', 'json'], { token: user.apiKey, env: { SCANTOR_URL: env.tunnelUrl } })
    expect(instance.exitCode, instance.stderr).toBe(0)
    expect(instance.json).toEqual(info)
    const text = await scantor(['instance'], { token: user.apiKey, env: { SCANTOR_URL: env.tunnelUrl } })
    expect(text.exitCode, text.stderr).toBe(0)
    expect(text.stdout).toMatch(/^origin\s+tunnel$/m)
    expect(text.stdout).toMatch(new RegExp(`^tunnel url\\s+${env.tunnelUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
  })

  test('session cookies, CSRF and better-auth’s origin check are per origin', { tag: ['@TUNNEL-005', '@AUTH-005'] }, async ({ env, openapi, user }) => {
    const tunnel = await newTunnelContext()
    const publicSession = await newApiContext({ storageState: user.storageState })
    try {
      const signedIn = await signInThroughTunnel(tunnel, user.email, user.password)
      expect(signedIn.status(), await signedIn.text()).toBe(200)
      const cookie = setCookiesOf(signedIn).find((c) => c.name.endsWith('scantor.session_token'))
      expect(cookie, 'a session cookie is set').toBeTruthy()
      expect(cookie!.name).toBe('__Secure-scantor.session_token')
      expect(cookie!.attributes).not.toHaveProperty('domain')
      expect(cookie!.attributes).toHaveProperty('secure')
      expect(cookie!.attributes).toHaveProperty('httponly')
      const stored = (await tunnel.storageState()).cookies.find((c) => c.name === cookie!.name)!
      expect(stored.domain, 'host-only for the tunnel host').toBe(new URL(env.tunnelUrl).hostname)

      // A cookie-authenticated mutation through the tunnel needs the tunnel origin; the public origin is foreign there.
      const throughTunnel = new ApiClient(tunnel, openapi)
      const name = unique('tunnel-key').slice(0, 32)
      const refused = await throughTunnel.call('createApiKey', { body: { name, expiresInDays: 1 }, headers: { Origin: env.publicUrl } })
      expect(refused.status).toBe(403)
      expect((refused.body as { error: { code: string } }).error.code).toBe('forbidden')
      const created = ok(await throughTunnel.call<CreatedApiKey>('createApiKey', { body: { name, expiresInDays: 1 } }), 'createApiKey')
      try {
        // ...and the tunnel origin is foreign on the public URL.
        const crossed = await new ApiClient(publicSession, openapi).call('createApiKey', {
          body: { name, expiresInDays: 1 },
          headers: { Origin: env.tunnelUrl },
        })
        expect(crossed.status).toBe(403)
        expect((crossed.body as { error: { code: string } }).error.code).toBe('forbidden')
      } finally {
        expect((await throughTunnel.call('deleteApiKey', { path: { keyId: created.apiKey.id } })).status).toBe(204)
      }
      // better-auth's own origin check (its /api/auth/* routes) trusts only the request's origin as well.
      const nameOf = async (context: APIRequestContext) => ok(await new ApiClient(context, openapi).call<Account>('getAccount'), 'getAccount').name
      const before = await nameOf(publicSession)
      for (const [context, foreign] of [
        [tunnel, env.publicUrl],
        [publicSession, env.tunnelUrl],
      ] as const) {
        const renamed = await context.post('/api/auth/update-user', { data: { name: 'renamed across origins' }, headers: { Origin: foreign } })
        expect(renamed.status(), `Origin ${foreign}: ${await renamed.text()}`).toBe(403)
      }
      expect(await nameOf(tunnel)).toBe(before)
      expect(await nameOf(publicSession)).toBe(before)

      // Browsers keep the tunnel session's host-only cookie away from the public URL...
      expect((await tunnel.get(`${env.publicUrl}/api/account`)).status()).toBe(401)
      // ...but the server does not bind a session to its origin (the instances share the session store): replayed by a
      // client, the tunnel's cookie works on the public URL (where it has the same name, both origins being https).
      await withContext(newApiContext({ headers: { Cookie: `${cookie!.name}=${cookie!.value}` } }), async (replay) => {
        expect((await replay.get('/api/account')).status()).toBe(200)
      })
      const signedOut = await tunnel.post('/api/auth/sign-out', { data: {} })
      expect(signedOut.status(), await signedOut.text()).toBe(200)
      expect((await throughTunnel.getAccount()).status).toBe(401)
      // The public session of the same user is untouched.
      expect((await new ApiClient(publicSession, openapi).getAccount()).status).toBe(200)
    } finally {
      await tunnel.dispose()
      await publicSession.dispose()
    }
  })

  test('responses carry the security headers of their origin', { tag: ['@TUNNEL-008'] }, async ({ env }) => {
    const editorOrigin = new URL(env.editorUrl).origin
    const s3Origin = new URL(stackValue('SCANTOR_S3_PUBLIC_URL')).origin
    const tunnel = await newTunnelContext()
    const publicContext = await newApiContext()
    try {
      for (const path of ['/', '/login', '/api/health']) {
        const throughTunnel = await tunnel.get(path)
        const headers = throughTunnel.headers()
        expect(headers['strict-transport-security'], path).toBe('max-age=31536000')
        const csp = headers['content-security-policy'] ?? ''
        expect(csp, path).toContain("frame-src 'none'")
        expect(csp, path).not.toContain(editorOrigin)
        expect(csp, path).not.toContain(s3Origin)

        const publicCsp = (await publicContext.get(path)).headers()['content-security-policy'] ?? ''
        expect(publicCsp, path).toContain(`frame-src ${editorOrigin}`)
        expect(publicCsp, path).toMatch(new RegExp(`img-src [^;]*${s3Origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
      }
    } finally {
      await tunnel.dispose()
      await publicContext.dispose()
    }
  })

  test('passkeys use the tunnel host as relying party through the tunnel URL', { tag: ['@TUNNEL-015'] }, async ({ env }) => {
    const rpIdOf = async (context: APIRequestContext) => {
      const response = await context.get('/api/auth/passkey/generate-authenticate-options')
      expect(response.status(), await response.text()).toBe(200)
      return ((await response.json()) as { rpId?: string }).rpId
    }
    await withContext(newTunnelContext(), async (tunnel) => expect(await rpIdOf(tunnel)).toBe(new URL(env.tunnelUrl).hostname))
    await withContext(newApiContext(), async (anonymous) => expect(await rpIdOf(anonymous)).toBe(env.domain))
  })

  test('a wait through the tunnel URL ends after at most 90 s', { tag: ['@TUNNEL-007', '@API-012'] }, async ({ openapi, api, user, resultset }) => {
    // Cloudflare answers 524 when no response starts within its 125 s Proxy Read Timeout; the API's own limit is 120 s.
    test.setTimeout(300_000)
    const scan = await resultset.start({ scanConfig: { items: ['a'] }, settings: UNPLACEABLE_SETTINGS })
    await settleScan(api, scan.id, 'running', 60_000)
    await withContext(keyedTunnelContext(user.apiKey), async (context) => {
      const started = Date.now()
      const held = await new ApiClient(context, openapi).getScan(scan.id, 120)
      const elapsedMs = Date.now() - started
      expect(held.status).toBe(200)
      expect(held.headers['scantor-wait']).toBe('timeout')
      expect(held.body.state).toBe('running')
      expect(elapsedMs).toBeGreaterThanOrEqual(89_000)
      expect(elapsedMs).toBeLessThan(100_000)
    })
  })
})
