import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { APIRequestContext } from '@playwright/test'
import type { EditorStatus } from '#shared/types/editor'
import { ApiClient, ok } from './api-client'
import { innerDocker } from './docker'
import { env } from './env'
import type { OpenApiIndex } from './openapi'
import { patientSession } from './mcp-tenant'
import { createUser, deleteUser, type TestUser } from './users'

// Accounts and keys the mcp writer's specs need beyond the fixtures (docs/mcp.md §3.7): a temporary `default` API key
// of a signed-in user (for the seeded admin, so admin-level tests spend no sign-in of the shared budget), a user of
// the spec's own with a session and a key, and the `editor` API key of a user, which exists only inside the user's
// editor container (docs/auth.md §8.3).

export interface TemporaryKey {
  id: string
  /** `sk_scantor_…` */
  key: string
  /** deletes the key (404 counts as deleted) */
  dispose(): Promise<void>
}

/** Creates a `default` API key with the session of `api` (a unique `name`); delete it with `dispose`. */
export async function createTemporaryKey(api: ApiClient, name: string): Promise<TemporaryKey> {
  const created = ok(await api.createApiKey(name.slice(0, 32)), 'createApiKey')
  return {
    id: created.apiKey.id,
    key: created.key,
    dispose: async () => {
      const response = await api.call('deleteApiKey', { path: { keyId: created.apiKey.id } })
      if (response.status !== 204 && response.status !== 404) throw new Error(`deleteApiKey answered ${response.status}: ${JSON.stringify(response.body)}`)
    },
  }
}

export interface SessionUser {
  user: TestUser
  /** request context signed in as the user (one limiter slot) */
  session: APIRequestContext
  api: ApiClient
  /** a `default` API key of the user */
  apiKey: string
  dispose(): Promise<void>
}

/** Creates a user (role `admin` by default), signs in once (waiting out a 429) and creates a `default` API key. */
export async function createSessionUser(
  adminApi: ApiClient,
  openapi: OpenApiIndex,
  options: { prefix: string; role?: 'user' | 'admin' },
): Promise<SessionUser> {
  const user = await createUser(adminApi, { prefix: options.prefix, role: options.role ?? 'admin' })
  let session: APIRequestContext | undefined
  try {
    session = await patientSession(user.email, user.password)
    const api = new ApiClient(session, openapi)
    const created = ok(await api.createApiKey('mcp tests'), 'createApiKey')
    const signedIn = session
    return {
      user,
      session: signedIn,
      api,
      apiKey: created.key,
      dispose: async () => {
        await deleteUser(adminApi, user.id)
        await signedIn.dispose()
      },
    }
  } catch (error) {
    await session?.dispose()
    await deleteUser(adminApi, user.id)
    throw error
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Starts the user's editor (createEditorSession) and returns its `editor` API key, read from the SCANTOR_TOKEN of the
 * editor container once the editor is running. Retries 429 (the instance's running-editor cap) until `timeoutMs`.
 */
export async function startEditorAndReadKey(api: ApiClient, userId: string, timeoutMs = 180_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const started = await api.call('createEditorSession', { body: {} })
    if (started.status === 201) break
    if ((started.status !== 429 && started.status !== 409) || Date.now() >= deadline) {
      throw new Error(`createEditorSession answered ${started.status}: ${JSON.stringify(started.body)}`)
    }
    await sleep(2000)
  }
  for (;;) {
    const editor = ok(await api.call<EditorStatus>('getEditor'), 'getEditor')
    if (editor.state === 'running') break
    if (editor.state === 'stopped' || editor.state === 'stopping') throw new Error(`the editor did not start: ${JSON.stringify(editor)}`)
    if (Date.now() >= deadline) throw new Error(`the editor is still ${editor.state} after ${timeoutMs / 1000} s`)
    await sleep(1000)
  }
  const container = await innerDocker.inspect<{ Config: { Env: string[] } }>(`scantor-editor-${userId}`)
  const token = container.Config.Env.find((entry) => entry.startsWith('SCANTOR_TOKEN='))?.slice('SCANTOR_TOKEN='.length)
  if (!token) throw new Error(`the editor container of ${userId} has no SCANTOR_TOKEN`)
  return token
}

/** Stops the user's editor, which deletes its `editor` key (204, also when it is already stopped). */
export async function stopEditor(api: ApiClient): Promise<void> {
  const response = await api.call('stopEditor')
  if (response.status !== 204) {
    throw new Error(`stopEditor answered ${response.status}: ${JSON.stringify(response.body)}`)
  }
}

/** An MCP client that sends an API key in the `x-api-key` header instead of `Authorization: Bearer`. */
export async function connectMcpWithApiKeyHeader(key: string): Promise<Client> {
  const client = new Client({ name: 'scantor-tests', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(env.mcpUrl), { requestInit: { headers: { 'x-api-key': key } } }))
  return client
}
