import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, defineEventHandler, send, setResponseStatus, toNodeListener } from 'h3'
import { afterEach, describe, expect, it } from 'vitest'
import pathMiddleware from '../../server/middleware/01.path'
import authMiddleware from '../../server/middleware/10.auth'
import { resetBootRegistry } from '../../server/utils/boot'
import { normalizeError } from '../../server/utils/errors'
import { routedPathname } from '../../server/utils/request-path'

// Raw request paths on a real listener (docs/auth.md §1, §5.2, security.md AUTH-5): `new Request()` would resolve
// the dot segments before the app sees them, so the requests go through node:http with the path sent verbatim.

let server: Server | null = null

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
  resetBootRegistry()
})

async function listen(middleware: ReturnType<typeof defineEventHandler>[]): Promise<number> {
  const app = createApp({
    onError: (error, event) => {
      const normalized = normalizeError(error)
      setResponseStatus(event, normalized.status)
      return send(event, JSON.stringify(normalized.body), 'application/json')
    },
  })
  for (const handler of middleware) app.use(handler)
  app.use(defineEventHandler((event) => ({ reached: routedPathname(event) })))
  server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return (server!.address() as AddressInfo).port
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('middleware 01.path', () => {
  it('answers 400 badRequest for raw paths that resolve to another path', async () => {
    const port = await listen([pathMiddleware])
    for (const path of [
      '/.well-known/x/../../api/auth/get-session',
      '/.well-known/x/../../api/auth/passkey/generate-register-options',
      '/.well-known/x/%2e%2e/%2e%2e/api/auth/oauth2/authorize',
      '/api/auth/x/../passkey/generate-register-options',
      '/api/auth/passkey/./delete-passkey',
      '/api/auth/passkey/%2e/verify-registration',
      '/api\\auth\\get-session',
      '//api/auth/get-session',
    ]) {
      const response = await get(port, path)
      expect(response.status, path).toBe(400)
      expect(response.body, path).toEqual({ error: { code: 'badRequest', message: 'the request path is not in canonical form' } })
    }
  })

  it('lets canonical paths through unchanged', async () => {
    const port = await listen([pathMiddleware])
    expect(await get(port, '/api/auth/get-session?x=../..')).toEqual({ status: 200, body: { reached: '/api/auth/get-session' } })
    expect(await get(port, '/.well-known/oauth-protected-resource/mcp')).toEqual({
      status: 200,
      body: { reached: '/.well-known/oauth-protected-resource/mcp' },
    })
  })
})

describe('API keys on paths better-auth routes', () => {
  it('are refused even when the raw path does not start with /api/auth', async () => {
    // Without 01.path: the auth middleware judges the path better-auth would see as well as the raw one.
    const port = await listen([authMiddleware])
    const key = `sk_scantor_editor_${'E'.repeat(64)}`
    for (const headers of [{ 'x-api-key': key }, { authorization: `Bearer ${key}` }]) {
      const response = await get(port, '/.well-known/x/../../api/auth/passkey/generate-register-options', headers)
      expect(response).toEqual({ status: 401, body: { error: { code: 'unauthorized', message: 'API keys cannot be used on /api/auth' } } })
    }
    // A discovery request without a key is not the auth middleware's business.
    expect(await get(port, '/.well-known/oauth-protected-resource/mcp')).toEqual({
      status: 200,
      body: { reached: '/.well-known/oauth-protected-resource/mcp' },
    })
  })
})
