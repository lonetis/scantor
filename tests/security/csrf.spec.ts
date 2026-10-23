import type { APIRequestContext } from '@playwright/test'
import type { NodeWithToken } from '#shared/types/nodes'
import { ok } from '../helpers/api-client'
import { contextWithoutOrigin, withAuthTenants } from '../helpers/api-auth'
import { expect, test as base, unique } from '../fixtures'

const test = withAuthTenants(base)

// CSRF and CORS (docs/auth.md §4.2, security.md AUTH-3): cookie-authenticated mutations need the public origin in
// `Origin`; the editor origin is never trusted; API keys and machine tokens are not ambient and need no Origin; no
// dashboard route answers cross-origin requests with credentials, and only the documented credential-less routes
// allow any origin.

interface Answer {
  status: number
  code?: string
  headers: Record<string, string>
}

async function send(context: APIRequestContext, method: string, path: string, headers: Record<string, string>, data?: unknown): Promise<Answer> {
  const response = await context.fetch(path, { method, headers, data, maxRedirects: 0 })
  const text = await response.text()
  let code: string | undefined
  try {
    code = (JSON.parse(text) as { error?: { code?: string } }).error?.code
  } catch {
    // not JSON
  }
  return { status: response.status(), code, headers: response.headers() }
}

const FOREIGN_ORIGINS = ['https://evil.example', 'null', 'http://scantor.localhost', 'https://scantor.localhost:8443', 'https://sub.scantor.localhost']

test.describe('CSRF', () => {
  test('cookie-authenticated mutations need the public origin', { tag: ['@AUTH-005'] }, async ({ user, api, env }) => {
    const context = await contextWithoutOrigin({ storageState: user.storageState })
    const editorOrigin = new URL(env.editorUrl).origin
    try {
      const probes: [string, string, unknown?][] = [
        ['PATCH', '/api/account', { name: 'csrf was here' }],
        ['POST', '/api/account/api-keys', { name: 'csrf-key' }],
        ['DELETE', '/api/account/api-keys/00000000-0000-4000-8000-000000000000'],
        ['PUT', `/api/tasks/${unique('csrf')}/files`, { files: { 'a.txt': 'x' } }],
        ['POST', `/api/scans/00000000-0000-4000-8000-000000000000/pause`, {}],
      ]
      const variants: [string, Record<string, string>][] = [
        ['no Origin', {}],
        ['the editor origin', { Origin: editorOrigin }],
        ...FOREIGN_ORIGINS.map((origin): [string, Record<string, string>] => [origin, { Origin: origin }]),
      ]
      for (const [label, headers] of variants) {
        for (const [method, path, data] of probes) {
          const answer = await send(context, method, path, headers, data)
          expect(answer.status, `${method} ${path} with ${label}`).toBe(403)
          expect(answer.code, `${method} ${path} with ${label}`).toBe('forbidden')
        }
      }
      // Safe methods need no Origin.
      expect((await send(context, 'GET', '/api/account', {})).status).toBe(200)

      // The public origin passes the check and reaches the handlers.
      const allowed = { Origin: env.publicUrl }
      expect((await send(context, 'PATCH', '/api/account', allowed, { name: user.name })).status).toBe(200)
      expect((await send(context, 'DELETE', '/api/account/api-keys/00000000-0000-4000-8000-000000000000', allowed)).status).toBe(404)
      expect((await send(context, 'POST', '/api/scans/00000000-0000-4000-8000-000000000000/pause', allowed, {})).status).toBe(404)
    } finally {
      await context.dispose()
    }
    // Nothing the rejected requests carried was applied.
    expect(ok(await api.getAccount(), 'getAccount').name).toBe(user.name)
    const keys = ok(await api.call<{ items: { name: string | null }[] }>('listApiKeys'), 'listApiKeys').items
    expect(keys.map((key) => key.name)).not.toContain('csrf-key')
  })

  test('better-auth refuses cookie-authenticated requests from foreign origins', { tag: ['@AUTH-005'] }, async ({ user, api, env }) => {
    const context = await contextWithoutOrigin({ storageState: user.storageState })
    try {
      for (const origin of [new URL(env.editorUrl).origin, 'https://evil.example']) {
        const answer = await send(context, 'POST', '/api/auth/update-user', { Origin: origin }, { name: 'renamed by csrf' })
        expect(answer.status, origin).toBe(403)
      }
    } finally {
      await context.dispose()
    }
    expect(ok(await api.getAccount(), 'getAccount').name).toBe(user.name)
  })

  test('API keys and machine tokens need no Origin', { tag: ['@AUTH-005'] }, async ({ user, adminApi, api }) => {
    const keyContext = await contextWithoutOrigin({ headers: { Authorization: `Bearer ${user.apiKey}` } })
    const created = ok(await adminApi.call<NodeWithToken>('createNode', { body: { name: unique('csrf-node'), pool: unique('csrf-pool') } }), 'createNode')
    const nodeContext = await contextWithoutOrigin({ headers: { Authorization: `Bearer ${created.token}` } })
    try {
      const variants: Record<string, string>[] = [{}, { Origin: 'https://evil.example' }]
      for (const headers of variants) {
        const name = unique('csrf-upload')
        const upload = await keyContext.fetch('/api/uploads', {
          method: 'POST',
          params: { name: `${name}.txt` },
          headers: { ...headers, 'Content-Type': 'text/plain' },
          data: Buffer.from(`${name}\n`),
        })
        expect(upload.status(), await upload.text()).toBe(201)
        const { id } = (await upload.json()) as { id: string }
        expect((await send(keyContext, 'DELETE', `/api/uploads/${id}`, headers)).status).toBe(204)
        expect((await send(keyContext, 'PATCH', '/api/account', headers, { name: user.name })).status).toBe(200)
      }
      // A node token reaches the node API's own validation without an Origin.
      const version = ok(await adminApi.getHealth(), 'getHealth').version
      const hello = await send(nodeContext, 'POST', '/api/node/hello', { 'X-Scantor-Version': version }, {})
      expect(hello.status).toBe(400)
      expect(hello.code).toBe('validationFailed')
    } finally {
      await keyContext.dispose()
      await nodeContext.dispose()
      const removed = await adminApi.call('deleteNode', { path: { nodeId: created.node.id } })
      expect([204, 404]).toContain(removed.status)
    }
    expect(ok(await api.getAccount(), 'getAccount').name).toBe(user.name)
  })
})

test.describe('CORS', () => {
  test('no dashboard route answers cross-origin requests with credentials', { tag: ['@AUTH-006'] }, async ({ user }) => {
    const context = await contextWithoutOrigin({ storageState: user.storageState })
    const evil = 'https://evil.example'
    try {
      const requests: [string, string, Record<string, string>][] = [
        ['GET', '/api/account', { Origin: evil }],
        ['GET', '/api/info', { Origin: evil }],
        ['GET', '/api/health', { Origin: evil }],
        ['GET', '/api/docs/openapi.json', { Origin: evil }],
        ['GET', '/api/auth/get-session', { Origin: evil }],
        ['GET', '/api/auth/list-sessions', { Origin: evil }],
        ['GET', '/', { Origin: evil }],
        ['OPTIONS', '/api/account', { Origin: evil, 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'content-type' }],
        ['OPTIONS', '/api/scans', { Origin: evil, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }],
        ['OPTIONS', '/api/auth/sign-in/email', { Origin: evil, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }],
        ['OPTIONS', '/api/auth/get-session', { Origin: evil, 'Access-Control-Request-Method': 'GET' }],
      ]
      for (const [method, path, headers] of requests) {
        const answer = await send(context, method, path, headers)
        const label = `${method} ${path}`
        // Neither a reflected origin nor the wildcard: only the documented open routes send CORS headers.
        expect(answer.headers['access-control-allow-origin'], label).toBeUndefined()
        expect(answer.headers['access-control-allow-credentials'], label).toBeUndefined()
      }
    } finally {
      await context.dispose()
    }
  })

  test('only the credential-less discovery, JWKS, token, registration and MCP routes allow any origin', { tag: ['@AUTH-006'] }, async ({ anonApi }) => {
    const evil = 'https://agent.example'
    const preflight = (method: string) => ({
      Origin: evil,
      'Access-Control-Request-Method': method,
      'Access-Control-Request-Headers': 'authorization, content-type',
    })
    const open: [string, string, Record<string, string>][] = [
      ['GET', '/.well-known/oauth-authorization-server/api/auth', { Origin: evil }],
      ['GET', '/.well-known/openid-configuration/api/auth', { Origin: evil }],
      ['GET', '/.well-known/oauth-protected-resource/mcp', { Origin: evil }],
      ['GET', '/api/auth/jwks', { Origin: evil }],
      ['OPTIONS', '/api/auth/jwks', preflight('GET')],
      ['OPTIONS', '/api/auth/oauth2/token', preflight('POST')],
      ['OPTIONS', '/api/auth/oauth2/register', preflight('POST')],
      ['OPTIONS', '/mcp', preflight('POST')],
    ]
    for (const [method, path, headers] of open) {
      const answer = await send(anonApi.request, method, path, headers)
      const label = `${method} ${path}`
      expect(answer.headers['access-control-allow-origin'], label).toBe('*')
      expect(answer.headers['access-control-allow-credentials'], label).toBeUndefined()
    }
  })
})
