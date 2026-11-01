import { env } from '../helpers/env'
import { callJson } from '../helpers/mcp'
import { bearerChallenge, rawMcp } from '../helpers/mcp-oauth'
import { newApiContext } from '../helpers/users'
import { withMcpTenants } from '../helpers/mcp-tenant'
import { expect, test as base } from '../fixtures'

const test = withMcpTenants(base)

// Smoke test of the MCP plumbing: an API key authenticates /mcp, and the OAuth flow (discovery, the worker's
// registered client, consent, PKCE) yields a token for the same user. The transport tests pin the HTTP contract of
// /mcp (docs/mcp.md §2): POST only, stateless, open CORS without credentials, cookies ignored.

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'scantor-tests', version: '1.0.0' } },
}

test.describe('MCP plumbing', () => {
  test('an API key lists the tools and calls one', { tag: ['@MCP-015'] }, async ({ mcpKey }) => {
    const { tools } = await mcpKey.listTools()
    expect(tools.map((t) => t.name)).toContain('list_scans')
    const scans = await callJson<{ untrusted_data?: unknown; items?: unknown[] }>(mcpKey, 'list_scans', {})
    expect(scans).toBeTruthy()
  })

  test('the OAuth flow connects as the signed-in user', { tag: ['@MCP-012'] }, async ({ mcp }) => {
    const { tools } = await mcp.client.listTools()
    expect(tools.map((t) => t.name)).toContain('list_scans')
    expect(tools.map((t) => t.name)).not.toContain('list_nodes')
  })
})

test.describe('MCP transport', () => {
  test('/mcp accepts only POST and answers a preflight from any origin without credentials', { tag: ['@MCP-008'] }, async ({ anonApi, user }) => {
    const request = anonApi.request
    const auth = { Authorization: `Bearer ${user.apiKey}`, Accept: 'application/json, text/event-stream' }
    for (const method of ['GET', 'DELETE']) {
      const response = await request.fetch('/mcp', { method, headers: auth })
      expect(response.status(), method).toBe(405)
      expect(response.headers()['access-control-allow-origin'], method).toBe('*')
    }

    const preflight = await request.fetch('/mcp', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://agent.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type, mcp-protocol-version',
      },
    })
    expect(preflight.status()).toBe(204)
    const headers = preflight.headers()
    expect(headers['access-control-allow-origin']).toBe('*')
    expect(headers['access-control-allow-credentials']).toBeUndefined()
    expect(headers['access-control-allow-methods']).toContain('POST')
    const allowed = (headers['access-control-allow-headers'] ?? '').split(',').map((header) => header.trim().toLowerCase())
    expect(allowed).toEqual(expect.arrayContaining(['authorization', 'content-type', 'mcp-protocol-version', 'x-api-key']))

    const post = await rawMcp(request, { Authorization: `Bearer ${user.apiKey}`, Origin: 'https://agent.example.com' })
    expect(post.status).toBe(200)
    expect(post.headers['access-control-allow-origin']).toBe('*')
    expect(post.headers['access-control-allow-credentials']).toBeUndefined()
  })

  test(
    '/mcp is stateless and identifies itself as scantor with tools, resources and instructions',
    { tag: ['@MCP-008'] },
    async ({ anonApi, user, mcpKey }) => {
      const initialized = await rawMcp(anonApi.request, { Authorization: `Bearer ${user.apiKey}` }, INITIALIZE)
      expect(initialized.status).toBe(200)
      expect(initialized.headers['mcp-session-id'], 'no MCP session is issued').toBeUndefined()
      const result = initialized.body?.result as {
        serverInfo: { name: string; icons?: Array<{ src: string; mimeType?: string; sizes?: string[] }> }
        capabilities: Record<string, unknown>
        instructions?: string
      }
      expect(result.serverInfo.name).toBe('scantor')
      // The app icons come from the dashboard's own origin, and the dashboard serves them without a session.
      expect(result.serverInfo.icons?.map((icon) => icon.mimeType)).toEqual(['image/svg+xml', 'image/png'])
      for (const icon of result.serverInfo.icons ?? []) {
        expect(new URL(icon.src).origin).toBe(env.publicUrl)
        const fetched = await anonApi.request.get(icon.src)
        expect(fetched.status(), icon.src).toBe(200)
        expect(fetched.headers()['content-type']).toContain(icon.mimeType)
      }
      expect(result.capabilities).toEqual(expect.objectContaining({ tools: expect.any(Object), resources: expect.any(Object) }))
      expect(result.instructions?.length).toBeGreaterThan(100)

      // Every request stands alone: a tools/list without an initialize or a session id is answered.
      const listed = await rawMcp(anonApi.request, { Authorization: `Bearer ${user.apiKey}` })
      expect(listed.status).toBe(200)
      expect((listed.body?.result as { tools: unknown[] }).tools.length).toBeGreaterThan(0)

      expect(mcpKey.getServerVersion()?.name).toBe('scantor')
      expect(mcpKey.getServerCapabilities()).toEqual(expect.objectContaining({ tools: expect.any(Object), resources: expect.any(Object) }))
      expect(mcpKey.getInstructions()).toBe(result.instructions)
    },
  )

  test('/mcp ignores the dashboard session cookie and challenges for a bearer credential', { tag: ['@MCP-008'] }, async ({ env, user }) => {
    const session = await newApiContext({ storageState: user.storageState })
    try {
      // The cookie is valid for the dashboard ...
      expect((await session.get('/api/account')).status()).toBe(200)
      // ... but /mcp authenticates only with bearer credentials.
      const response = await rawMcp(session, {})
      expect(response.status).toBe(401)
      expect(bearerChallenge(response.headers['www-authenticate']).resource_metadata).toBe(`${env.publicUrl}/.well-known/oauth-protected-resource/mcp`)
    } finally {
      await session.dispose()
    }
  })
})
