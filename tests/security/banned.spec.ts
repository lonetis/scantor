import type { Client } from '@modelcontextprotocol/client'
import type { Scan } from '#shared/types/scans'
import type { User } from '#shared/types/users'
import { ApiClient, ok } from '../helpers/api-client'
import {
  createKey,
  editorContainerExists,
  mintToolsCookie,
  rootCount,
  setBannedFlag,
  startEditorKey,
  TestUsers,
  toolHostStatus,
  withAuthTenants,
} from '../helpers/api-auth'
import { connectMcp, connectMcpWithKey } from '../helpers/mcp'
import { scanCounts, SMALL_SETTINGS, waitForScanState } from '../helpers/scans'
import { exampleTaskDir, uploadAndPublish } from '../helpers/tasks'
import { newApiContext } from '../helpers/users'
import { expect, test as base, unique } from '../fixtures'

const test = withAuthTenants(base)

// Bans (docs/auth.md §5.7, security.md AUTH-4): a banned user is rejected on every user principal (session,
// `default` and `editor` API keys, MCP over OAuth or an API key, the admin tools cookie) within the 30 s user
// cache; the ban deletes keys, sessions and OAuth grants and stops the editor. Worker tokens are not user
// principals: the user's scans keep running unless the ban cancels them. Every banned user is a dedicated user.

const BAN_DEADLINE_MS = 35_000

async function statusWithKey(openapi: ApiClient['openapi'], key: string): Promise<number> {
  const context = await newApiContext({ headers: { Authorization: `Bearer ${key}` } })
  try {
    return (await new ApiClient(context, openapi).getAccount()).status
  } finally {
    await context.dispose()
  }
}

/** 'ok' when an MCP client can still list tools, else the error message. */
async function mcpState(client: Client): Promise<string> {
  try {
    await client.listTools()
    return 'ok'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** A fresh MCP connection with a key: 'ok', or the connect error. */
async function mcpConnectState(key: string): Promise<string> {
  try {
    const client = await connectMcpWithKey(key)
    try {
      return await mcpState(client)
    } finally {
      await client.close()
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

test.describe('banned users', () => {
  const users = new TestUsers()
  test.afterEach(async ({ adminApi }) => users.cleanup(adminApi))

  test('a banned user is rejected with 403 banned on sessions and API keys, and MCP refuses them', { tag: ['@AUTH-016'] }, async ({ adminApi, openapi }) => {
    const target = await users.signedIn(adminApi, openapi, { prefix: 'banned-flag' })
    const key = await createKey(target.api, 'flag-key')
    expect((await target.api.getAccount()).status).toBe(200)
    expect(await mcpConnectState(key.key)).toBe('ok')

    // Only the flag (the middleware's own ban check, without the revocations banUser performs).
    await setBannedFlag(target.id, true)
    try {
      for (const response of [await target.api.getAccount(), await target.api.call('updateAccount', { body: { name: 'banned' } })]) {
        expect(response.status).toBe(403)
        expect((response.body as { error: { code: string } }).error.code).toBe('banned')
      }
      const context = await newApiContext({ headers: { 'x-api-key': key.key } })
      try {
        const viaKey = new ApiClient(context, openapi)
        for (const response of [await viaKey.getAccount(), await viaKey.call('listScans')]) {
          expect(response.status).toBe(403)
          expect((response.body as { error: { code: string } }).error.code).toBe('banned')
        }
      } finally {
        await context.dispose()
      }
      // /mcp re-checks the user on every request and answers with its OAuth challenge (docs/mcp.md §3.6).
      await expect.poll(() => mcpConnectState(key.key), { timeout: BAN_DEADLINE_MS }).not.toBe('ok')
    } finally {
      await setBannedFlag(target.id, false)
    }
    // The credentials themselves were never revoked.
    expect((await target.api.getAccount()).status).toBe(200)
    expect(await statusWithKey(openapi, key.key)).toBe(200)
  })

  test(
    'banning revokes the session, both API keys, MCP over OAuth and over an API key and the tools cookie, and stops the editor',
    { tag: ['@AUTH-017', '@AUTH-018', '@USER-007'] },
    async ({ adminApi, openapi, oauthClient }) => {
      test.setTimeout(180_000)
      const target = await users.signedIn(adminApi, openapi, { prefix: 'banned-all', role: 'admin' })
      const key = await createKey(target.api, 'ban-default')
      const editorKey = await startEditorKey(target.api, target.id)
      const tools = await mintToolsCookie(target.api)
      const mcpDefault = await connectMcpWithKey(key.key)
      const mcpEditor = await connectMcpWithKey(editorKey)
      const mcpOAuth = await connectMcp(target.api.request, { client: oauthClient })
      try {
        // Every principal works before the ban.
        expect((await target.api.getAccount()).status).toBe(200)
        expect(await statusWithKey(openapi, key.key)).toBe(200)
        expect(await statusWithKey(openapi, editorKey)).toBe(200)
        expect(await mcpState(mcpDefault)).toBe('ok')
        expect(await mcpState(mcpEditor)).toBe('ok')
        expect(await mcpState(mcpOAuth.client)).toBe('ok')
        expect(await toolHostStatus(tools.value)).toBe(200)
        expect(await rootCount('apikey', { referenceId: target.id })).toBe(2)
        // OAuth access tokens are JWTs (not stored); offline_access stores a refresh token next to the consent.
        expect(await rootCount('oauthConsent', { userId: target.id })).toBe(1)
        expect(await rootCount('oauthRefreshToken', { userId: target.id })).toBeGreaterThan(0)

        const banned = ok(await adminApi.call<User>('banUser', { path: { userId: target.id }, body: { reason: 'security test' } }), 'banUser')
        expect(banned).toMatchObject({ banned: true, banReason: 'security test' })

        const poll = { timeout: BAN_DEADLINE_MS, intervals: [250, 500, 1000] }
        await expect.poll(async () => (await target.api.getAccount()).status, poll).toBe(401)
        await expect.poll(() => statusWithKey(openapi, key.key), poll).toBe(401)
        await expect.poll(() => statusWithKey(openapi, editorKey), poll).toBe(401)
        await expect.poll(() => mcpState(mcpDefault), poll).not.toBe('ok')
        await expect.poll(() => mcpState(mcpEditor), poll).not.toBe('ok')
        await expect.poll(() => mcpState(mcpOAuth.client), poll).not.toBe('ok')
        await expect.poll(() => toolHostStatus(tools.value), { ...poll, message: 'the tools cookie is refused' }).toBe(401)

        // The grants are gone, not just blocked.
        expect(await rootCount('apikey', { referenceId: target.id })).toBe(0)
        expect(await rootCount('session', { userId: target.id })).toBe(0)
        expect(await rootCount('oauthConsent', { userId: target.id })).toBe(0)
        expect(await rootCount('oauthAccessToken', { userId: target.id })).toBe(0)
        expect(await rootCount('oauthRefreshToken', { userId: target.id })).toBe(0)
        await expect.poll(() => editorContainerExists(target.id), { timeout: 60_000, message: 'the editor container is removed' }).toBe(false)
      } finally {
        await mcpDefault.close().catch(() => undefined)
        await mcpEditor.close().catch(() => undefined)
        await mcpOAuth.close().catch(() => undefined)
      }
    },
  )

  test('a ban keeps the user’s scans running unless it cancels them', { tag: ['@USER-008'] }, async ({ adminApi, openapi }) => {
    // Builds a task and runs two small scans.
    test.setTimeout(300_000)
    const target = await users.signedIn(adminApi, openapi, { prefix: 'banned-scans' })
    const { revision } = await uploadAndPublish(target.api, exampleTaskDir('sleep'), unique('ban-sleep'))
    const start = async (name: string, seconds: number, times: number) =>
      ok(
        await target.api.startScan({
          revision: revision.ref,
          name: unique(name),
          taskConfig: { seconds },
          scanConfig: { times },
          settings: { ...SMALL_SETTINGS, maxAttempts: 1, timeoutMs: 3_600_000 },
        }),
        'startScan',
      )
    // About 20 s of work on one process: still running when the ban comes right after the start.
    const finishing = await start('ban-keeps', 10, 2)
    const lasting = await start('ban-cancels', 3600, 1)
    try {
      await waitForScanState(adminApi, finishing.id, 'running', 120_000)
      await waitForScanState(adminApi, lasting.id, 'running', 120_000)
      expect(ok(await adminApi.getScan(finishing.id), 'getScan')).toMatchObject({ state: 'running', completedAt: null })

      // Ban without cancelScans: worker tokens are not user principals, so both scans go on.
      ok(await adminApi.call('banUser', { path: { userId: target.id }, body: { cancelScans: false } }), 'banUser')
      expect((await target.api.getAccount()).status).toBe(401)
      const completed: Scan = await waitForScanState(adminApi, finishing.id, 'completed', 150_000)
      expect(completed.state).toBe('completed')
      expect(await scanCounts(adminApi, finishing.id)).toEqual({ succeeded: 2 })
      expect(ok(await adminApi.getScan(lasting.id), 'getScan').state).toBe('running')

      // A ban with cancelScans cancels every non-terminal scan.
      ok(await adminApi.call('unbanUser', { path: { userId: target.id } }), 'unbanUser')
      ok(await adminApi.call('banUser', { path: { userId: target.id }, body: { cancelScans: true } }), 'banUser')
      const cancelled = await waitForScanState(adminApi, lasting.id, 'cancelled', 60_000)
      expect(cancelled.state).toBe('cancelled')
      // The finished scan is untouched.
      expect(ok(await adminApi.getScan(finishing.id), 'getScan').state).toBe('completed')
    } finally {
      // The user's deletion (afterEach) purges both scans; cancelling a running one first frees its workers at once.
      for (const scan of [finishing, lasting]) {
        const cancelled = await adminApi.cancelScan(scan.id)
        expect([200, 409], `cancel ${scan.id}`).toContain(cancelled.status)
      }
    }
  })
})
