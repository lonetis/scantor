import { randomUUID, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { request, type APIRequestContext, type APIResponse } from '@playwright/test'
import { amqpHandshake, s3SignedHeaders, tlsPeer } from '../helpers/authz-net'
import { stackEnv } from '../helpers/docker'
import { stackKeys } from '../helpers/keys'
import { createUser, deleteUser } from '../helpers/users'
import { expect, test } from '../fixtures'

// The stack's Traefik (docs/deployment.md §7, docs/testing.md §8.6): the http entrypoint redirects permanently to
// https, the operator's default certificate (the test CA's wildcard) is served for every host and for the SNI TCP
// router, each host routes to its target, and the admin tools (the Traefik dashboard among them) sit behind forwardAuth.

type Tool = 'traefik' | 'rabbitmq' | 'mongo-express' | 'rustfs'

/** Traefik routes of docs/deployment.md §7.3 and how each target answers a plain GET without credentials. */
const TOOLS: Tool[] = ['traefik', 'rabbitmq', 'mongo-express', 'rustfs']

/** A request context without any stored state or default headers (no Origin, no cookies). */
async function bareContext(): Promise<APIRequestContext> {
  return request.newContext({ extraHTTPHeaders: {} })
}

/** The `scantor_tools` cookie value from a Set-Cookie header. */
function toolsCookieFrom(response: { headers: Record<string, string> }): string {
  const value = /(?:^|\n)scantor_tools=([^;\n]+)/.exec(response.headers['set-cookie'] ?? '')?.[1]
  if (!value) throw new Error(`no scantor_tools cookie in ${JSON.stringify(response.headers)}`)
  return value
}

/** forwardAuth's rejection: 401 with a short text/plain body, never the JSON envelope (docs/auth.md §11). */
async function expectForwardAuthRejection(response: APIResponse, what: string): Promise<void> {
  expect(response.status(), what).toBe(401)
  expect(response.headers()['content-type'], what).toMatch(/^text\/plain/)
  expect((await response.text()).length, what).toBeLessThan(200)
}

test.describe('Traefik', () => {
  // Only the seeded admin's session (worker-scoped, no sign-in) is needed.
  test.use({ storageState: { cookies: [], origins: [] } })

  let bare: APIRequestContext
  test.beforeEach(async () => {
    bare = await bareContext()
  })
  test.afterEach(async () => {
    await bare.dispose()
  })

  test('http:// redirects permanently to https:// on every host', { tag: ['@OPS-006'] }, async ({ env }) => {
    for (const host of [env.domain, `editor.${env.domain}`, `registry.${env.domain}`, `s3.${env.domain}`, `rabbitmq.${env.domain}`, `traefik.${env.domain}`]) {
      const response = await bare.get(`http://${host}/some/path?probe=1`, { maxRedirects: 0 })
      expect.soft([301, 308], `${host}: ${response.status()}`).toContain(response.status())
      expect.soft(response.headers()['location'], host).toBe(`https://${host}/some/path?probe=1`)
    }
    // A redirect is permanent for every method; a POST keeps its method and body with 308.
    const post = await bare.post(`http://${env.domain}/api/health`, { maxRedirects: 0, data: {} })
    expect([301, 308]).toContain(post.status())
    expect(post.headers()['location']).toBe(`https://${env.domain}/api/health`)
  })

  test("the test CA's wildcard certificate is served for every host and the SNI TCP router", { tag: ['@OPS-006'] }, async ({ env }) => {
    const ca = new X509Certificate(readFileSync(env.caCertFile))
    const wildcard = new X509Certificate(readFileSync(join(env.paths.stack, 'traefik', 'dynamic', 'wildcard.crt')))
    expect(wildcard.checkIssued(ca) && wildcard.verify(ca.publicKey), 'the wildcard certificate is issued by the test CA').toBe(true)
    expect(wildcard.subjectAltName).toContain(`DNS:${env.domain}`)
    expect(wildcard.subjectAltName).toContain(`DNS:*.${env.domain}`)

    const hosts = [
      env.domain,
      ...['editor', 'registry', 's3', 'rustfs', 'rabbitmq', 'mongo-express', 'traefik', 'git'].map((sub) => `${sub}.${env.domain}`),
      // the AMQP TCP router (HostSNI, TLS terminated by Traefik)
      `amqp.${env.domain}`,
      // a name without a router still gets the default certificate
      `no-router-${randomUUID().slice(0, 8)}.${env.domain}`,
    ]
    for (const host of hosts) {
      const peer = await tlsPeer(host)
      expect.soft(peer.authorized, host).toBe(true)
      expect.soft(peer.certificate.fingerprint256, `${host} serves the default certificate`).toBe(wildcard.fingerprint256)
    }
  })

  test("the Traefik dashboard API is reachable only with an admin's tools cookie", { tag: ['@OPS-006'] }, async ({ env, adminApi }) => {
    const api = `https://traefik.${env.domain}/api/rawdata`
    await expectForwardAuthRejection(await bare.get(api), 'without a cookie')

    const browser = await bare.get(api, { headers: { Accept: 'text/html' }, maxRedirects: 0 })
    expect(browser.status(), 'a browser is sent to mint a cookie').toBe(302)
    expect(browser.headers()['location']).toBe(`${env.publicUrl}/api/tools/session?target=traefik`)

    // A correctly signed cookie of a user who is not an admin.
    const plain = await createUser(adminApi, { prefix: 'traefik-plain' })
    try {
      const now = Math.floor(Date.now() / 1000)
      const forged = stackKeys().toolsCookie({ iss: 'scantor', aud: 'tools', sub: plain.id, role: 'admin', iat: now, exp: now + 600, jti: randomUUID() })
      await expectForwardAuthRejection(await bare.get(api, { headers: { Cookie: `scantor_tools=${forged}` } }), "a non-admin's cookie")
    } finally {
      await deleteUser(adminApi, plain.id)
    }

    const session = await adminApi.call('createToolsSession', { query: { target: 'traefik' } })
    expect(session.status).toBe(302)
    expect(session.headers['location']).toBe(`https://traefik.${env.domain}/dashboard/`)
    const cookie = toolsCookieFrom(session)
    const allowed = await bare.get(api, { headers: { Cookie: `scantor_tools=${cookie}` } })
    expect(allowed.status()).toBe(200)
    const rawdata = (await allowed.json()) as { routers?: Record<string, unknown> }
    expect(Object.keys(rawdata.routers ?? {})).toEqual(expect.arrayContaining(['scantor@docker', 'scantor-editor@docker', 'traefik@docker']))
  })

  test.describe('routing', () => {
    test('the apex host reaches the orchestrator', { tag: ['@OPS-007'] }, async ({ env }) => {
      const response = await bare.get(`https://${env.domain}/api/health`)
      expect(response.status()).toBe(200)
      const health = (await response.json()) as { status: string; components: Record<string, string> }
      expect(Object.keys(health.components).sort()).toEqual(['mongo', 'rabbitmq', 'registry', 's3'])
      const page = await bare.get(`https://${env.domain}/login`)
      expect(page.status()).toBe(200)
      expect(await page.text()).toMatch(/<div id="__nuxt"[ >]/)
    })

    test('the editor host reaches the editor listener, not the API', { tag: ['@OPS-007'] }, async ({ env }) => {
      for (const path of ['/', '/api/health']) {
        const response = await bare.get(`${env.editorUrl}${path}`)
        expect(response.status(), path).toBe(401)
        expect(response.headers()['content-type'], path).toMatch(/^text\/html/)
        expect(await response.text(), path).toContain('Not signed in')
        expect(response.headers()['content-security-policy'], path).toContain(`frame-ancestors 'self' ${env.publicUrl}`)
      }
    })

    test('the registry host reaches the registry with token auth', { tag: ['@OPS-007'] }, async ({ env }) => {
      const response = await bare.get(`https://registry.${env.domain}/v2/`)
      expect(response.status()).toBe(401)
      expect(response.headers()['docker-distribution-api-version']).toBe('registry/2.0')
      expect(response.headers()['www-authenticate']).toContain(`realm="${env.publicUrl}/api/registry/token"`)
    })

    test('the s3 host reaches the object store with the Host header preserved', { tag: ['@OPS-007'] }, async ({ env }) => {
      const stack = stackEnv()
      const url = new URL(`https://s3.${env.domain}/${stack.SCANTOR_S3_BUCKET}?list-type=2&max-keys=1`)
      // SigV4 signs the Host header: the request only verifies when the object store sees s3.<domain>.
      const signed = await bare.get(url.toString(), {
        headers: s3SignedHeaders('GET', url, { accessKey: stack.SCANTOR_S3_ACCESS_KEY!, secretKey: stack.SCANTOR_S3_SECRET_KEY!, region: 'us-east-1' }),
      })
      expect(signed.status(), await signed.text()).toBe(200)
      expect(await signed.text()).toContain('<ListBucketResult')

      const unsigned = await bare.get(url.toString())
      expect(unsigned.status()).toBe(403)
      expect(await unsigned.text()).toContain('AccessDenied')
    })

    for (const tool of TOOLS) {
      test(`the ${tool} host is reached only through forwardAuth`, { tag: ['@OPS-007'] }, async ({ env, adminApi }) => {
        const host = `https://${tool}.${env.domain}`
        await expectForwardAuthRejection(await bare.get(`${host}/`, { maxRedirects: 0 }), `${tool} without a cookie`)
        const browser = await bare.get(`${host}/`, { headers: { Accept: 'text/html' }, maxRedirects: 0 })
        expect(browser.status()).toBe(302)
        expect(browser.headers()['location']).toBe(`${env.publicUrl}/api/tools/session?target=${tool}`)

        const session = await adminApi.call('createToolsSession', { query: { target: tool } })
        expect(session.status).toBe(302)
        const cookie = toolsCookieFrom(session)
        const target = new URL(session.headers['location']!)
        expect(target.origin).toBe(host)
        const reached = await bare.get(target.toString(), { headers: { Cookie: `scantor_tools=${cookie}`, Accept: 'text/html' }, maxRedirects: 0 })
        // Past forwardAuth the tool answers itself; mongo-express still asks for its own credentials.
        switch (tool) {
          case 'traefik':
          case 'rabbitmq':
          case 'rustfs':
            expect(reached.status(), `${tool} ${target.pathname}`).toBe(200)
            expect(reached.headers()['content-type']).toMatch(/^text\/html/)
            break
          case 'mongo-express':
            expect(reached.status()).toBe(401)
            expect(reached.headers()['www-authenticate']).toMatch(/^Basic /)
            break
        }
        if (tool === 'rabbitmq') expect(await reached.text()).toContain('RabbitMQ')
      })
    }

    test('the amqp host is a TLS TCP router to RabbitMQ', { tag: ['@OPS-007'] }, async ({ env }) => {
      const frame = await amqpHandshake(`amqp.${env.domain}`)
      // A connection.start method frame (type 1, channel 0, class 10, method 10) of AMQP 0-9 from RabbitMQ.
      expect(frame[0]).toBe(1)
      expect(frame.readUInt16BE(1)).toBe(0)
      expect(frame.readUInt16BE(7)).toBe(10)
      expect(frame.readUInt16BE(9)).toBe(10)
      expect([frame[11], frame[12]]).toEqual([0, 9])
      expect(frame.includes(Buffer.from('RabbitMQ'))).toBe(true)
      expect(frame[frame.length - 1], 'frame end').toBe(0xce)
    })
  })
})
