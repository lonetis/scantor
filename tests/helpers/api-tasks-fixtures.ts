import { randomBytes } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { APIRequestContext, WorkerInfo } from '@playwright/test'
import { ApiClient, ApiError, ok } from './api-client'
import { env } from './env'
import { reserve } from './limiter'
import type { OpenApiIndex } from './openapi'
import { createUser, deleteUser, newApiContext, type TestUser } from './users'

// Worker-scoped fixtures of the task API specs (api/tasks, task-files, git, credentials, revisions); each spec passes
// them to its own `test.extend`.
//
// Tenants: the shared `user` and `otherUser` fixtures keep their sessions in `.auth/user-<workerIndex>.json` and
// `.auth/other-<workerIndex>.json`. Several `just test-exec` runs against one kept-alive stack overwrite those files,
// so a test of one run would act as another run's tenant (and get 401 once that run deletes it). These overrides
// create the same kind of tenant with a storage state file of a unique name. better-auth's sign-in limiter resets its
// count only after a minute without an allowed sign-in, so while many runs sign in continuously the shared budget can
// run out regardless of the limiter's sliding window; these sign-ins then wait out the 429 (X-Retry-After) and retry.
//
// Shared tasks: publishing a revision builds an image in one of the stack's few build slots, so tests that only read a
// ready revision share one task per worker, created on first use and deleted when the worker ends.

/** The shape of the shared fixtures' Tenant: a user with a saved session and a `default` API key. */
export interface TasksTenant extends TestUser {
  storageState: string
  apiKey: string
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A request context signed in as the user: one limiter slot per attempt, a 429 is waited out until `timeoutMs`. */
async function patientSession(email: string, password: string, timeoutMs = 150_000): Promise<APIRequestContext> {
  const context = await newApiContext()
  try {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      await reserve('/sign-in/email')
      const response = await context.post('/api/auth/sign-in/email', { data: { email, password } })
      if (response.status() === 200) return context
      if (response.status() !== 429 || Date.now() > deadline) throw new Error(`sign-in of ${email} answered ${response.status()}: ${await response.text()}`)
      const retryAfter = Number(response.headers()['x-retry-after'] ?? '60')
      await sleep((Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, 1), 61) : 60) * 1000 + Math.random() * 2000)
    }
  } catch (error) {
    await context.dispose()
    throw error
  }
}

async function createTenant(adminApi: ApiClient, openapi: OpenApiIndex, prefix: string): Promise<TasksTenant> {
  const user = await createUser(adminApi, { prefix })
  try {
    const session = await patientSession(user.email, user.password)
    try {
      await mkdir(env.paths.auth, { recursive: true })
      const storageState = join(env.paths.auth, `api-tasks-${user.name}-${randomBytes(4).toString('hex')}.json`)
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

/** The worker fixture for `user` (kind 'user') or `otherUser` (kind 'other'). */
export function tenantFixture(kind: 'user' | 'other') {
  return async ({ adminApi, openapi }: { adminApi: ApiClient; openapi: OpenApiIndex }, use: (tenant: TasksTenant) => Promise<void>, workerInfo: WorkerInfo) => {
    const prefix = kind === 'user' ? `w${workerInfo.workerIndex}` : `w${workerInfo.workerIndex}-other`
    const tenant = await createTenant(adminApi, openapi, prefix)
    try {
      await use(tenant)
    } finally {
      await deleteUser(adminApi, tenant.id)
      await rm(tenant.storageState, { force: true })
    }
  }
}

/** A task the tests of one worker share; `name` is what the fixture deletes at the end. */
export interface SharedTask {
  name: string
}

/**
 * A worker fixture that runs `setup` once with the tenant's session (on first use) and deletes the task it returns
 * when the worker ends. A scan that is still being deleted holds the task (409 taskInUse); the tenant's deletion right
 * afterwards removes it then.
 */
export function sharedTaskFixture<T extends SharedTask>(setup: (api: ApiClient) => Promise<T>) {
  return async ({ openapi, user }: { openapi: OpenApiIndex; user: TasksTenant }, use: (task: T) => Promise<void>) => {
    const context = await newApiContext({ storageState: user.storageState })
    try {
      const api = new ApiClient(context, openapi)
      const shared = await setup(api)
      await use(shared)
      const deleted = await api.deleteTask(shared.name)
      if (![202, 404, 409].includes(deleted.status)) throw new ApiError(`deleteTask ${shared.name}`, deleted)
    } finally {
      await context.dispose()
    }
  }
}
