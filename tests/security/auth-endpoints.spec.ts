import { randomBytes, randomUUID } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import type { Account } from '#shared/types/account'
import type { NodeWithToken } from '#shared/types/nodes'
import { ApiClient, ok } from '../helpers/api-client'
import {
  ageSessions,
  dashboardListenerUrl,
  expandTemplate,
  jwtLikeToken,
  mintToolsCookie,
  operationsWithScope,
  rawRequest,
  sessionCookieOf,
  setCookiesOf,
  signInWithHeaders,
  TestUsers,
  unknownApiKey,
  withAuthTenants,
} from '../helpers/api-auth'
import { stackKeys } from '../helpers/keys'
import { reserve } from '../helpers/limiter'
import { newApiContext } from '../helpers/users'
import { expect, test as base, unique } from '../fixtures'

const test = withAuthTenants(base)

// The better-auth surface and credential binding (docs/auth.md §2.5, §2.6, §4.3, §5.2, §5.3, §6.2, §6.4; docs/api.md
// §3): disabled endpoints, endpoints outside the documented set, API keys and foreign bearer values on the wrong
// routes, credentials bound to their route prefix, the session cookie, the client IP, internal capabilities, the
// passkey freshness guard and the additional user fields. The sign-in rate limits run against a throwaway
// orchestrator in rate-limits.spec.ts.

interface Envelope {
  error?: { code?: string }
}

async function send(context: APIRequestContext, method: string, path: string, options: { headers?: Record<string, string>; data?: unknown } = {}) {
  const response = await context.fetch(path, { method, headers: options.headers, data: options.data, maxRedirects: 0 })
  const text = await response.text()
  let body: Envelope = {}
  try {
    body = JSON.parse(text) as Envelope
  } catch {
    // not JSON (better-auth's plain 404 page, redirects)
  }
  return { status: response.status(), body, text, headers: response.headers() }
}

/** better-auth paths disabled for HTTP (docs/auth.md §2.5), with the method each endpoint would answer. */
const DISABLED: [string, string][] = [
  ['POST', '/sign-up/email'],
  ['GET', '/token'],
  ['POST', '/api-key/create'],
  ['POST', '/api-key/update'],
  ['POST', '/api-key/delete'],
  ['GET', '/api-key/get'],
  ['GET', '/api-key/list'],
  ['POST', '/admin/ban-user'],
  ['POST', '/admin/create-user'],
  ['GET', '/admin/get-user'],
  ['POST', '/admin/has-permission'],
  ['POST', '/admin/impersonate-user'],
  ['POST', '/admin/list-user-sessions'],
  ['GET', '/admin/list-users'],
  ['POST', '/admin/remove-user'],
  ['POST', '/admin/revoke-user-session'],
  ['POST', '/admin/revoke-user-sessions'],
  ['POST', '/admin/set-role'],
  ['POST', '/admin/set-user-password'],
  ['POST', '/admin/stop-impersonating'],
  ['POST', '/admin/unban-user'],
  ['POST', '/admin/update-user'],
  ['POST', '/delete-user'],
  ['GET', '/delete-user/callback'],
  ['POST', '/request-password-reset'],
  ['POST', '/reset-password'],
  ['POST', '/send-verification-email'],
  ['GET', '/verify-email'],
  ['POST', '/sign-in/social'],
  ['POST', '/link-social'],
  ['POST', '/unlink-account'],
  ['POST', '/get-access-token'],
  ['POST', '/refresh-token'],
  ['GET', '/account-info'],
]

/**
 * Endpoints the configured plugins register that docs/api.md §3 does not list. Probed with empty bodies, so a
 * reachable endpoint answers a validation error (or harmless data) instead of acting. `GET /error` is not among them:
 * it is the documented page a failed OAuth authorization redirects to.
 */
const UNDOCUMENTED: [string, string][] = [
  ['GET', '/list-accounts'],
  ['POST', '/revoke-other-sessions'],
  ['POST', '/update-session'],
  ['POST', '/verify-password'],
  ['GET', '/ok'],
  ['GET', '/reset-password/some-token'],
  ['GET', '/callback/github'],
  ['GET', '/oauth2/get-clients'],
  ['GET', '/oauth2/get-client'],
  ['POST', '/oauth2/create-client'],
  ['POST', '/oauth2/update-client'],
  ['POST', '/oauth2/delete-client'],
  ['POST', '/oauth2/client/rotate-secret'],
  ['POST', '/oauth2/client/rotate-keys'],
  ['GET', '/oauth2/get-consents'],
  ['GET', '/oauth2/get-consent'],
  ['POST', '/oauth2/update-consent'],
  ['POST', '/oauth2/delete-consent'],
  ['POST', '/oauth2/end-session/confirm'],
  ['POST', '/admin/oauth2/create-client'],
  ['PATCH', '/admin/oauth2/update-client'],
  ['POST', '/admin/oauth2/resources'],
]

test.describe('better-auth endpoints', () => {
  test('every disabled better-auth path answers 404, also with a session', { tag: ['@AUTH-008'] }, async ({ api }) => {
    const problems: string[] = []
    for (const [method, path] of DISABLED) {
      const response = await send(api.request, method, `/api/auth${path}`, method === 'GET' ? {} : { data: {} })
      if (response.status !== 404) problems.push(`${method} ${path} → ${response.status} ${response.text.slice(0, 120)}`)
    }
    expect(problems).toEqual([])
    // Control: the session itself is valid on a documented endpoint.
    const session = await send(api.request, 'GET', '/api/auth/get-session')
    expect(session.status).toBe(200)
  })

  test('no better-auth endpoint beyond the documented ones is reachable with a session', { tag: ['@AUTH-008'] }, async ({ api }) => {
    const reachable: string[] = []
    for (const [method, path] of UNDOCUMENTED) {
      const response = await send(api.request, method, `/api/auth${path}`, method === 'GET' ? {} : { data: {} })
      if (response.status !== 404) reachable.push(`${method} ${path} → ${response.status}`)
    }
    expect(reachable).toEqual([])
  })

  test('API keys are rejected on /api/auth/* with the scantor envelope', { tag: ['@AUTH-004'] }, async ({ user }) => {
    const editorShaped = `sk_scantor_editor_${'E'.repeat(64)}`
    const credentials: Record<string, string>[] = [
      { 'x-api-key': user.apiKey },
      { Authorization: `Bearer ${user.apiKey}` },
      { 'x-api-key': editorShaped },
      { Authorization: `Bearer ${editorShaped}` },
      { 'x-api-key': unknownApiKey() },
    ]
    const endpoints: [string, string, unknown?][] = [
      ['GET', '/api/auth/get-session'],
      ['GET', '/api/auth/list-sessions'],
      ['POST', '/api/auth/update-user', { name: 'via-key' }],
      ['POST', '/api/auth/change-email', { newEmail: `${unique('via-key')}@scantor.test` }],
      ['GET', '/api/auth/passkey/generate-register-options'],
      ['POST', '/api/auth/oauth2/consent', { accept: true, scope: 'scantor:read' }],
      ['POST', '/api/auth/sign-out', {}],
    ]
    // Also with the owner's own session cookie next to the key.
    const withCookie = await newApiContext({ storageState: user.storageState })
    const bare = await newApiContext()
    try {
      for (const context of [bare, withCookie]) {
        for (const headers of credentials) {
          for (const [method, path, data] of endpoints) {
            const response = await send(context, method, path, { headers, data })
            const label = `${method} ${path} with ${Object.keys(headers)[0]}`
            expect(response.status, label).toBe(401)
            expect(response.body.error?.code, label).toBe('unauthorized')
            expect(response.headers['content-type'], label).toMatch(/^application\/json/)
          }
        }
      }
      // Control: the cookie alone is a session on better-auth, and nothing above changed the account.
      const session = await send(withCookie, 'GET', '/api/auth/get-session')
      expect(session.status).toBe(200)
      expect((session.body as unknown as { user: { name: string; email: string } }).user).toMatchObject({ name: user.name, email: user.email })
    } finally {
      await withCookie.dispose()
      await bare.dispose()
    }
  })
})

test.describe('credential binding', () => {
  test('a bearer value that is not an API key is 401 on every user route', { tag: ['@AUTH-003'] }, async ({ openapi, env }) => {
    // The admin session cookie rides along: an explicit (invalid) bearer must still decide alone.
    const cookie = sessionCookieOf(env.paths.adminState)
    const problems: string[] = []
    const bearers = [jwtLikeToken(), 'eyJhbGciOiJSUzI1NiJ9.e30.c2ln', 'opaque-token-value', 'snt_' + 'A'.repeat(43)]
    for (const bearer of bearers) {
      const context = await newApiContext({ headers: { Authorization: `Bearer ${bearer}`, Cookie: `${cookie.name}=${cookie.value}` } })
      try {
        for (const op of operationsWithScope(openapi, ['owner', 'admin'])) {
          const method = op.method.toUpperCase()
          const path = expandTemplate(op.path, {})
          const response = await send(context, method, path, method === 'GET' || method === 'DELETE' ? {} : { data: {} })
          if (response.status !== 401 || response.body.error?.code !== 'unauthorized')
            problems.push(`${method} ${path} (${op.operationId}) → ${response.status}`)
        }
      } finally {
        await context.dispose()
      }
    }
    expect(problems).toEqual([])
  })

  test('credentials are bound to their route prefix', { tag: ['@AUTH-007'] }, async ({ adminApi, user, openapi }) => {
    const created = ok(await adminApi.call<NodeWithToken>('createNode', { body: { name: unique('auth-007'), pool: unique('auth-pool') } }), 'createNode')
    try {
      const keys = stackKeys()
      const workerToken = keys.workerToken({ workerId: randomUUID(), scanId: randomUUID(), role: 'runner', nodeId: created.node.id })
      const machine: Record<string, Record<string, string>> = {
        'node token': { Authorization: `Bearer ${created.token}` },
        'built-in node token': { Authorization: `Bearer ${keys.builtinNodeToken()}` },
        'worker token': { Authorization: `Bearer ${workerToken}` },
        'setup token': { 'X-Scantor-Setup-Token': `sst_${randomBytes(32).toString('base64url')}` },
      }
      // Machine credentials on user routes.
      for (const [name, headers] of Object.entries(machine)) {
        const context = await newApiContext({ headers })
        try {
          const client = new ApiClient(context, openapi)
          for (const response of [
            await client.getAccount(),
            await client.call('listTasks'),
            await client.call('createUpload', { query: { name: 'x.txt' }, body: Buffer.from('x\n'), headers: { 'Content-Type': 'text/plain' } }),
          ]) {
            expect(response.status, name).toBe(401)
            expect((response.body as Envelope).error?.code, name).toBe('unauthorized')
          }
        } finally {
          await context.dispose()
        }
      }

      // User credentials (and a node token on the runtime prefix) on the machine routes.
      const wrongKind: [string, Record<string, string>, string[]][] = [
        ['session', {}, ['/api/node/assignments', '/api/runtime/bootstrap']],
        ['API key', { Authorization: `Bearer ${user.apiKey}` }, ['/api/node/assignments', '/api/runtime/bootstrap']],
        ['x-api-key', { 'x-api-key': user.apiKey }, ['/api/node/assignments', '/api/runtime/bootstrap']],
        ['node token', { Authorization: `Bearer ${created.token}` }, ['/api/runtime/bootstrap']],
      ]
      for (const [name, headers, paths] of wrongKind) {
        const context = await newApiContext({ storageState: name === 'session' ? user.storageState : undefined, headers })
        try {
          for (const path of paths) {
            const response = await send(context, 'GET', path)
            expect(response.status, `${name} on ${path}`).toBe(401)
            expect(response.body.error?.code, `${name} on ${path}`).toBe('unauthorized')
          }
        } finally {
          await context.dispose()
        }
      }

      // Control: the node token is accepted on its own prefix (validation of the empty body, not 401).
      const own = await newApiContext({ headers: { Authorization: `Bearer ${created.token}` } })
      try {
        const version = ok(await adminApi.getHealth(), 'getHealth').version
        const hello = await send(own, 'POST', '/api/node/hello', { data: {}, headers: { 'X-Scantor-Version': version } })
        expect(hello.status, hello.text).toBe(400)
        expect(hello.body.error?.code).toBe('validationFailed')
      } finally {
        await own.dispose()
      }
    } finally {
      const removed = await adminApi.call('deleteNode', { path: { nodeId: created.node.id } })
      expect([204, 404]).toContain(removed.status)
    }
  })

  test('an internal MCP capability from outside the orchestrator is 401', { tag: ['@AUTH-013'] }, async ({ user, openapi }) => {
    const capability = `sic_${randomBytes(32).toString('base64url')}`
    expect(capability).toMatch(/^sic_[A-Za-z0-9_-]{43}$/)
    // With and without the user's valid session cookie: the capability is an explicit credential and decides alone.
    for (const storageState of [undefined, user.storageState]) {
      const context = await newApiContext({ storageState, headers: { 'x-scantor-internal-auth': capability } })
      try {
        const client = new ApiClient(context, openapi)
        for (const response of [await client.getAccount(), await client.call('listScans'), await client.call('updateAccount', { body: { name: 'never' } })]) {
          expect(response.status).toBe(401)
          expect((response.body as Envelope).error?.code).toBe('unauthorized')
        }
      } finally {
        await context.dispose()
      }
    }
  })
})

test.describe('sessions', () => {
  const users = new TestUsers()
  test.afterEach(async ({ adminApi }) => users.cleanup(adminApi))

  test(
    'the session cookie is host-only and secure, the client IP is never taken from client headers, and sign-out clears the tools cookie',
    { tag: ['@AUTH-009', '@AUTH-012', '@AUTH-019', '@USER-003'] },
    async ({ adminApi, env }) => {
      const admin = await users.create(adminApi, { prefix: 'cookie', role: 'admin' })
      const spoofed = '203.0.113.7'
      const forwarded = '198.51.100.9'

      // Sign-in through Traefik with spoofed client IP headers.
      const context = await users.context()
      const response = await signInWithHeaders(context, admin.email, admin.password, { 'x-scantor-client-ip': spoofed, 'X-Forwarded-For': forwarded })
      expect(response.status(), await response.text()).toBe(200)
      const session = setCookiesOf(response).find((c) => c.name.endsWith('scantor.session_token'))
      expect(session, 'a session cookie is set').toBeTruthy()
      expect(session!.name).toBe('__Secure-scantor.session_token')
      expect(session!.attributes).not.toHaveProperty('domain')
      expect(session!.attributes.path).toBe('/')
      expect(session!.attributes).toHaveProperty('httponly')
      expect(session!.attributes).toHaveProperty('secure')
      expect(session!.attributes.samesite?.toLowerCase()).toBe('lax')
      const lifetime = session!.attributes['max-age'] ? Number(session!.attributes['max-age']) : (Date.parse(session!.attributes.expires!) - Date.now()) / 1000
      expect(Math.abs(lifetime - 7 * 86_400)).toBeLessThanOrEqual(120)
      const stored = (await context.storageState()).cookies.find((c) => c.name === session!.name)!
      expect(stored.domain, 'host-only: never sent to the editor, S3, registry or tool hosts').toBe(env.domain)
      expect(stored.secure && stored.httpOnly).toBe(true)

      // A second sign-in straight to the dashboard listener with a forwarded chain: the rightmost entry is the client.
      await reserve('/sign-in/email')
      const direct = await rawRequest(`${dashboardListenerUrl()}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: {
          Host: env.domain,
          Origin: env.publicUrl,
          'Content-Type': 'application/json',
          'X-Forwarded-For': `${spoofed}, 198.51.100.1, 198.51.100.2`,
          'x-scantor-client-ip': spoofed,
        },
        body: JSON.stringify({ email: admin.email, password: admin.password }),
      })
      expect(direct.status, direct.text()).toBe(200)

      const sessions = (await (await context.get('/api/auth/list-sessions')).json()) as { ipAddress?: string | null }[]
      const addresses = sessions.map((s) => s.ipAddress)
      expect(addresses).toHaveLength(2)
      expect(addresses).toContain('198.51.100.2')
      expect(addresses).not.toContain(spoofed)
      // Traefik overwrites client-supplied forwarded headers, so the session through it carries the real peer.
      expect(addresses).not.toContain(forwarded)
      expect(addresses.every((address) => typeof address === 'string' && address.length > 0)).toBe(true)

      // The tools cookie of this admin session is cleared by signing out.
      const client = new ApiClient(context, adminApi.openapi)
      const tools = await mintToolsCookie(client)
      expect(tools.attributes.domain).toBe(env.domain)
      const signOut = await context.post('/api/auth/sign-out', { data: {} })
      expect(signOut.status(), await signOut.text()).toBe(200)
      const cleared = setCookiesOf(signOut)
      const toolsCleared = cleared.find((c) => c.name === 'scantor_tools')
      expect(toolsCleared, JSON.stringify(signOut.headersArray())).toBeTruthy()
      expect(toolsCleared!.value).toBe('')
      expect(toolsCleared!.attributes.domain).toBe(env.domain)
      expect(toolsCleared!.attributes['max-age']).toBe('0')
      expect(toolsCleared!.attributes.path).toBe('/')
      const sessionCleared = cleared.find((c) => c.name === '__Secure-scantor.session_token')
      expect(sessionCleared?.value ?? '').toBe('')
      expect((await client.getAccount()).status).toBe(401)
    },
  )

  test(
    'passkey registration needs a fresh session, and better-auth cannot set the admin fields',
    { tag: ['@AUTH-015', '@USER-012'] },
    async ({ adminApi, openapi, anonApi }) => {
      const owner = await users.signedIn(adminApi, openapi, { prefix: 'fresh' })

      // better-auth's own update-user changes the name but none of the admin-only fields.
      const forbidden: Record<string, unknown>[] = [{ canRunPrivileged: true }, { maxWorkers: 99 }, { role: 'admin' }, { banned: true }]
      for (const body of forbidden) {
        const response = await owner.api.request.post('/api/auth/update-user', { data: body })
        expect(response.status(), `${JSON.stringify(body)}: ${await response.text()}`).toBeGreaterThanOrEqual(400)
      }
      const renamed = await owner.api.request.post('/api/auth/update-user', { data: { name: 'Renamed Via Better Auth' } })
      expect(renamed.status(), await renamed.text()).toBe(200)
      const account = ok(await owner.api.getAccount(), 'getAccount') as Account
      expect(account).toMatchObject({ name: 'Renamed Via Better Auth', role: 'user', canRunPrivileged: false, maxWorkers: 0 })
      expect(ok(await adminApi.getUser(owner.id), 'getUser')).toMatchObject({ role: 'user', banned: false, canRunPrivileged: false })

      // A fresh session may start a registration.
      const options = await owner.api.request.get('/api/auth/passkey/generate-register-options')
      expect(options.status(), await options.text()).toBe(200)

      // Without a session and without a setup context: 401.
      const anonymous = await send(anonApi.request, 'GET', '/api/auth/passkey/generate-register-options')
      expect(anonymous.status).toBe(401)
      expect(anonymous.body.error?.code).toBe('unauthorized')

      // A session older than 24 h may not register a passkey.
      await ageSessions(owner.id, 25)
      for (const [method, path] of [
        ['GET', '/api/auth/passkey/generate-register-options'],
        ['POST', '/api/auth/passkey/verify-registration'],
      ] as const) {
        const response = await send(owner.api.request, method, path, method === 'POST' ? { data: { response: {} } } : {})
        expect(response.status, `${method} ${path}: ${response.text}`).toBe(403)
        expect(response.body.error?.code).toBe('sessionRequired')
      }
      // The aged session still works for everything else.
      expect((await owner.api.getAccount()).status).toBe(200)
    },
  )
})
