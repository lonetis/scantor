import { randomBytes } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { APIRequestContext } from '@playwright/test'
import type { ScansFixture, TasksFixture, Tenant, test as baseTest } from '../fixtures'
import { ApiClient, ApiError, ok, type ApiResponse } from './api-client'
import { env } from './env'
import { reserve } from './limiter'
import type { OpenApiIndex } from './openapi'
import { scanCounts, startScan, TERMINAL_STATES, waitForScanState } from './scans'
import { settleAll } from './e2e-examples-cli-tasks'
import { deleteTask, exampleTaskDir, fixtureTaskDir, manifestName, uploadAndPublish, type UploadedTask } from './tasks'
import { unique } from './unique'
import { createUser, deleteUser, newApiContext, type CreateUserOptions, type TestUser } from './users'

// The fixtures of the e2e example, CLI, scaffold, debug and remote-node specs. Each spec extends the suite's `test`
// with `extendExamplesCli(test)`, which returns one shared object, so a worker moves between these files without a
// restart and keeps its tenant and its published examples:
//   - `adminApi`, `user` and `freshUserHandle` are sessions of their own: several `just test-exec` runs can share one
//     kept-alive stack, and the global setup of every run rewrites the admin session of `.auth/admin.json` while the
//     workers of another run may still read it. Each worker signs the admin in once, and the tenants keep their
//     session under a unique file name. Sign-ins go through the limiter and wait out a 429.
//   - `shared` publishes each example a spec needs once per Playwright worker (a publish builds an image; `prefetch`
//     queues several builds at once) and deletes it at worker teardown, after the test-scoped `scans` fixture deleted
//     every scan that used it.
//   - `tasks` and `scans` clean up like the shared fixtures, all of a test's resources at once, but do not fail a test
//     whose cleanup is merely slow: the scanDelete jobs of a busy shared stack can stay queued for minutes (two run at
//     a time on the whole stack). A scan whose delete job is still pending after a short wait, and a task such a scan
//     still holds (409 taskInUse), are left to the tenant's userPurge at worker teardown, which removes everything the
//     tenant owns (docs/testing.md §7.7). A failed delete job or any other cleanup error still fails the test.
// In a single run of the suite they behave like the shared fixtures.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** `POST /api/auth/sign-in/email` through the limiter, waiting out per-IP 429s until `timeoutMs`. */
async function signInPatiently(context: APIRequestContext, email: string, password: string, timeoutMs = 180_000): Promise<ApiResponse> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await reserve('/sign-in/email')
    const response = await context.post('/api/auth/sign-in/email', { data: { email, password } })
    const raw = await response.body()
    const headers = response.headers()
    const body: unknown = (headers['content-type'] ?? '').includes('json') && raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {}
    if (response.status() !== 429 || Date.now() > deadline) return { status: response.status(), headers, body, raw }
    const retryAfter = Number(headers['x-retry-after'] ?? '10')
    await sleep((Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, 1), 61) : 10) * 1000 + Math.random() * 2000)
  }
}

/** A request context signed in as the user (patiently); throws unless the sign-in succeeds. */
export async function signedInPatiently(email: string, password: string): Promise<APIRequestContext> {
  const session = await newApiContext()
  try {
    const response = await signInPatiently(session, email, password)
    if (response.status !== 200) throw new ApiError(`sign-in of ${email}`, response)
    return session
  } catch (error) {
    await session.dispose()
    throw error
  }
}

/** A user created by the admin with an API key (`apiKey`) and, with `storageState`, its saved session. */
export interface UserWithKey extends TestUser {
  apiKey: string
}

/**
 * Creates a user as admin, signs in once, creates an API key with that session and, when `stateFile` is given, saves
 * the session there. The user is deleted again when a step fails.
 */
async function createUserWithKey(adminApi: ApiClient, openapi: OpenApiIndex, options: CreateUserOptions, stateFile?: string): Promise<UserWithKey> {
  const user = await createUser(adminApi, options)
  try {
    const session = await signedInPatiently(user.email, user.password)
    try {
      if (stateFile) await session.storageState({ path: stateFile })
      const key = ok(await new ApiClient(session, openapi).createApiKey('tests'), 'createApiKey')
      return { ...user, apiKey: key.key }
    } finally {
      await session.dispose()
    }
  } catch (error) {
    await deleteUser(adminApi, user.id)
    throw error
  }
}

/** A tenant whose session file has a name no other run uses. */
async function createTenant(adminApi: ApiClient, openapi: OpenApiIndex, prefix: string): Promise<Tenant> {
  await mkdir(env.paths.auth, { recursive: true })
  const storageState = join(env.paths.auth, `e2e-examples-cli-${unique(prefix)}-${randomBytes(3).toString('hex')}.json`)
  const user = await createUserWithKey(adminApi, openapi, { prefix }, storageState)
  return { ...user, storageState }
}

async function deleteTenant(adminApi: ApiClient, tenant: Tenant): Promise<void> {
  try {
    await deleteUser(adminApi, tenant.id)
  } finally {
    await rm(tenant.storageState, { force: true })
  }
}

/** A dedicated admin with an API key, for CLI commands that need admin power; delete it with `deleteUser`. */
export function createAdminWithKey(adminApi: ApiClient, openapi: OpenApiIndex, prefix: string): Promise<UserWithKey> {
  return createUserWithKey(adminApi, openapi, { prefix, role: 'admin' })
}

/** How long a teardown waits for one scanDelete job before leaving the rest to the tenant's purge. */
const DELETE_JOB_WAIT_S = 10
/** How long a test teardown retries a task deletion that a deleting scan blocks (409 taskInUse). */
const TASK_IN_USE_RETRY_MS = 20_000

/** Cancels a scan unless it is terminal, deletes it and waits briefly for its job; false when the job is pending. */
async function cancelAndDeleteScan(api: ApiClient, scanId: string): Promise<boolean> {
  const current = await api.getScan(scanId)
  if (current.status === 404) return true
  const scan = ok(current, 'getScan')
  if (scan.state === 'deleting' || scan.state === 'deleted') return true
  if (!TERMINAL_STATES.includes(scan.state)) {
    const cancelled = await api.cancelScan(scanId)
    if (cancelled.status !== 200 && cancelled.status !== 409) throw new ApiError(`cancelScan ${scanId}`, cancelled)
    await waitForScanState(api, scanId, TERMINAL_STATES, 60_000)
  }
  const deleted = await api.deleteScan(scanId)
  if (deleted.status === 404) return true
  if (deleted.status !== 202) throw new ApiError(`deleteScan ${scanId}`, deleted)
  const job = ok(await api.getJob(deleted.body.job.id, DELETE_JOB_WAIT_S), 'getJob')
  if (job.state === 'failed' || job.state === 'cancelled') throw new Error(`the scanDelete job of ${scanId} ended ${job.state}: ${JSON.stringify(job.error)}`)
  return job.state === 'succeeded'
}

/** Deletes a task; false when a scan that is still being deleted keeps holding it (409 taskInUse) for `retryMs`. */
async function deleteTaskUnlessInUse(api: ApiClient, task: string, retryMs = TASK_IN_USE_RETRY_MS): Promise<boolean> {
  const deadline = Date.now() + retryMs
  for (;;) {
    try {
      await deleteTask(api, task)
      return true
    } catch (error) {
      if (!(error instanceof ApiError && error.response.status === 409)) throw error
      if (Date.now() > deadline) return false
      await sleep(2000)
    }
  }
}

/** The example tasks of one Playwright worker, published on first use and reused by every later test. */
export interface SharedExamples {
  /** tasks/<dir> under a unique name, published once per worker; never change or delete it in a test */
  example(dir: string): Promise<UploadedTask>
  /**
   * Starts publishing these examples without waiting, so their builds queue together; a failed publish surfaces in
   * the `example(dir)` call of the test that needs it.
   */
  prefetch(dirs: string[]): void
}

interface WorkerFixtures {
  /** the worker tenant's API key client, for worker-scoped setup */
  workerApi: ApiClient
  shared: SharedExamples
}

/**
 * The suite's `test` with these fixtures. Every spec gets the same extended object, so Playwright reuses a worker (its
 * tenant and its published examples) across the spec files instead of restarting it for each file.
 */
export function extendExamplesCli(base: typeof baseTest): ExtendedTest {
  extended ??= extend(base)
  return extended
}

type ExtendedTest = ReturnType<typeof extend>
let extended: ExtendedTest | undefined

function extend(base: typeof baseTest) {
  return base.extend<object, WorkerFixtures>({
    tasks: async ({ api }, use, testInfo) => {
      const created: string[] = []
      const upload: TasksFixture['upload'] = async (dir, options = {}) => {
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
      await settleAll(
        [...new Set(created)].map(async (task) => {
          if (!(await deleteTaskUnlessInUse(api, task)))
            testInfo.annotations.push({ type: 'cleanup', description: `task ${task} is left to the tenant's purge` })
        }),
      )
    },

    // Depends on `tasks`, so its teardown (scans first) runs before the tasks are deleted.
    scans: async ({ api, tasks: _tasks }, use, testInfo) => {
      const started: string[] = []
      const fixture: ScansFixture = {
        start: async (body) => {
          const scan = await startScan(api, body)
          started.push(scan.id)
          return scan
        },
        wait: (scanId, options = {}) => waitForScanState(api, scanId, options.state ?? 'completed', options.timeoutMs),
        counts: (scanId) => scanCounts(api, scanId),
        track: (scanId) => void started.push(scanId),
      }
      await use(fixture)
      // All at once: each scan waits for its own cancellation and delete job.
      await settleAll(
        [...new Set(started)].map(async (scanId) => {
          if (!(await cancelAndDeleteScan(api, scanId)))
            testInfo.annotations.push({ type: 'cleanup', description: `the delete job of scan ${scanId} is still pending` })
        }),
      )
    },

    adminApi: [
      async ({ openapi }, use) => {
        const session = await signedInPatiently(env.admin.email, env.admin.password)
        try {
          await use(new ApiClient(session, openapi))
        } finally {
          await session.dispose()
        }
      },
      { scope: 'worker' },
    ],

    user: [
      async ({ adminApi, openapi }, use, workerInfo) => {
        const tenant = await createTenant(adminApi, openapi, `w${workerInfo.workerIndex}`)
        try {
          await use(tenant)
        } finally {
          await deleteTenant(adminApi, tenant)
        }
      },
      { scope: 'worker' },
    ],

    freshUserHandle: async ({ adminApi, openapi }, use) => {
      let created: Promise<Tenant> | undefined
      try {
        await use({ get: () => (created ??= createTenant(adminApi, openapi, 'fresh')) })
      } finally {
        // A failed creation already deleted its user.
        const tenant = created ? await created.catch(() => null) : null
        if (tenant) await deleteTenant(adminApi, tenant)
      }
    },

    workerApi: [
      async ({ openapi, user }, use) => {
        const request = await newApiContext({ headers: { Authorization: `Bearer ${user.apiKey}` } })
        try {
          await use(new ApiClient(request, openapi))
        } finally {
          await request.dispose()
        }
      },
      { scope: 'worker' },
    ],

    shared: [
      async ({ workerApi }, use) => {
        const cache = new Map<string, Promise<UploadedTask>>()
        const created: string[] = []
        const example = (dir: string): Promise<UploadedTask> => {
          let pending = cache.get(dir)
          if (!pending) {
            pending = (async () => {
              const path = exampleTaskDir(dir)
              const name = unique(await manifestName(path))
              created.push(name)
              return uploadAndPublish(workerApi, path, name)
            })()
            cache.set(dir, pending)
          }
          return pending
        }
        await use({
          example,
          // The rejection stays in the cache for the test that awaits it; this copy only keeps it from going unhandled.
          prefetch: (dirs) => dirs.forEach((dir) => void example(dir).catch(() => undefined)),
        })
        // Publishes that no test awaited still have to finish before their tasks can go.
        await Promise.allSettled(cache.values())
        // A task a deleting scan still holds is removed by the tenant's purge right after this teardown, so no retries.
        for (const task of created.reverse()) await deleteTaskUnlessInUse(workerApi, task, 0)
      },
      { scope: 'worker' },
    ],
  })
}
