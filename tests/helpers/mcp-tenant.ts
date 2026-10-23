import { randomBytes } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { APIRequestContext } from '@playwright/test'
import type { Tenant, test as fixturesTest } from '../fixtures'
import { ApiClient, ApiError, ok, type ApiResponse } from './api-client'
import { env } from './env'
import { reserve } from './limiter'
import type { OpenApiIndex } from './openapi'
import { startScan, TERMINAL_STATES, waitForScanState, type StartScanBody } from './scans'
import { exampleTaskDir, fixtureTaskDir, manifestName, removeDir, uploadAndPublish, type UploadedTask } from './tasks'
import { unique } from './unique'
import { createUser, deleteUser, newApiContext } from './users'
import { connectMcp } from './mcp'
import { reserveOAuth } from './mcp-limiter'
import { writeTaskDir } from './mcp-tools'
import type { Scan } from '#shared/types/scans'
import type { ScanState } from '#shared/utils/enums'

// Tenants and shared tasks of the mcp writer's specs. `withMcpTenants(test)` replaces the shared `user` and
// `freshUserHandle` fixtures, budgets the `mcp` fixture's OAuth requests and adds `sharedTasks`:
//   - the shared tenants keep their session in `.auth/user-<workerIndex>.json`, which another `just test-exec` run's
//     worker with the same index overwrites while several runs share one kept-alive stack (a test would then act as
//     that run's tenant, which its teardown deletes); these tenants save their session under a unique file name;
//   - a sign-in that still meets better-auth's per-IP 429 waits it out and retries with a new limiter slot;
//   - the `mcp` fixture's authorize and token requests take slots of helpers/mcp-limiter.ts first;
//   - publishing builds an image, so `sharedTasks` publishes each task a worker's tests reuse once per worker, and
//     `sharedScans` runs each scan that several read-only tests inspect once per worker; both are left to the purge
//     of the tenant at worker teardown.
// The `extend` call lives here, so every spec that wraps the fixtures' `test` with it shares one worker-fixture set
// and Playwright reuses the worker (its tenant and its shared tasks) across those spec files.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** `POST /api/auth/sign-in/email` through the limiter; a 429 is waited out and retried until `timeoutMs`. */
export async function signInPatiently(context: APIRequestContext, email: string, password: string, timeoutMs = 150_000): Promise<ApiResponse> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await reserve('/sign-in/email')
    const response = await context.post('/api/auth/sign-in/email', { data: { email, password } })
    const raw = await response.body()
    const headers = response.headers()
    const body: unknown = (headers['content-type'] ?? '').includes('json') && raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {}
    if (response.status() !== 429 || Date.now() > deadline) return { status: response.status(), headers, body, raw }
    const retryAfter = Number(headers['x-retry-after'] ?? '10')
    const waitSeconds = Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, 1), 61) : 10
    await sleep(Math.min(waitSeconds * 1000 + Math.random() * 1000, Math.max(deadline - Date.now(), 0)))
  }
}

/** A request context signed in as the user; dispose it after use. */
export async function patientSession(email: string, password: string): Promise<APIRequestContext> {
  const context = await newApiContext()
  try {
    const response = await signInPatiently(context, email, password)
    if (response.status !== 200) throw new ApiError(`sign-in of ${email}`, response)
    return context
  } catch (error) {
    await context.dispose()
    throw error
  }
}

/** Creates a user as admin, signs in once, saves the session under a unique file name and creates a `default` key. */
export async function createMcpTenant(adminApi: ApiClient, openapi: OpenApiIndex, options: { prefix: string; role?: 'user' | 'admin' }): Promise<Tenant> {
  const user = await createUser(adminApi, { prefix: options.prefix, role: options.role })
  try {
    const session = await patientSession(user.email, user.password)
    try {
      await mkdir(env.paths.auth, { recursive: true })
      const storageState = join(env.paths.auth, `mcp-${unique(options.prefix)}-${randomBytes(3).toString('hex')}.json`)
      await session.storageState({ path: storageState })
      const key = ok(await new ApiClient(session, openapi).createApiKey('tests'), 'createApiKey')
      return { ...user, storageState, apiKey: key.key }
    } finally {
      await session.dispose()
    }
  } catch (error) {
    await deleteUser(adminApi, user.id)
    throw error
  }
}

/** Deletes the tenant (a 404 counts as deleted) and its storage state file. */
export async function deleteMcpTenant(adminApi: ApiClient, tenant: Tenant): Promise<void> {
  try {
    await deleteUser(adminApi, tenant.id)
  } finally {
    await rm(tenant.storageState, { force: true })
  }
}

/**
 * Tasks published once per worker in the worker tenant's account and reused by its tests (read-only for them). They
 * are not deleted one by one: the tenant's deletion at worker teardown purges them with everything else it owns.
 */
export interface SharedTasks {
  /** An example task of tasks/<dir>. */
  example(dir: string): Promise<UploadedTask>
  /** A fixture task of tests/fixtures/tasks/<name>. */
  fixture(name: string): Promise<UploadedTask>
  /** A generated task folder: `files(name)` returns its files for the unique task name. */
  generated(key: string, files: (name: string) => Record<string, string>): Promise<UploadedTask>
}

/** Scans started once per worker in the worker tenant's account and inspected by its tests (read-only for them). */
export interface SharedScans {
  /**
   * The scan started under `key` with `body()`, waited for until `state` (default `completed`; `null` returns it at
   * once). Cancelled at worker teardown when it is still active; the tenant's deletion purges it.
   */
  get(key: string, body: () => Promise<StartScanBody>, options?: { state?: ScanState | ScanState[] | null; timeoutMs?: number }): Promise<Scan>
}

/** Caches the outcome of `create` per key; a failure is not cached, so the next test tries again. */
function onceByKey<T>(): (key: string, create: () => Promise<T>) => Promise<T> {
  const cache = new Map<string, Promise<T>>()
  return (key, create) => {
    let pending = cache.get(key)
    if (!pending) {
      pending = create()
      cache.set(key, pending)
      pending.catch(() => cache.delete(key))
    }
    return pending
  }
}

/** Cancels a scan that is not terminal yet (a 409 means it just finished, a 404 that it is gone). */
export async function cancelIfActive(api: ApiClient, scanId: string): Promise<void> {
  const response = await api.getScan(scanId)
  if (response.status === 404) return
  const current = ok(response, 'getScan')
  if (TERMINAL_STATES.includes(current.state) || current.state === 'deleting' || current.state === 'deleted') return
  const cancelled = await api.cancelScan(scanId)
  if (![200, 404, 409].includes(cancelled.status)) throw new ApiError(`cancelScan ${scanId}`, cancelled)
}

type FixturesTest = typeof fixturesTest

/** The fixtures' `test` with the worker tenant, the fresh user and the shared tasks of this file (see the header). */
export function withMcpTenants(base: FixturesTest) {
  return base.extend<object, { sharedTasks: SharedTasks; sharedScans: SharedScans }>({
    user: [
      async ({ adminApi, openapi }, use, workerInfo) => {
        const tenant = await createMcpTenant(adminApi, openapi, { prefix: `mcp-w${workerInfo.workerIndex}` })
        try {
          await use(tenant)
        } finally {
          await deleteMcpTenant(adminApi, tenant)
        }
      },
      { scope: 'worker', timeout: 180_000 },
    ],
    freshUserHandle: async ({ adminApi, openapi }, use) => {
      let created: Promise<Tenant> | undefined
      try {
        await use({ get: () => (created ??= createMcpTenant(adminApi, openapi, { prefix: 'mcp-fresh' })) })
      } finally {
        // A failed creation already deleted its user.
        const tenant = created ? await created.catch(() => null) : null
        if (tenant) await deleteMcpTenant(adminApi, tenant)
      }
    },
    mcp: async ({ mcpScopes, oauthClient, role, user }, use) => {
      const session = await newApiContext({ storageState: role === 'admin' ? env.paths.adminState : user.storageState })
      try {
        await reserveOAuth('/oauth2/authorize')
        await reserveOAuth('/oauth2/token')
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
    sharedTasks: [
      async ({ openapi, user }, use) => {
        const session = await newApiContext({ storageState: user.storageState })
        const api = new ApiClient(session, openapi)
        const once = onceByKey<UploadedTask>()
        const fromDir = async (dir: string): Promise<UploadedTask> => uploadAndPublish(api, dir, unique(await manifestName(dir)))
        try {
          await use({
            example: (dir) => once(`example:${dir}`, () => fromDir(exampleTaskDir(dir))),
            fixture: (name) => once(`fixture:${name}`, () => fromDir(fixtureTaskDir(name))),
            generated: (key, files) =>
              once(`generated:${key}`, async () => {
                const name = unique(key)
                const dir = await writeTaskDir(name, files(name))
                try {
                  return await uploadAndPublish(api, dir, name)
                } finally {
                  await removeDir(dir)
                }
              }),
          })
        } finally {
          await session.dispose()
        }
      },
      { scope: 'worker', timeout: 120_000 },
    ],
    sharedScans: [
      async ({ openapi, user, sharedTasks: _sharedTasks }, use) => {
        const session = await newApiContext({ storageState: user.storageState })
        const api = new ApiClient(session, openapi)
        const once = onceByKey<Scan>()
        const started: string[] = []
        try {
          await use({
            get: (key, body, options = {}) =>
              once(key, async () => {
                const scan = await startScan(api, await body())
                started.push(scan.id)
                const state = options.state === undefined ? 'completed' : options.state
                return state === null ? scan : waitForScanState(api, scan.id, state, options.timeoutMs ?? 150_000)
              }),
          })
          // Waiting for every scanDelete job here took minutes on the shared stack; the tenant's purge deletes them.
          for (const scanId of started) await cancelIfActive(api, scanId)
        } finally {
          await session.dispose()
        }
      },
      { scope: 'worker', timeout: 60_000 },
    ],
  })
}
