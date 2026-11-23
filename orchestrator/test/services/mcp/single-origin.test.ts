import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, defineEventHandler, toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Config } from '../../../server/utils/config'

// MCP OAuth without a tunnel URL (docs/auth.md §2.5): the resource hook of server/utils/auth.ts exists only for a
// second origin, so a deployment with one origin keeps better-auth's own answers. An authorization request with an
// unknown `resource` goes back to the client's redirect URI with error=invalid_target (RFC 6749 §4.1.2.1), never to a
// JSON 400 at the orchestrator that leaves the client waiting for its callback.

const db = vi.hoisted(
  () =>
    Object.fromEntries(
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
)

vi.mock('better-auth/adapters/mongodb', async () => {
  const { memoryAdapter } = await import('better-auth/adapters/memory')
  return { mongodbAdapter: () => memoryAdapter(db) }
})
vi.mock('../../../server/utils/mongo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/utils/mongo')>()),
  useMongo: () => ({ db: {}, client: {} }),
}))
vi.mock('../../../server/utils/guide-assets', () => ({ readGuide: async () => null }))

const { default: authRoute } = await import('../../../server/api/auth/[...all]')
const { resetBootRegistry, runBoot } = await import('../../../server/utils/boot')
const { parseConfig, setConfigForTesting } = await import('../../../server/utils/config')
const { useLogger } = await import('../../../server/utils/logger')

const PUBLIC = 'https://scantor.example.com'
const REDIRECT = 'http://127.0.0.1:53682/callback'

let server: Server | null = null
let port = 0

beforeAll(async () => {
  setConfigForTesting(parseConfig({ SCANTOR_PUBLIC_URL: PUBLIC, SCANTOR_EDITOR_URL: 'https://editor.example.com' }).config)
  resetBootRegistry()
  await runBoot({ config: () => ({ components: [] }) as unknown as Config, log: useLogger('test') })
  const app = createApp()
  app.use(defineEventHandler((event) => (event.path.startsWith('/api/auth/') ? authRoute(event) : undefined)))
  server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  setConfigForTesting(null)
  resetBootRegistry()
})

function send(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; location?: string; text: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: { host: new URL(PUBLIC).host, ...init.headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(init.body)
  })
}

describe('MCP OAuth with one origin', () => {
  it('sends an unknown resource of an authorization request back to the client with invalid_target', async () => {
    const registered = await send('/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'single', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
    })
    expect(registered.status, registered.text).toBeLessThan(300)
    const { client_id: clientId } = JSON.parse(registered.text) as { client_id: string }
    for (const resource of [`${PUBLIC}/mcp/`, 'https://evil.example/mcp']) {
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        scope: 'scantor:read',
        state: 'state-1',
        code_challenge: 'x'.repeat(43),
        code_challenge_method: 'S256',
        resource,
      })
      const answer = await send(`/api/auth/oauth2/authorize?${query}`)
      expect(answer.status, `${resource}: ${answer.text}`).toBe(302)
      const location = new URL(answer.location!)
      expect(`${location.origin}${location.pathname}`, resource).toBe(REDIRECT)
      expect(location.searchParams.get('error'), resource).toBe('invalid_target')
      expect(location.searchParams.get('state'), resource).toBe('state-1')
    }
  })
})
