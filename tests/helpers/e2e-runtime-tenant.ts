import { randomBytes } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { APIRequestContext } from '@playwright/test'
import type { Tenant } from '../fixtures'
import { ApiClient, ApiError, ok, type ApiResponse } from './api-client'
import { env } from './env'
import { reserve } from './limiter'
import type { OpenApiIndex } from './openapi'
import { unique } from './unique'
import { createUser, deleteUser, newApiContext } from './users'

// Tenants and the admin session of the e2e runtime specs (helpers/e2e-runtime-fixtures.ts). The specs replace the
// shared `user`, `freshUserHandle` and `adminApi` fixtures with the functions below and use the tenant's API key for
// `api`, for reasons that only show while several `just test-exec` runs share one kept-alive stack:
//   - the shared tenants keep their session in `.auth/user-<workerIndex>.json`, which another run's worker with the
//     same index overwrites; these tenants save their session under a unique name;
//   - the shared admin session (`.auth/admin.json`) is signed out by other runs' tests; each worker here signs the
//     admin in once on its own;
//   - the limiter's rolling budget can still meet better-auth's per-IP 429 while other runs sign in continuously;
//     these sign-ins wait the 429 out and retry with a new limiter slot instead of failing the worker.
// In a single run of the suite they behave exactly like the shared fixtures.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** `POST /api/auth/sign-in/email` through the limiter, waiting out per-IP 429s until `timeoutMs`. */
async function signInPatiently(context: APIRequestContext, email: string, password: string, timeoutMs = 300_000): Promise<ApiResponse> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await reserve('/sign-in/email')
    const response = await context.post('/api/auth/sign-in/email', { data: { email, password } })
    const raw = await response.body()
    const headers = response.headers()
    const body: unknown = (headers['content-type'] ?? '').includes('json') && raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {}
    if (response.status() !== 429 || Date.now() > deadline) return { status: response.status(), headers, body, raw }
    const retryAfter = Number(headers['x-retry-after'] ?? '60')
    await sleep((Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, 1), 61) : 60) * 1000 + Math.random() * 3000)
  }
}

/** Creates a user as admin, signs in once (patiently), saves the session under a unique name and creates a key. */
export async function createRuntimeTenant(adminApi: ApiClient, openapi: OpenApiIndex, prefix: string): Promise<Tenant> {
  const user = await createUser(adminApi, { prefix })
  try {
    const session = await newApiContext()
    try {
      const response = await signInPatiently(session, user.email, user.password)
      if (response.status !== 200) throw new ApiError(`sign-in of ${user.email}`, response)
      await mkdir(env.paths.auth, { recursive: true })
      const storageState = join(env.paths.auth, `e2e-runtime-${unique(prefix)}-${randomBytes(3).toString('hex')}.json`)
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

/** Deletes the tenant (202 with a userPurge job; 404 counts as deleted) and its storage state file. */
export async function deleteRuntimeTenant(adminApi: ApiClient, tenant: Tenant): Promise<void> {
  try {
    await deleteUser(adminApi, tenant.id)
  } finally {
    await rm(tenant.storageState, { force: true })
  }
}

/** Body of the worker-scoped `adminApi` override: a session of the seeded admin of its own. */
export async function runtimeAdminApi({ openapi }: { openapi: OpenApiIndex }, use: (api: ApiClient) => Promise<void>): Promise<void> {
  const session = await newApiContext()
  try {
    const response = await signInPatiently(session, env.admin.email, env.admin.password)
    if (response.status !== 200) throw new ApiError(`sign-in of ${env.admin.email}`, response)
    await use(new ApiClient(session, openapi))
  } finally {
    await session.dispose()
  }
}

interface FixtureDeps {
  adminApi: ApiClient
  openapi: OpenApiIndex
}

/** Body of the `freshUserHandle` override: a dedicated user created on first use and deleted after the test. */
export async function runtimeFreshUserHandle({ adminApi, openapi }: FixtureDeps, use: (handle: { get(): Promise<Tenant> }) => Promise<void>): Promise<void> {
  let created: Promise<Tenant> | undefined
  try {
    await use({ get: () => (created ??= createRuntimeTenant(adminApi, openapi, 'fresh')) })
  } finally {
    // A failed creation already deleted its user.
    const tenant = created ? await created.catch(() => null) : null
    if (tenant) await deleteRuntimeTenant(adminApi, tenant)
  }
}
