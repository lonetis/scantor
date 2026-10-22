import { callJson } from '../helpers/mcp'
import { expect, test } from '../fixtures'

// Smoke test of the MCP plumbing: an API key authenticates /mcp, and the OAuth flow (discovery, the worker's
// registered client, consent, PKCE) yields a token for the same user.

test.describe('MCP plumbing', () => {
  test('an API key lists the tools and calls one', { tag: ['@MCP-015'] }, async ({ mcpKey }) => {
    const { tools } = await mcpKey.listTools()
    expect(tools.map((t) => t.name)).toContain('list_scans')
    const scans = await callJson<{ untrusted_data?: unknown; items?: unknown[] }>(mcpKey, 'list_scans', {})
    expect(scans).toBeTruthy()
  })

  // Known orchestrator bug: every dynamic client registration on a fresh database answers 500 (MongoDB
  // IndexOptionsConflict on oauthClientResource {clientId, resourceId}), so the worker's OAuth client cannot be
  // registered. Declared as an expected failure (the fixture fails before the body runs); turn it back into
  // `test(...)` once registration works.
  test.fail(
    'the OAuth flow connects as the signed-in user',
    { tag: ['@MCP-012'], annotation: { type: 'issue', description: 'POST /api/auth/oauth2/register answers 500 (IndexOptionsConflict)' } },
    async ({ mcp }) => {
      const { tools } = await mcp.client.listTools()
      expect(tools.map((t) => t.name)).toContain('list_scans')
      expect(tools.map((t) => t.name)).not.toContain('list_nodes')
    },
  )
})
