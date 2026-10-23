import { randomUUID } from 'node:crypto'
import { request, type APIRequestContext } from '@playwright/test'
import { ApiClient } from '../helpers/api-client'
import { hostRequest } from '../helpers/api-platform-editor'
import { withPlatformAdmin, withWorkerTenant } from '../helpers/api-platform-tenant'
import { temporaryApiKey, unsignedUser } from '../helpers/api-platform-users'
import { stackKeys } from '../helpers/keys'
import { newApiContext } from '../helpers/users'
import { expect, test as base, unique } from '../fixtures'

// The admin tools (docs/auth.md §11, docs/api.md §4.18, docs/deployment.md §7.5): createToolsSession mints the
// `scantor_tools` cookie for a signed-in admin, Traefik's forwardAuth middleware asks /api/tools/forward-auth on every
// request to a tool host, and the tools keep their own credentials behind it. forwardAuth is called here twice over:
// directly on the dashboard listener (the runner's loopback port 3000, as Traefik calls it, so the forwarded headers
// can be chosen) and through Traefik on the tool hosts. Cookies of other users and broken cookies are minted with
// helpers/keys.ts; the seeded admin's session only mints cookies and is never changed.

const test = base.extend<{ bare: APIRequestContext; plainUser: { id: string } }>({
  // An admin of the worker and a tenant with a uniquely named session (helpers/api-platform-tenant.ts).
  adminApi: [async ({ openapi }, use) => withPlatformAdmin(openapi, use), { scope: 'worker', timeout: 150_000 }],
  user: [
    async ({ adminApi, openapi }, use, workerInfo) => withWorkerTenant(adminApi, openapi, `w${workerInfo.workerIndex}`, use),
    { scope: 'worker', timeout: 150_000 },
  ],
  // A context without stored state or default headers: no session cookie, no Origin.
  bare: async ({}, use) => {
    const context = await request.newContext({ extraHTTPHeaders: {} })
    await use(context)
    await context.dispose()
  },
  // A user who never signs in: tools cookies for it are minted with helpers/keys.ts.
  plainUser: async ({ adminApi }, use) => {
    const plain = await unsignedUser(adminApi, { prefix: 'tools-plain', role: 'user' })
    try {
      await use(plain)
    } finally {
      await plain.dispose()
    }
  },
})

// Only the seeded admin's session is needed; a tenant (one sign-in) is created only for the test that uses `api`.
test.use({ storageState: { cookies: [], origins: [] } })

type Target = 'traefik' | 'rabbitmq' | 'mongo-express' | 'rustfs'
const TARGETS: Target[] = ['traefik', 'rabbitmq', 'mongo-express', 'rustfs']
const TOOL_PATHS: Record<Target, string> = { traefik: '/dashboard/', rabbitmq: '/', 'mongo-express': '/', rustfs: '/rustfs/console/' }
const COOKIE_TTL_S = 28_800
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The `scantor_tools` cookie value from a Set-Cookie header. */
function toolsCookieOf(setCookie: string | undefined): string {
  const value = /(?:^|\n)scantor_tools=([^;\n]+)/.exec(setCookie ?? '')?.[1]
  if (!value) throw new Error(`no scantor_tools cookie in ${setCookie}`)
  return value
}

/** A tools cookie minted with the stack's key (helpers/keys.ts); `claims` override the valid admin claims. */
function mintedCookie(userId: string, claims: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000)
  return stackKeys().toolsCookie({ iss: 'scantor', aud: 'tools', sub: userId, role: 'admin', iat: now, exp: now + 600, jti: randomUUID(), ...claims })
}

/** forwardAuth as Traefik calls it: on the dashboard listener, with the forwarded host and the client's headers. */
async function forwardAuth(forwardedHost: string | null, headers: Record<string, string> = {}) {
  return hostRequest(3000, '/api/tools/forward-auth', 'orchestrator:3000', {
    ...(forwardedHost === null ? {} : { 'X-Forwarded-Host': forwardedHost, 'X-Forwarded-Proto': 'https', 'X-Forwarded-Uri': '/', 'X-Forwarded-Method': 'GET' }),
    ...headers,
  })
}

/** forwardAuth's refusal: 401 with a short text/plain body, never the JSON envelope. */
function expectRefusal(answer: { status: number; headers: Record<string, string | string[] | undefined>; body: string }, label: string): void {
  expect(answer.status, label).toBe(401)
  expect(String(answer.headers['content-type']), label).toMatch(/^text\/plain/)
  expect(answer.body.length, label).toBeLessThan(200)
  expect(answer.body, label).not.toContain('"error"')
  expect(answer.headers['x-scantor-user'], label).toBeUndefined()
}

test.describe('createToolsSession', () => {
  test('an admin session gets a 302 to the tool with the tools cookie on the domain', { tag: ['@TOOLS-001'] }, async ({ adminApi, env }) => {
    const admin = (await adminApi.getAccount()).body
    for (const target of TARGETS) {
      const before = Math.floor(Date.now() / 1000)
      const response = await adminApi.call('createToolsSession', { query: { target } })
      expect(response.status, target).toBe(302)
      expect(response.headers['location'], target).toBe(`https://${target}.${env.domain}${TOOL_PATHS[target]}`)
      expect(response.headers['cache-control'], target).toBe('no-store')
      const setCookie = response.headers['set-cookie'] ?? ''
      const attributes = setCookie.split(';').map((part) => part.trim())
      expect(attributes.slice(1).sort(), target).toEqual(
        [`Domain=${env.domain}`, 'HttpOnly', `Max-Age=${COOKIE_TTL_S}`, 'Path=/', 'SameSite=Lax', 'Secure'].sort(),
      )

      // The cookie is an HS256 JWT of the admin, signed with the tools-cookie key.
      const token = toolsCookieOf(setCookie)
      const [header, claims, signature] = token.split('.') as [string, string, string]
      expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' })
      const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString()) as Record<string, number | string>
      expect(decoded).toEqual({
        iss: 'scantor',
        aud: 'tools',
        sub: admin.id,
        role: 'admin',
        iat: expect.any(Number),
        exp: expect.any(Number),
        jti: expect.stringMatching(UUID),
      })
      expect(Number(decoded.exp) - Number(decoded.iat)).toBe(COOKIE_TTL_S)
      expect(Math.abs(Number(decoded.iat) - before)).toBeLessThan(30)
      expect(signature).toBe(stackKeys().toolsCookieSignature(`${header}.${claims}`))
    }
  })

  test('API keys, non-admins, anonymous callers and invalid targets are refused', { tag: ['@TOOLS-001'] }, async ({ adminApi, anonApi, api, openapi }) => {
    const key = await temporaryApiKey(adminApi, unique('tools-key'))
    const context = await newApiContext({ headers: { Authorization: `Bearer ${key.key}` } })
    try {
      const withKey = await new ApiClient(context, openapi).call('createToolsSession', { query: { target: 'rabbitmq' } })
      expect(withKey.status).toBe(403)
      expect(withKey.body).toMatchObject({ error: { code: 'sessionRequired' } })
      expect(withKey.headers['set-cookie']).toBeUndefined()
    } finally {
      await context.dispose()
      await key.dispose()
    }

    const user = await api.call('createToolsSession', { query: { target: 'rabbitmq' } })
    expect(user.status).toBe(403)
    expect(user.body).toMatchObject({ error: { code: 'adminRequired' } })
    expect(user.headers['set-cookie']).toBeUndefined()

    const anonymous = await anonApi.call('createToolsSession', { query: { target: 'rabbitmq' } })
    expect(anonymous.status).toBe(401)

    for (const query of [{ target: 'mongo' }, { target: 'scantor' }, { target: 'RabbitMQ' }, {}, { target: 'rabbitmq', next: '/x' }]) {
      const response = await adminApi.call('createToolsSession', { query })
      expect(response.status, JSON.stringify(query)).toBe(400)
      expect(response.body, JSON.stringify(query)).toMatchObject({ error: { code: 'validationFailed' } })
      expect(response.headers['set-cookie'], JSON.stringify(query)).toBeUndefined()
    }
  })
})

test.describe('forwardAuth', () => {
  test('a valid admin cookie on a tool host is allowed with X-Scantor-User', { tag: ['@TOOLS-002'] }, async ({ adminApi, env }) => {
    const admin = (await adminApi.getAccount()).body
    const cookie = toolsCookieOf((await adminApi.call('createToolsSession', { query: { target: 'rabbitmq' } })).headers['set-cookie'])
    for (const host of [...TARGETS.map((target) => `${target}.${env.domain}`), `rabbitmq.${env.domain}:443`, `RabbitMQ.${env.domain.toUpperCase()}`]) {
      const answer = await forwardAuth(host, { Cookie: `scantor_tools=${cookie}` })
      expect(answer.status, host).toBe(200)
      expect(answer.headers['x-scantor-user'], host).toBe(admin.id)
      expect(String(answer.headers['content-type']), host).toMatch(/^text\/plain/)
    }
    // The cookie among others, as browsers send it.
    const among = await forwardAuth(`traefik.${env.domain}`, { Cookie: `theme=dark; scantor_tools=${cookie}; other=1` })
    expect(among.status).toBe(200)
    // An expiry inside the 30 s leeway still passes.
    const leeway = await forwardAuth(`rabbitmq.${env.domain}`, {
      Cookie: `scantor_tools=${mintedCookie(admin.id, { exp: Math.floor(Date.now() / 1000) - 5 })}`,
    })
    expect(leeway.status).toBe(200)
  })

  test(
    'other hosts and missing, expired, forged or non-admin cookies get 401 text; browsers are sent to the session',
    { tag: ['@TOOLS-002'] },
    async ({ adminApi, env, plainUser }) => {
      const admin = (await adminApi.getAccount()).body
      const cookie = toolsCookieOf((await adminApi.call('createToolsSession', { query: { target: 'rabbitmq' } })).headers['set-cookie'])
      const valid = { Cookie: `scantor_tools=${cookie}` }

      // Hosts other than the four tool hosts: 401 even with a valid cookie, and never a redirect.
      for (const host of [
        env.domain,
        `editor.${env.domain}`,
        `s3.${env.domain}`,
        `registry.${env.domain}`,
        `mongo.${env.domain}`,
        `rabbitmq.${env.domain}.evil.example`,
        `evil.example`,
        `x.rabbitmq.${env.domain}`,
        `rabbitmq.${env.domain}, traefik.${env.domain}`,
      ]) {
        expectRefusal(await forwardAuth(host, valid), host)
        expectRefusal(await forwardAuth(host, { ...valid, Accept: 'text/html' }), `${host} (browser)`)
      }
      expectRefusal(await forwardAuth(null, valid), 'no X-Forwarded-Host')

      const now = Math.floor(Date.now() / 1000)
      const [header, claims] = cookie.split('.') as [string, string, string]
      const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${claims}.`
      const tampered = `${header}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(claims, 'base64url').toString()), sub: plainUser.id })).toString('base64url')}.${cookie.split('.')[2]}`
      const refused: [string, Record<string, string>][] = [
        ['no cookie', {}],
        ['an empty cookie', { Cookie: 'scantor_tools=' }],
        ['an expired cookie', { Cookie: `scantor_tools=${mintedCookie(admin.id, { iat: now - 7200, exp: now - 60 })}` }],
        ['a cookie signed with another key', { Cookie: `scantor_tools=${header}.${claims}.${Buffer.alloc(32, 7).toString('base64url')}` }],
        ['claims changed after signing', { Cookie: `scantor_tools=${tampered}` }],
        ['alg none', { Cookie: `scantor_tools=${none}` }],
        ['another audience', { Cookie: `scantor_tools=${mintedCookie(admin.id, { aud: 'editor' })}` }],
        ['another issuer', { Cookie: `scantor_tools=${mintedCookie(admin.id, { iss: 'someone' })}` }],
        ["a user's correctly signed cookie", { Cookie: `scantor_tools=${mintedCookie(plainUser.id)}` }],
        ['an unknown user', { Cookie: `scantor_tools=${mintedCookie(randomUUID())}` }],
        ['the dashboard session cookie only', { Cookie: 'better-auth.session_token=abc' }],
      ]
      for (const [label, headers] of refused) {
        expectRefusal(await forwardAuth(`rabbitmq.${env.domain}`, headers), label)
        const browser = await forwardAuth(`rabbitmq.${env.domain}`, { ...headers, Accept: 'text/html,application/xhtml+xml' })
        expect(browser.status, `${label} (browser)`).toBe(302)
        expect(browser.headers['location'], `${label} (browser)`).toBe(`${env.publicUrl}/api/tools/session?target=rabbitmq`)
      }
      for (const target of TARGETS) {
        const browser = await forwardAuth(`${target}.${env.domain}`, { Accept: 'text/html' })
        expect(browser.headers['location'], target).toBe(`${env.publicUrl}/api/tools/session?target=${target}`)
      }
    },
  )

  test('an admin banned a moment ago is refused at once', { tag: ['@TOOLS-002'] }, async ({ adminApi, env }) => {
    const admin = await unsignedUser(adminApi, { prefix: 'tools-ban', role: 'admin' })
    try {
      const cookie = { Cookie: `scantor_tools=${mintedCookie(admin.id)}` }
      const allowed = await forwardAuth(`mongo-express.${env.domain}`, cookie)
      expect(allowed.status).toBe(200)
      expect(allowed.headers['x-scantor-user']).toBe(admin.id)

      expect((await adminApi.call('banUser', { path: { userId: admin.id }, body: { reason: 'tools cookie test' } })).status).toBe(200)
      expectRefusal(await forwardAuth(`mongo-express.${env.domain}`, cookie), 'banned admin')
      const browser = await forwardAuth(`mongo-express.${env.domain}`, { ...cookie, Accept: 'text/html' })
      expect(browser.status).toBe(302)
    } finally {
      await admin.dispose()
    }
  })
})

test.describe('tool hosts through Traefik', () => {
  test('every tool host needs an admin tools cookie', { tag: ['@TOOLS-003'] }, async ({ adminApi, bare, env, plainUser }) => {
    const cookie = toolsCookieOf((await adminApi.call('createToolsSession', { query: { target: 'traefik' } })).headers['set-cookie'])
    for (const target of TARGETS) {
      const url = `https://${target}.${env.domain}${TOOL_PATHS[target]}`
      const anonymous = await bare.get(url, { maxRedirects: 0 })
      expect(anonymous.status(), target).toBe(401)
      expect(anonymous.headers()['content-type'], target).toMatch(/^text\/plain/)
      const browser = await bare.get(url, { headers: { Accept: 'text/html' }, maxRedirects: 0 })
      expect(browser.status(), target).toBe(302)
      expect(browser.headers()['location'], target).toBe(`${env.publicUrl}/api/tools/session?target=${target}`)
      const nonAdmin = await bare.get(url, { headers: { Cookie: `scantor_tools=${mintedCookie(plainUser.id)}` }, maxRedirects: 0 })
      expect(nonAdmin.status(), target).toBe(401)

      // With the admin's cookie the request passes forwardAuth and reaches the tool (the redirect of the rustfs
      // console root is the tool's own).
      const admitted = await bare.get(url, { headers: { Cookie: `scantor_tools=${cookie}` }, maxRedirects: 0 })
      expect([200, 401], `${target}: ${admitted.status()}`).toContain(admitted.status())
      expect(admitted.headers()['content-type'] ?? '', target).not.toMatch(/^text\/plain/)
    }
  })

  test('a client-supplied X-Forwarded-Host is ignored', { tag: ['@TOOLS-003'] }, async ({ adminApi, bare, env }) => {
    const cookie = toolsCookieOf((await adminApi.call('createToolsSession', { query: { target: 'rabbitmq' } })).headers['set-cookie'])
    // On the dashboard host, Traefik replaces the claimed tool host with the real one: refused despite a valid cookie.
    const spoofed = await bare.get(`${env.publicUrl}/api/tools/forward-auth`, {
      headers: { Cookie: `scantor_tools=${cookie}`, 'X-Forwarded-Host': `rabbitmq.${env.domain}` },
      maxRedirects: 0,
    })
    expect(spoofed.status()).toBe(401)
    expect(spoofed.headers()['x-scantor-user']).toBeUndefined()
    // On a tool host, claiming another host changes nothing either way.
    const admitted = await bare.get(`https://rabbitmq.${env.domain}/`, {
      headers: { Cookie: `scantor_tools=${cookie}`, 'X-Forwarded-Host': env.domain },
      maxRedirects: 0,
    })
    expect(admitted.status()).toBe(200)
    expect(await admitted.text()).toContain('RabbitMQ')
    const anonymous = await bare.get(`https://rabbitmq.${env.domain}/`, { headers: { 'X-Forwarded-Host': `traefik.${env.domain}` }, maxRedirects: 0 })
    expect(anonymous.status()).toBe(401)
  })

  test('behind the cookie each tool still asks for its own credentials', { tag: ['@TOOLS-003'] }, async ({ adminApi, bare, env }) => {
    const cookie = toolsCookieOf((await adminApi.call('createToolsSession', { query: { target: 'rabbitmq' } })).headers['set-cookie'])
    const headers = { Cookie: `scantor_tools=${cookie}` }

    const rabbitmq = await bare.get(`https://rabbitmq.${env.domain}/api/overview`, { headers, maxRedirects: 0 })
    expect(rabbitmq.status()).toBe(401)
    expect(rabbitmq.headers()['www-authenticate']).toMatch(/^Basic realm="RabbitMQ Management"/)

    const mongoExpress = await bare.get(`https://mongo-express.${env.domain}/`, { headers, maxRedirects: 0 })
    expect(mongoExpress.status()).toBe(401)
    expect(mongoExpress.headers()['www-authenticate']).toMatch(/^Basic /)

    const rustfs = await bare.get(`https://rustfs.${env.domain}/rustfs/admin/v3/info`, { headers, maxRedirects: 0 })
    expect(rustfs.status()).toBe(403)
    expect(await rustfs.text()).toContain('AccessDenied')
  })
})
