import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, defineEventHandler, toNodeListener } from 'h3'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../../../server/utils/config'

// MCP OAuth per origin (docs/auth.md §2.2, §4.5; docs/mcp.md §3; security.md TUN-5, TUN-6) with the real better-auth
// instances of server/utils/auth.ts on an in-memory database: the discovery documents, the `/mcp` challenge and the
// accepted tokens belong to the origin of the request, and the token and authorize endpoints refuse a `resource` of
// the other origin. The routes run behind a listener whose requests are tunnel requests when they carry the tunnel host.

const { db, state } = vi.hoisted(() => ({
  // The memory adapter needs every model's table up front; the oauth-provider seeds its resources at startup.
  db: Object.fromEntries(
    [
      'user',
      'session',
      'account',
      'verification',
      'apikey',
      'passkey',
      'jwks',
      'oauthClient',
      'oauthResource',
      'oauthClientResource',
      'oauthRefreshToken',
      'oauthAccessToken',
      'oauthConsent',
      'oauthClientAssertion',
    ].map((model) => [model, [] as unknown[]]),
  ) as Record<string, unknown[]>,
  /** whether the next request comes from cloudflared */
  state: { fromCloudflared: false },
}))

vi.mock('better-auth/adapters/mongodb', async () => {
  const { memoryAdapter } = await import('better-auth/adapters/memory')
  return { mongodbAdapter: () => memoryAdapter(db) }
})
vi.mock('../../../server/utils/mongo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/utils/mongo')>()),
  useMongo: () => ({ db: {}, client: {} }),
}))
vi.mock('../../../server/utils/guide-assets', () => ({ readGuide: async () => null }))
vi.mock('../../../server/utils/trusted-proxy', () => ({
  proxyTrust: () => () => false,
  useTrustedProxies: () => ({ isHostPeer: (host: string) => host === 'cloudflared' && state.fromCloudflared }),
}))
/** The claims of every access token that passed requireMcpAuth; the principal lookup then refuses it (401 revoked). */
const verifiedClaims: Record<string, unknown>[] = []
vi.mock('../../../server/services/mcp/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/mcp/auth')>()),
  principalFromToken: async (claims: Record<string, unknown>) => {
    verifiedClaims.push(claims)
    return null
  },
}))

const { default: wellKnownRoute } = await import('../../../server/routes/.well-known/[...path]')
const { default: mcpRoute } = await import('../../../server/routes/mcp')
const { default: authRoute } = await import('../../../server/api/auth/[...all]')
const { linkOAuthClientsToMcpResources, useAuth } = await import('../../../server/utils/auth')
const { resetBootRegistry, runBoot } = await import('../../../server/utils/boot')
const { parseConfig, setConfigForTesting } = await import('../../../server/utils/config')
const { closeLoopbackListener, setLoopbackHandler } = await import('../../../server/utils/loopback')
const { useLogger } = await import('../../../server/utils/logger')

const PUBLIC = 'https://scantor.example.com'
const TUNNEL = 'https://tunnel.example.org'
const ORIGINS = [
  ['public', PUBLIC, TUNNEL],
  ['tunnel', TUNNEL, PUBLIC],
] as const

let server: Server | null = null
let port = 0

beforeAll(async () => {
  setConfigForTesting(parseConfig({ SCANTOR_PUBLIC_URL: PUBLIC, SCANTOR_EDITOR_URL: 'https://editor.example.com', SCANTOR_TUNNEL_URL: TUNNEL }).config)
  resetBootRegistry()
  await runBoot({ config: () => ({ components: [] }) as unknown as Config, log: useLogger('test') })
  // Should a better-auth update add a model, its table is added before the first request.
  for (const origin of ['public', 'tunnel'] as const) {
    for (const table of Object.values((await useAuth(origin).$context).tables as Record<string, { modelName: string }>)) db[table.modelName] ??= []
  }
  // The routes as Nitro mounts them; the same app serves the loopback listener (the JWKS fetch of /mcp).
  const app = createApp()
  app.use(
    defineEventHandler((event) => {
      const path = event.path.split('?')[0]!
      if (path.startsWith('/.well-known/')) return wellKnownRoute(event)
      if (path === '/mcp') return mcpRoute(event)
      if (path.startsWith('/api/auth/')) return authRoute(event)
    }),
  )
  setLoopbackHandler(toNodeListener(app))
  server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  await closeLoopbackListener()
  setLoopbackHandler(null)
  setConfigForTesting(null)
  resetBootRegistry()
})

beforeEach(() => {
  verifiedClaims.length = 0
})

interface Answer {
  status: number
  headers: Record<string, string | string[] | undefined>
  text: string
}

/** A request for `origin`: through the tunnel (cloudflared, tunnel host) or on the public URL. */
function send(origin: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  state.fromCloudflared = origin === TUNNEL
  return new Promise((resolve, reject) => {
    const headers = { host: new URL(origin).host, ...init.headers }
    const req = request({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(init.body)
  })
}

async function json(origin: string, path: string): Promise<Record<string, unknown>> {
  const answer = await send(origin, path)
  expect(answer.status, `${origin}${path}`).toBe(200)
  return JSON.parse(answer.text) as Record<string, unknown>
}

describe('discovery per origin', () => {
  it.each(ORIGINS)('names the %s issuer and resource, and never the other origin', async (_name, origin, other) => {
    const resource = await json(origin, '/.well-known/oauth-protected-resource/mcp')
    expect(resource).toMatchObject({ resource: `${origin}/mcp`, authorization_servers: [`${origin}/api/auth`], resource_name: 'scantor' })
    const server = await json(origin, '/.well-known/oauth-authorization-server/api/auth')
    expect(server).toMatchObject({ issuer: `${origin}/api/auth`, jwks_uri: `${origin}/api/auth/jwks` })
    const openid = await json(origin, '/.well-known/openid-configuration/api/auth')
    expect(openid).toMatchObject({ issuer: `${origin}/api/auth` })
    for (const document of [resource, server, openid]) expect(JSON.stringify(document)).not.toContain(new URL(other).host)
  })
})

describe('/mcp per origin', () => {
  /** An access token as the OAuth provider of `issuer` mints it for `audience` (the signing keys are shared). */
  async function accessToken(issuer: string, audience: string): Promise<string> {
    const { token } = (await useAuth('public').api.signJWT({
      body: { payload: { sub: 'user-1', azp: 'client-1', client_id: 'client-1', scope: 'scantor:read', iss: `${issuer}/api/auth`, aud: `${audience}/mcp` } },
    })) as { token: string }
    return token
  }

  function callMcp(origin: string, token?: string): Promise<Answer> {
    return send(origin, '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
  }

  it.each(ORIGINS)('challenges a %s request without a token with that origin’s metadata', async (_name, origin, other) => {
    const answer = await callMcp(origin)
    expect(answer.status).toBe(401)
    const challenge = String(answer.headers['www-authenticate'])
    expect(challenge).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`)
    expect(challenge).not.toContain(new URL(other).host)
  })

  it.each(ORIGINS)('accepts on the %s origin only its own tokens', async (_name, origin, other) => {
    // Its own token passes the verification and reaches the per-request checks (which refuse the unknown user).
    const own = await callMcp(origin, await accessToken(origin, origin))
    expect(own.status).toBe(401)
    expect(JSON.parse(own.text).error.message).toMatch(/^Access revoked/)
    expect(verifiedClaims).toEqual([expect.objectContaining({ sub: 'user-1', iss: `${origin}/api/auth`, aud: `${origin}/mcp` })])

    // The other origin's token, and tokens that mix issuer and audience, fail the verification itself: a challenge
    // that points to this origin's metadata, and no per-request check.
    for (const [issuer, audience] of [
      [other, other],
      [origin, other],
      [other, origin],
    ] as const) {
      const answer = await callMcp(origin, await accessToken(issuer, audience))
      expect(answer.status, `${issuer} → ${audience}`).toBe(401)
      expect(JSON.parse(answer.text).error.message).not.toMatch(/^Access revoked/)
      expect(String(answer.headers['www-authenticate'])).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`)
    }
    expect(verifiedClaims).toHaveLength(1)
  })
})

describe('the resource of OAuth requests per origin', () => {
  /** True when the answer is the hook's 400 invalid_target. */
  function refusedTarget(answer: Answer): boolean {
    if (answer.status !== 400) return false
    try {
      return (JSON.parse(answer.text) as { error?: string }).error === 'invalid_target'
    } catch {
      return false
    }
  }

  function token(origin: string, resources: string[]): Promise<Answer> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'no-such-code',
      client_id: 'no-such-client',
      redirect_uri: 'http://localhost:53682/cb',
    })
    for (const resource of resources) body.append('resource', resource)
    return send(origin, '/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
  }

  function authorize(origin: string, resource: string): Promise<Answer> {
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: 'no-such-client',
      redirect_uri: 'http://localhost:53682/cb',
      scope: 'scantor:read',
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
      resource,
    })
    return send(origin, `/api/auth/oauth2/authorize?${query}`)
  }

  it.each(ORIGINS)('refuses on the %s origin a resource of the other origin with 400 invalid_target', async (_name, origin, other) => {
    const refused = await token(origin, [`${other}/mcp`])
    expect(refusedTarget(refused), refused.text).toBe(true)
    expect(JSON.parse(refused.text).error_description).toBe(`${other}/mcp is not a resource of this origin`)
    expect(refusedTarget(await token(origin, [`${origin}/mcp`, `${other}/mcp`]))).toBe(true)
    expect(refusedTarget(await token(origin, [`${other}/api/auth/oauth2/userinfo`]))).toBe(true)
    expect(refusedTarget(await token(origin, ['https://evil.example/mcp']))).toBe(true)
    expect(refusedTarget(await authorize(origin, `${other}/mcp`))).toBe(true)
  })

  it.each(ORIGINS)('leaves the %s origin’s own resources to better-auth', async (_name, origin) => {
    for (const resources of [[`${origin}/mcp`], [`${origin}/api/auth/oauth2/userinfo`], [`${origin}/mcp`, `${origin}/api/auth/oauth2/userinfo`], []]) {
      const answer = await token(origin, resources)
      expect(refusedTarget(answer), `${resources.join(' ')}: ${answer.text}`).toBe(false)
      // The missing PKCE verifier, the unknown client or code is better-auth's own refusal.
      expect(answer.status).toBeGreaterThanOrEqual(400)
    }
    // A failed authorization goes to the error page of its own origin.
    const authorized = await authorize(origin, `${origin}/mcp`)
    expect(refusedTarget(authorized)).toBe(false)
    expect(authorized.status).toBe(302)
    expect(String(authorized.headers.location).startsWith(`${origin}/api/auth/error?`), String(authorized.headers.location)).toBe(true)
  })
})

describe('OAuth clients shared by the origins', () => {
  it.each(ORIGINS)('links a client registered through the %s origin to the /mcp of both origins', async (_name, origin, other) => {
    const registered = await send(origin, '/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'shared', redirect_uris: ['http://127.0.0.1:53682/callback'], token_endpoint_auth_method: 'none' }),
    })
    expect(registered.status, registered.text).toBeLessThan(300)
    const { client_id: clientId } = JSON.parse(registered.text) as { client_id: string }
    // better-auth issues a token only for a resource the client is linked to, so a client of one origin would get
    // 400 invalid_target on the other's authorize endpoint without the link.
    const links = (db.oauthClientResource as { clientId: string; resourceId: string }[]).filter((link) => link.clientId === clientId)
    expect(links.map((link) => link.resourceId).sort()).toEqual([`${origin}/mcp`, `${other}/mcp`].sort())
  })

  it('holds one resource row per origin: the boot builds the instances one after another, so no seed runs twice', () => {
    // The unique index on `identifier` exists only after the boot's ensureAuthIndexes, so concurrent seeds would
    // insert each row twice (and the index could never be built).
    const identifiers = (db.oauthResource as { identifier: string }[]).map((row) => row.identifier)
    expect(identifiers.sort()).toEqual([`${PUBLIC}/mcp`, `${TUNNEL}/mcp`])
  })

  /** An authorization request of a registered client through `origin` (no session: better-auth sends it to sign in). */
  function authorizeClient(origin: string, clientId: string): Promise<Answer> {
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:53682/callback',
      scope: 'scantor:read',
      state: 'state-1',
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
      resource: `${origin}/mcp`,
    })
    return send(origin, `/api/auth/oauth2/authorize?${query}`)
  }

  it('links a client registered before the tunnel URL was set to the tunnel’s /mcp at boot (idempotent)', async () => {
    const registered = await send(PUBLIC, '/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'older', redirect_uris: ['http://127.0.0.1:53682/callback'], token_endpoint_auth_method: 'none' }),
    })
    expect(registered.status, registered.text).toBeLessThan(300)
    const { client_id: clientId } = JSON.parse(registered.text) as { client_id: string }
    // As registered before SCANTOR_TUNNEL_URL was set: linked to the public /mcp only.
    const rows = db.oauthClientResource as { clientId: string; resourceId: string }[]
    rows.splice(
      rows.findIndex((link) => link.clientId === clientId && link.resourceId === `${TUNNEL}/mcp`),
      1,
    )
    const linksOf = () =>
      rows
        .filter((link) => link.clientId === clientId)
        .map((link) => link.resourceId)
        .sort()
    expect(linksOf()).toEqual([`${PUBLIC}/mcp`])
    // better-auth refuses such a client through the tunnel, with a redirect to the client that it does not retry.
    const refused = await authorizeClient(TUNNEL, clientId)
    expect(refused.status).toBe(302)
    expect(String(refused.headers.location)).toContain('error=invalid_target')

    expect(await linkOAuthClientsToMcpResources(useLogger('test'))).toBe(1)
    expect(linksOf()).toEqual([`${PUBLIC}/mcp`, `${TUNNEL}/mcp`])
    expect(await linkOAuthClientsToMcpResources(useLogger('test'))).toBe(0)
    expect(linksOf()).toHaveLength(2)

    // Now the tunnel's authorize endpoint takes the client and only asks the user to sign in.
    const accepted = await authorizeClient(TUNNEL, clientId)
    expect(accepted.status).toBe(302)
    expect(String(accepted.headers.location)).not.toContain('error=')
    expect(String(accepted.headers.location)).toContain('/login?')
  })
})

describe('better-auth per origin', () => {
  it.each(ORIGINS)('the %s instance trusts only its own origin', async (name, origin, other) => {
    const { trustedOrigins } = (await useAuth(name).$context) as { trustedOrigins: string[] }
    expect(trustedOrigins).toContain(origin)
    expect(trustedOrigins).not.toContain(other)
  })

  it.each(ORIGINS)('refuses on the %s origin a cookie request whose Origin is the other origin', async (_name, origin, other) => {
    // better-auth's own origin check runs before the endpoint for every cookie request, so no session is needed.
    const signOut = (from: string) =>
      send(origin, '/api/auth/sign-out', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'scantor.session_token=none', origin: from },
        body: JSON.stringify({}),
      })
    const crossed = await signOut(other)
    expect(crossed.status, crossed.text).toBe(403)
    expect(JSON.parse(crossed.text).code).toBe('INVALID_ORIGIN')
    const own = await signOut(origin)
    expect(own.status, own.text).toBe(200)
  })

  it.each(ORIGINS)('gives the %s instance its own passkey relying party and expected WebAuthn origin', async (name, origin) => {
    const { options } = (await useAuth(name).$context) as { options: { plugins: { id: string; options?: Record<string, unknown> }[] } }
    expect(options.plugins.find((plugin) => plugin.id === 'passkey')?.options).toMatchObject({ rpID: new URL(origin).hostname, origin })
  })
})
