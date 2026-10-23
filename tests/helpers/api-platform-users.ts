import type { APIRequestContext } from '@playwright/test'
import { ApiClient, ok } from './api-client'
import type { OpenApiIndex } from './openapi'
import { patientSession } from './api-platform-tenant'
import { createUser, deleteUser, type TestUser } from './users'

// Dedicated users for tests of the api-platform writer that need a principal the fixtures do not provide: an admin
// other than the seeded one (tools cookies, admin API keys for the CLI, editor routes of an admin), or a second user
// with an editor of its own. Each one is created by the seeded admin, signed in once through the limiter and deleted
// by `dispose()` (the userPurge job removes its keys, sessions, editor and workspace).

export interface DedicatedUser {
  user: TestUser
  /** the user's session */
  session: APIRequestContext
  api: ApiClient
  /** a `default` API key, when requested */
  apiKey: string | null
  dispose(): Promise<void>
}

export async function dedicatedUser(
  adminApi: ApiClient,
  openapi: OpenApiIndex,
  options: { prefix: string; role?: 'user' | 'admin'; apiKey?: boolean },
): Promise<DedicatedUser> {
  const user = await createUser(adminApi, { prefix: options.prefix, role: options.role ?? 'user' })
  let session: APIRequestContext | null = null
  try {
    session = await patientSession(user.email, user.password)
    const api = new ApiClient(session, openapi)
    const apiKey = options.apiKey ? ok(await api.createApiKey('tests'), 'createApiKey').key : null
    const opened = session
    return {
      user,
      session: opened,
      api,
      apiKey,
      dispose: async () => {
        try {
          await opened.dispose()
        } finally {
          await deleteUser(adminApi, user.id)
        }
      },
    }
  } catch (error) {
    await session?.dispose()
    await deleteUser(adminApi, user.id)
    throw error
  }
}

/**
 * A short-lived `default` API key of the session's user (for the seeded admin: an admin key for the CLI without an
 * extra sign-in, which the shared sign-in budget cannot spare). `dispose()` deletes it.
 */
export async function temporaryApiKey(session: ApiClient, name: string): Promise<{ id: string; key: string; dispose(): Promise<void> }> {
  const created = ok(await session.createApiKey(name.slice(0, 32), 1), 'createApiKey')
  return {
    id: created.apiKey.id,
    key: created.key,
    dispose: async () => {
      const response = await session.call('deleteApiKey', { path: { keyId: created.apiKey.id } })
      if (response.status !== 204 && response.status !== 404) throw new Error(`deleteApiKey answered ${response.status}`)
    },
  }
}

/** A user created by the seeded admin without signing in (tools cookies are minted with helpers/keys.ts). */
export async function unsignedUser(adminApi: ApiClient, options: { prefix: string; role: 'user' | 'admin' }): Promise<TestUser & { dispose(): Promise<void> }> {
  const user = await createUser(adminApi, { prefix: options.prefix, role: options.role })
  return { ...user, dispose: () => deleteUser(adminApi, user.id) }
}
