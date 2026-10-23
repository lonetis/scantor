import { randomBytes } from 'node:crypto'
import { ProtocolError, type Client } from '@modelcontextprotocol/client'
import { connectMcpWithKey } from '../helpers/mcp'
import { connectMcpWithApiKeyHeader, createSessionUser, createTemporaryKey, startEditorAndReadKey, stopEditor } from '../helpers/mcp-accounts'
import { bearerChallenge, rawMcp } from '../helpers/mcp-oauth'
import { withMcpTenants } from '../helpers/mcp-tenant'
import { callOk } from '../helpers/mcp-tools'
import { expect, test as base, unique } from '../fixtures'

// scantor API keys on /mcp (docs/mcp.md §3.7): `Authorization: Bearer` or `x-api-key`, both key kinds. An admin's
// `default` key gets the admin level, every other key the write level; an invalid or expired key gets 401 with the
// OAuth challenge so a client can fall back to OAuth.

const test = withMcpTenants(base)

const CHALLENGE_SCOPE = 'offline_access scantor:read scantor:write scantor:admin'

/** Tools that only the admin level has. */
const ADMIN_TOOLS = ['list_nodes']
/** A sample of write-level tools. */
const WRITE_TOOLS = ['create_task', 'write_task_files', 'publish_revision', 'start_scan', 'cancel_scan']

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((tool) => tool.name)
}

/** tools/list through a raw POST with the given headers. */
async function rawToolNames(request: Parameters<typeof rawMcp>[0], headers: Record<string, string>): Promise<string[]> {
  const response = await rawMcp(request, headers)
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  return ((response.body?.result as { tools: { name: string }[] }).tools ?? []).map((tool) => tool.name)
}

async function expectUnknownTool(client: Client, name: string): Promise<void> {
  const error = await client.callTool({ name, arguments: {} }).then(
    (result) => new Error(`${name} returned ${JSON.stringify(result).slice(0, 500)}`),
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(ProtocolError)
  expect((error as ProtocolError).message).toContain(`Tool ${name} not found`)
}

/** Expects the 401 OAuth challenge of an unusable API key. */
async function expectKeyChallenge(request: Parameters<typeof rawMcp>[0], headers: Record<string, string>, publicUrl: string): Promise<void> {
  const response = await rawMcp(request, headers)
  expect(response.status).toBe(401)
  expect(response.body).toMatchObject({ jsonrpc: '2.0', error: { code: -32000, message: expect.stringMatching(/API key/) }, id: null })
  expect(bearerChallenge(response.headers['www-authenticate'])).toMatchObject({
    error: 'invalid_token',
    resource_metadata: `${publicUrl}/.well-known/oauth-protected-resource/mcp`,
    scope: CHALLENGE_SCOPE,
  })
}

test.describe('MCP with API keys', () => {
  test("a user's default key works as Bearer and as x-api-key with the write level", { tag: ['@MCP-015', '@MCP-002'] }, async ({ anonApi, user, mcpKey }) => {
    const names = await toolNames(mcpKey)
    expect(names).toEqual(expect.arrayContaining(WRITE_TOOLS))
    expect(names.filter((name) => ADMIN_TOOLS.includes(name))).toEqual([])
    await expectUnknownTool(mcpKey, 'list_nodes')

    // The same key in the x-api-key header is the same principal with the same tools.
    expect((await rawToolNames(anonApi.request, { 'x-api-key': user.apiKey })).sort()).toEqual([...names].sort())
    const viaHeader = await connectMcpWithApiKeyHeader(user.apiKey)
    try {
      const scans = await callOk<{ items: unknown[] }>(viaHeader, 'list_scans', { limit: 1 })
      expect(Array.isArray(scans.items)).toBe(true)
    } finally {
      await viaHeader.close()
    }
  })

  test("an admin's default key has the admin level and lists the nodes", { tag: ['@MCP-015', '@MCP-002'] }, async ({ adminApi, anonApi }) => {
    const key = await createTemporaryKey(adminApi, unique('mcp-admin-key'))
    try {
      const client = await connectMcpWithKey(key.key)
      try {
        expect(await toolNames(client)).toEqual(expect.arrayContaining([...WRITE_TOOLS, ...ADMIN_TOOLS]))
        const nodes = await callOk<{ items: { id: string; builtIn: boolean }[] }>(client, 'list_nodes', {})
        expect(nodes.items.some((node) => node.builtIn)).toBe(true)
      } finally {
        await client.close()
      }
      expect(await rawToolNames(anonApi.request, { 'x-api-key': key.key })).toEqual(expect.arrayContaining(ADMIN_TOOLS))
    } finally {
      await key.dispose()
    }
  })

  test("an admin's editor key has the write level without admin tools", { tag: ['@MCP-015', '@MCP-002'] }, async ({ adminApi, openapi }) => {
    test.setTimeout(180_000)
    // A dedicated admin whose editor mints the `editor` key; the key lives only inside the editor container.
    const admin = await createSessionUser(adminApi, openapi, { prefix: 'mcp-editor-admin', role: 'admin' })
    try {
      const editorKey = await startEditorAndReadKey(admin.api, admin.user.id)
      try {
        expect(editorKey).toMatch(/^sk_scantor_editor_[A-Za-z]{64}$/)
        const client = await connectMcpWithKey(editorKey)
        try {
          const names = await toolNames(client)
          expect(names).toEqual(expect.arrayContaining(WRITE_TOOLS))
          expect(names.filter((name) => ADMIN_TOOLS.includes(name))).toEqual([])
          await expectUnknownTool(client, 'list_nodes')
        } finally {
          await client.close()
        }
        // The admin's own default key, for contrast, is admin.
        const defaultClient = await connectMcpWithKey(admin.apiKey)
        try {
          expect(await toolNames(defaultClient)).toEqual(expect.arrayContaining(ADMIN_TOOLS))
        } finally {
          await defaultClient.close()
        }
      } finally {
        await stopEditor(admin.api)
      }
    } finally {
      await admin.dispose()
    }
  })

  test('an invalid key gets 401 with the OAuth challenge, as Bearer and as x-api-key', { tag: ['@MCP-015'] }, async ({ env, anonApi }) => {
    const forged = `sk_scantor_${randomBytes(48)
      .toString('base64')
      .replace(/[^A-Za-z]/g, '')
      .padEnd(64, 'x')
      .slice(0, 64)}`
    await expectKeyChallenge(anonApi.request, { Authorization: `Bearer ${forged}` }, env.publicUrl)
    await expectKeyChallenge(anonApi.request, { 'x-api-key': forged }, env.publicUrl)
    await expectKeyChallenge(anonApi.request, { 'x-api-key': 'not-a-key' }, env.publicUrl)
  })

  test('an expired key gets 401 with the OAuth challenge', { tag: ['@MCP-015'] }, async ({ env, api, anonApi, docker }) => {
    const key = await createTemporaryKey(api, unique('mcp-expired'))
    try {
      expect((await rawMcp(anonApi.request, { Authorization: `Bearer ${key.key}` })).status).toBe(200)
      // White-box: no API accepts a past expiry (1–365 days), so the test's own key is expired in the database.
      const updated = await docker.mongosh(
        `print(db.apikey.updateOne({ _id: ${JSON.stringify(key.id)} }, { $set: { expiresAt: new Date(Date.now() - 60000) } }).modifiedCount)`,
        { as: 'root' },
      )
      expect(updated).toBe('1')
      await expectKeyChallenge(anonApi.request, { Authorization: `Bearer ${key.key}` }, env.publicUrl)
    } finally {
      await key.dispose()
    }
  })
})
