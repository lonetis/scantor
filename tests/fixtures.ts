import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test as base, expect, type APIRequestContext } from '@playwright/test'
import type { Client } from '@modelcontextprotocol/client'
import type { StoredOAuthClientInformation } from '@modelcontextprotocol/client'
import { ApiError, ApiClient, ok } from './helpers/api-client'
import { innerDocker } from './helpers/docker'
import { env, type TestEnv } from './helpers/env'
import { connectMcp, connectMcpWithKey, DEFAULT_MCP_SCOPES, registerClient, type McpConnection } from './helpers/mcp'
import { OpenApiIndex } from './helpers/openapi'
import { cancelAndDeleteScan, scanCounts, startScan, waitForScanState, type StartScanBody } from './helpers/scans'
import { deleteTask, exampleTaskDir, fixtureTaskDir, manifestName, uploadAndPublish, type UploadedTask } from './helpers/tasks'
import { unique } from './helpers/unique'
import { createUser, deleteUser, newApiContext, signedInContext, type TestUser } from './helpers/users'
import { installVirtualAuthenticator, type VirtualAuthenticator } from './helpers/webauthn'
import type { Revision } from '#shared/types/revisions'
import type { Scan } from '#shared/types/scans'
import type { ScanState } from '#shared/utils/enums'

// The fixtures of the suite (docs/testing.md §7.7). Specs import `test` and `expect` only from this file.
//
// Isolation: every Playwright worker gets its own tenant (`user`, created by the admin and signed in once through the
// limiter); tests that change account-level state use `freshUser`. `tasks` and `scans` delete what they created, and
// the tenants are deleted at worker teardown, which purges everything else they own. Teardown errors fail the test
// (a 404 counts as success).

export { expect }
export { unique }

/** A user with a saved session (storage state) and a `default` API key created with that session. */
export interface Tenant extends TestUser {
  /** storage state file with the session cookie */
  storageState: string
  /** `sk_scantor_…`, shown once at creation */
  apiKey: string
}

export interface TasksFixture {
  /** Uploads a task folder under a unique name (default: unique(<manifest name>)) and publishes a ready revision. */
  upload(dir: string, options?: { name?: string; expectState?: Revision['state'] }): Promise<UploadedTask>
  /** A fixture task of tests/fixtures/tasks/<name>. */
  fixture(name: string, options?: { name?: string; expectState?: Revision['state'] }): Promise<UploadedTask>
  /** An example task of tasks/<dir>. */
  example(dir: string, options?: { name?: string; expectState?: Revision['state'] }): Promise<UploadedTask>
  /** Registers a task created another way (CLI, MCP, git import) for deletion at teardown. */
  track(task: string): void
}

export interface ScansFixture {
  /** Starts a scan (small settings unless the body sets them) and registers it for cleanup. */
  start(body: StartScanBody): Promise<Scan>
  /** Waits until the scan reaches a state (default completed); throws with diagnostics otherwise. */
  wait(scanId: string, options?: { state?: ScanState | ScanState[]; timeoutMs?: number }): Promise<Scan>
  /** Exact analysis counts by status. */
  counts(scanId: string): Promise<Record<string, number>>
  /** Registers a scan started another way (CLI, MCP) for cleanup. */
  track(scanId: string): void
}

interface TestFixtures {
  /** whose session `page` and `api` use: the worker's tenant (default) or the seeded admin */
  role: 'user' | 'admin'
  /** `page` signs in as the tenant (default) or as `freshUser` */
  pageUser: 'tenant' | 'fresh'
  /** scopes the `mcp` fixture requests */
  mcpScopes: string
  api: ApiClient
  apiKeyApi: ApiClient
  anonApi: ApiClient
  freshUser: Tenant
  freshApi: ApiClient
  mcp: McpConnection
  mcpKey: Client
  webauthn: VirtualAuthenticator
  tasks: TasksFixture
  scans: ScansFixture
  /** creates the fresh user on first use and deletes it at teardown (shared by `freshUser` and `page`) */
  freshUserHandle: { get(): Promise<Tenant> }
}

interface WorkerFixtures {
  env: TestEnv
  openapi: OpenApiIndex
  adminApi: ApiClient
  user: Tenant
  otherUser: Tenant
  otherApi: ApiClient
  docker: typeof innerDocker
  /** the worker's registered OAuth client (one dynamic registration per worker) */
  oauthClient: StoredOAuthClientInformation
}

/** Creates a user as admin, signs in once, saves the session and creates a `default` API key with it. */
async function createTenant(adminApi: ApiClient, openapi: OpenApiIndex, prefix: string, stateName: string): Promise<Tenant> {
  const user = await createUser(adminApi, { prefix })
  const session = await signedInContext(user.email, user.password)
  try {
    await mkdir(env.paths.auth, { recursive: true })
    const storageState = join(env.paths.auth, `${stateName}.json`)
    await session.storageState({ path: storageState })
    const key = ok(await new ApiClient(session, openapi).createApiKey('tests'), 'createApiKey')
    return { ...user, storageState, apiKey: key.key }
  } finally {
    await session.dispose()
  }
}

/** An ApiClient on a new request context, disposed after `use`. */
async function withClient(openapi: OpenApiIndex, context: Promise<APIRequestContext>, use: (client: ApiClient) => Promise<void>): Promise<void> {
  const request = await context
  try {
    await use(new ApiClient(request, openapi))
  } finally {
    await request.dispose()
  }
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // ── worker scope ──────────────────────────────────────────────────────────────────────────────────

  env: [async ({}, use) => use(env), { scope: 'worker' }],

  openapi: [async ({}, use) => use(OpenApiIndex.load()), { scope: 'worker' }],

  adminApi: [async ({ openapi }, use) => withClient(openapi, newApiContext({ storageState: env.paths.adminState }), use), { scope: 'worker' }],

  user: [
    async ({ adminApi, openapi }, use, workerInfo) => {
      const tenant = await createTenant(adminApi, openapi, `w${workerInfo.workerIndex}`, `user-${workerInfo.workerIndex}`)
      await use(tenant)
      await deleteUser(adminApi, tenant.id)
    },
    { scope: 'worker' },
  ],

  otherUser: [
    async ({ adminApi, openapi }, use, workerInfo) => {
      const tenant = await createTenant(adminApi, openapi, `w${workerInfo.workerIndex}-other`, `other-${workerInfo.workerIndex}`)
      await use(tenant)
      await deleteUser(adminApi, tenant.id)
    },
    { scope: 'worker' },
  ],

  otherApi: [async ({ openapi, otherUser }, use) => withClient(openapi, newApiContext({ storageState: otherUser.storageState }), use), { scope: 'worker' }],

  docker: [async ({}, use) => use(innerDocker), { scope: 'worker' }],

  oauthClient: [
    async ({}, use) => {
      const request = await newApiContext()
      try {
        await use(await registerClient(request))
      } finally {
        await request.dispose()
      }
    },
    { scope: 'worker' },
  ],

  // ── options ───────────────────────────────────────────────────────────────────────────────────────

  role: ['user', { option: true }],
  pageUser: ['tenant', { option: true }],
  mcpScopes: [DEFAULT_MCP_SCOPES, { option: true }],

  // `page` and `context` use the session of the role (or of the fresh user); no UI login in setup.
  storageState: async ({ role, pageUser, user, freshUserHandle }, use) => {
    if (pageUser === 'fresh') await use((await freshUserHandle.get()).storageState)
    else await use(role === 'admin' ? env.paths.adminState : user.storageState)
  },

  // ── test scope ────────────────────────────────────────────────────────────────────────────────────

  api: async ({ openapi, role, user }, use) => {
    await withClient(openapi, newApiContext({ storageState: role === 'admin' ? env.paths.adminState : user.storageState }), use)
  },

  apiKeyApi: async ({ openapi, user }, use) => {
    await withClient(openapi, newApiContext({ headers: { Authorization: `Bearer ${user.apiKey}` } }), use)
  },

  anonApi: async ({ openapi }, use) => withClient(openapi, newApiContext(), use),

  freshUserHandle: async ({ adminApi, openapi }, use, testInfo) => {
    let created: Promise<Tenant> | undefined
    await use({
      get: () => (created ??= createTenant(adminApi, openapi, 'fresh', `fresh-${testInfo.workerIndex}-${testInfo.testId}`)),
    })
    if (created) await deleteUser(adminApi, (await created).id)
  },

  freshUser: async ({ freshUserHandle }, use) => use(await freshUserHandle.get()),

  freshApi: async ({ openapi, freshUser }, use) => withClient(openapi, newApiContext({ storageState: freshUser.storageState }), use),

  mcp: async ({ mcpScopes, oauthClient, role, user }, use) => {
    const session = await newApiContext({ storageState: role === 'admin' ? env.paths.adminState : user.storageState })
    try {
      const connection = await connectMcp(session, { scopes: mcpScopes, client: oauthClient })
      try {
        await use(connection)
      } finally {
        await connection.close()
      }
    } finally {
      await session.dispose()
    }
  },

  mcpKey: async ({ user }, use) => {
    const client = await connectMcpWithKey(user.apiKey)
    try {
      await use(client)
    } finally {
      await client.close()
    }
  },

  webauthn: async ({ page }, use) => {
    const authenticator = await installVirtualAuthenticator(page)
    try {
      await use(authenticator)
    } finally {
      await authenticator.dispose()
    }
  },

  tasks: async ({ api }, use) => {
    const created: string[] = []
    const upload = async (dir: string, options: { name?: string; expectState?: Revision['state'] } = {}) => {
      const name = options.name ?? unique(await manifestName(dir))
      created.push(name)
      return uploadAndPublish(api, dir, name, { expectState: options.expectState })
    }
    await use({
      upload,
      fixture: (name, options) => upload(fixtureTaskDir(name), options),
      example: (dir, options) => upload(exampleTaskDir(dir), options),
      track: (task) => void created.push(task),
    })
    for (const task of created.reverse()) {
      // A scan that is still being deleted holds the task (409 taskInUse) for a moment.
      for (let attempt = 1; ; attempt++) {
        try {
          await deleteTask(api, task)
          break
        } catch (error) {
          const inUse = error instanceof ApiError && error.response.status === 409
          if (!inUse || attempt >= 30) throw error
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      }
    }
  },

  // Depends on `tasks`, so its teardown (scans first) runs before the tasks are deleted.
  scans: async ({ api, tasks: _tasks }, use) => {
    const started: string[] = []
    await use({
      start: async (body) => {
        const scan = await startScan(api, body)
        started.push(scan.id)
        return scan
      },
      wait: (scanId, options = {}) => waitForScanState(api, scanId, options.state ?? 'completed', options.timeoutMs),
      counts: (scanId) => scanCounts(api, scanId),
      track: (scanId) => void started.push(scanId),
    })
    for (const scanId of started.reverse()) await cancelAndDeleteScan(api, scanId, { waitForJob: true })
  },
})
