import { randomBytes } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { APIRequestContext } from '@playwright/test'
import { ApiClient, ApiError, ok, type ApiResponse } from './api-client'
import { env } from './env'
import { reserve } from './limiter'
import type { OpenApiIndex } from './openapi'
import { unique } from './unique'
import { createUser, deleteUser, newApiContext, type TestUser } from './users'

// Tenants and the admin of the api-platform writer's specs. They replace the shared `adminApi`, `user` and
// `freshUser` fixtures in these specs (the specs override them with the functions below) for reasons that only show
// while several `just test-exec` runs share one kept-alive stack:
//   - the shared `adminApi` is the seeded admin's session from `.auth/admin.json`, which every run's global setup
//     rewrites and which any test that revokes the seeded admin's other sessions ends for every run at once; these
//     specs act as an admin of their own (`withPlatformAdmin`), created per worker by a private session of the
//     seeded admin;
//   - the shared tenants keep their session in `.auth/user-<workerIndex>.json`, which another run's worker with the
//     same index overwrites (a test would then act as the other run's tenant, deleted at that run's teardown);
//     these tenants use a storage state file with a unique name;
//   - each run has a limiter of its own view of the shared budget (better-auth's per-IP limits, scaled by
//     SCANTOR_AUTH_RATE_LIMIT_SCALE); should several runs still meet a 429, these sign-ins wait it out once and retry
//     with a new limiter slot instead of failing the worker.

/** A user with a saved session and a `default` API key; the shape of the shared fixtures' Tenant. */
export interface PlatformTenant extends TestUser {
  storageState: string
  apiKey: string
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `POST /api/auth/sign-in/email` through the limiter; a 429 is waited out (`X-Retry-After`) and retried with a new
 * limiter slot until `timeoutMs`. Returns the last response (also a failing one).
 */
export async function signInPatiently(context: APIRequestContext, email: string, password: string, timeoutMs = 90_000): Promise<ApiResponse> {
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

/** A request context signed in as the user (waits out per-IP 429s). */
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

/** Creates a user as admin, signs in once (patiently), saves the session under a unique name and creates a key. */
export async function createPlatformTenant(
  adminApi: ApiClient,
  openapi: OpenApiIndex,
  options: { prefix: string; role?: 'user' | 'admin' },
): Promise<PlatformTenant> {
  const user = await createUser(adminApi, { prefix: options.prefix, role: options.role })
  try {
    const session = await patientSession(user.email, user.password)
    try {
      await mkdir(env.paths.auth, { recursive: true })
      const storageState = join(env.paths.auth, `api-platform-${unique(options.prefix)}-${randomBytes(3).toString('hex')}.json`)
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
export async function deletePlatformTenant(adminApi: ApiClient, tenant: PlatformTenant): Promise<void> {
  try {
    await deleteUser(adminApi, tenant.id)
  } finally {
    await rm(tenant.storageState, { force: true })
  }
}

/** A private session of the seeded admin (one limiter slot). */
function seededAdminSession(): Promise<APIRequestContext> {
  return patientSession(env.admin.email, env.admin.password)
}

/**
 * Body of a worker-scoped `adminApi` override: an admin user of the worker, created (and finally deleted) through a
 * private session of the seeded admin, so neither another run's global setup nor a revocation of the seeded admin's
 * sessions reaches it. Everything these specs do as the admin needs only admin power, not the seeded account.
 */
export async function withPlatformAdmin(openapi: OpenApiIndex, use: (adminApi: ApiClient) => Promise<void>): Promise<void> {
  const creator = await seededAdminSession()
  let admin: PlatformTenant
  try {
    admin = await createPlatformTenant(new ApiClient(creator, openapi), openapi, { prefix: 'platform-admin', role: 'admin' })
  } finally {
    await creator.dispose()
  }
  const session = await stateContext(admin.storageState)
  try {
    await use(new ApiClient(session, openapi))
  } finally {
    await session.dispose()
    const remover = await seededAdminSession()
    try {
      await deletePlatformTenant(new ApiClient(remover, openapi), admin)
    } finally {
      await remover.dispose()
    }
  }
}

/** Body of a worker-scoped `user` override: one tenant per worker. */
export async function withWorkerTenant(
  adminApi: ApiClient,
  openapi: OpenApiIndex,
  prefix: string,
  use: (tenant: PlatformTenant) => Promise<void>,
): Promise<void> {
  const tenant = await createPlatformTenant(adminApi, openapi, { prefix })
  try {
    await use(tenant)
  } finally {
    await deletePlatformTenant(adminApi, tenant)
  }
}

/** Body of a `freshUserHandle` override: a dedicated user created on first use and deleted after the test. */
export async function withLazyTenant(
  adminApi: ApiClient,
  openapi: OpenApiIndex,
  prefix: string,
  use: (handle: { get(): Promise<PlatformTenant> }) => Promise<void>,
): Promise<void> {
  let created: Promise<PlatformTenant> | undefined
  try {
    await use({ get: () => (created ??= createPlatformTenant(adminApi, openapi, { prefix })) })
  } finally {
    // A failed creation already deleted its user.
    const tenant = created ? await created.catch(() => null) : null
    if (tenant) await deletePlatformTenant(adminApi, tenant)
  }
}

/** A request context on the public origin with the given session (a storage state file). */
export function stateContext(storageState: string): Promise<APIRequestContext> {
  return newApiContext({ storageState })
}
