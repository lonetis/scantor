import { readFile } from 'node:fs/promises'
import { request, type APIRequestContext } from '@playwright/test'
import type { Revision } from '#shared/types/revisions'
import type { Scan } from '#shared/types/scans'
import type { test as baseTest } from '../fixtures'
import { ApiClient, ApiError, ok } from './api-client'
import { env } from './env'
import type { OpenApiIndex } from './openapi'
import { ThrowawayInfra } from './orchestrator'
import { PROBE_TASK, removeTaskDir, writeTaskDir } from './security-tasks'
import { scanCounts, startScan, TERMINAL_STATES, waitForScanState, type StartScanBody } from './scans'
import { exampleTaskDir, fixtureTaskDir, manifestName, uploadAndPublish, type UploadedTask } from './tasks'
import { unique } from './unique'
import { newApiContext } from './users'

// Worker fixtures of the security specs (docs/testing.md §7.7, §9) on top of fixtures.ts. Many `just test-exec` runs
// share one stack, which shapes three differences:
//   - `adminApi` reads the seeded admin's session from global setup's `.auth/admin.json` once per worker, with a retry
//     (every run's global setup rewrites that file with a new session while other runs' workers start; the old sessions
//     stay valid);
//   - `tasks` and `scans` only request their deletions at teardown instead of waiting for the delete jobs, which queue
//     behind every concurrent run's (the tenant's purge at worker teardown removes whatever is still left);
//   - `shared` publishes a task once per worker and reuses it (and one completed scan per key) across the tests of the
//     worker, because every publish takes one of the stack's two build slots; deleting the tenant at worker teardown
//     purges what it created.
// `throwawayInfra` is the private MongoDB, S3 and Docker of the worker's throwaway orchestrators (helpers/orchestrator.ts).

type StorageState = Exclude<Parameters<typeof request.newContext>[0], undefined>['storageState']

/** A storage state file, read with a retry: a concurrent run's global setup may be rewriting it right now. */
async function readStorageState(path: string): Promise<StorageState> {
  for (let attempt = 1; ; attempt++) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as StorageState
    } catch (error) {
      if (attempt >= 10) throw error
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}

/** An ApiClient on a request context of the public origin (helpers/users.ts), disposed after `use`. */
async function withClient(openapi: OpenApiIndex, context: Promise<APIRequestContext>, use: (client: ApiClient) => Promise<void>): Promise<void> {
  const request = await context
  try {
    await use(new ApiClient(request, openapi))
  } finally {
    await request.dispose()
  }
}

/** The same context as helpers/users.ts newApiContext, from an in-memory storage state. */
function contextWithState(storageState: StorageState): Promise<APIRequestContext> {
  return request.newContext({ baseURL: env.publicUrl, timeout: 150_000, extraHTTPHeaders: { Origin: env.publicUrl }, storageState })
}

/** Cancels a scan that is still active and requests its deletion without waiting for the scanDelete job. */
export async function requestScanDeletion(api: ApiClient, scanId: string): Promise<void> {
  const current = await api.getScan(scanId)
  if (current.status === 404) return
  const scan = ok(current, 'getScan')
  if (scan.state === 'deleting' || scan.state === 'deleted') return
  if (!TERMINAL_STATES.includes(scan.state)) {
    const cancelled = await api.cancelScan(scanId)
    if (![200, 404, 409].includes(cancelled.status)) throw new ApiError(`cancelScan ${scanId}`, cancelled)
    await waitForScanState(api, scanId, TERMINAL_STATES, 60_000)
  }
  const deleted = await api.deleteScan(scanId)
  if (![202, 404, 409].includes(deleted.status)) throw new ApiError(`deleteScan ${scanId}`, deleted)
}

/** Requests a task's deletion; a task still held by a scan being deleted (409 taskInUse) goes with the tenant's purge. */
export async function requestTaskDeletion(api: ApiClient, task: string): Promise<void> {
  const response = await api.deleteTask(task)
  if (![202, 404].includes(response.status) && !(response.status === 409 && (response.body as { error?: { code?: string } }).error?.code === 'taskInUse')) {
    throw new ApiError(`deleteTask ${task}`, response)
  }
}

/** Tasks published once per worker as the worker's tenant, and completed scans of them. */
export interface SharedTasks {
  /** A fixture task of tests/fixtures/tasks/<name>, published ready. */
  fixture(name: string): Promise<UploadedTask>
  /** A task generated from files (helpers/security-tasks.ts), published ready; `key` identifies it. */
  generated(key: string, files: Record<string, string>): Promise<UploadedTask>
  /** The general-purpose `probe` task of helpers/security-tasks.ts (modes ok, files, hang), published ready. */
  probe(): Promise<UploadedTask>
  /** A scan of a shared task that completed, started once per key; tests must not change it. */
  completedScan(key: string, body: () => Promise<StartScanBody>): Promise<Scan>
}

export interface SecurityWorkerFixtures {
  /** the worker tenant's session as a worker-scoped client (for worker-scoped setup) */
  tenantApi: ApiClient
  shared: SharedTasks
  /**
   * Private MongoDB, S3 and Docker for throwaway orchestrators (helpers/orchestrator.ts), started on first use and
   * shared by the worker's throwaways one after the other; each orchestrator gets its own database and bucket.
   */
  throwawayInfra: ThrowawayInfra
}

let extended: ReturnType<typeof extend> | undefined

/**
 * The fixtures of fixtures.ts with `adminApi`, `tasks` and `scans` replaced and `tenantApi`, `shared` and
 * `throwawayInfra` added, as described above. The extended test is created once, so every spec file that uses it has
 * the same worker fixtures and Playwright can run the files in the same workers (sharing tenants, published tasks and
 * infrastructure).
 */
export function withSecurityTenants(base: typeof baseTest) {
  return (extended ??= extend(base))
}

function extend(base: typeof baseTest) {
  return base.extend<object, SecurityWorkerFixtures>({
    throwawayInfra: [
      async ({}, use) => {
        const infra = await ThrowawayInfra.start(unique('scantor-test-infra'))
        try {
          await use(infra)
        } finally {
          await infra.dispose()
        }
      },
      { scope: 'worker', timeout: 150_000 },
    ],
    adminApi: [async ({ openapi }, use) => withClient(openapi, contextWithState(await readStorageState(env.paths.adminState)), use), { scope: 'worker' }],
    tenantApi: [async ({ openapi, user }, use) => withClient(openapi, newApiContext({ storageState: user.storageState }), use), { scope: 'worker' }],
    tasks: async ({ api }, use) => {
      const created: string[] = []
      const upload = async (dir: string, options: { name?: string; expectState?: Revision['state'] } = {}) => {
        const name = options.name ?? unique(await manifestName(dir))
        created.push(name)
        return uploadAndPublish(api, dir, name, { expectState: options.expectState, timeoutMs: 170_000 })
      }
      await use({
        upload,
        fixture: (name, options) => upload(fixtureTaskDir(name), options),
        example: (dir, options) => upload(exampleTaskDir(dir), options),
        track: (task) => void created.push(task),
      })
      for (const task of created.reverse()) await requestTaskDeletion(api, task)
    },
    scans: async ({ api, tasks: _tasks }, use) => {
      const started: string[] = []
      await use({
        start: async (body) => {
          const scan = await startScan(api, body)
          started.push(scan.id)
          return scan
        },
        wait: (scanId, options = {}) => waitForScanState(api, scanId, options.state ?? 'completed', options.timeoutMs ?? 170_000),
        counts: (scanId) => scanCounts(api, scanId),
        track: (scanId) => void started.push(scanId),
      })
      for (const scanId of started.reverse()) await requestScanDeletion(api, scanId)
    },
    shared: [
      async ({ tenantApi }, use) => {
        const published = new Map<string, Promise<UploadedTask>>()
        const scans = new Map<string, Promise<Scan>>()
        /** every scan started, so a scan still running at teardown (a failed wait) is cancelled */
        const started: string[] = []
        // A failed attempt is forgotten, so the next test of the worker tries again instead of inheriting the failure.
        const once = <T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> => {
          let entry = cache.get(key)
          if (!entry) {
            entry = make()
            cache.set(key, entry)
            entry.catch(() => cache.get(key) === entry && cache.delete(key))
          }
          return entry
        }
        const publishDir = async (dir: string) => uploadAndPublish(tenantApi, dir, unique(await manifestName(dir)), { timeoutMs: 170_000 })
        const generated = (key: string, files: Record<string, string>) =>
          once(published, `generated:${key}`, async () => {
            const dir = await writeTaskDir(files, key)
            try {
              return await publishDir(dir)
            } finally {
              await removeTaskDir(dir)
            }
          })
        await use({
          fixture: (name) => once(published, `fixture:${name}`, () => publishDir(fixtureTaskDir(name))),
          generated,
          probe: () => generated('probe', PROBE_TASK),
          completedScan: (key, body) =>
            once(scans, key, async () => {
              const scan = await startScan(tenantApi, await body())
              started.push(scan.id)
              return waitForScanState(tenantApi, scan.id, 'completed', 170_000)
            }),
        })
        // Deleting the tenant at worker teardown (the `user` fixture) purges these tasks and scans with everything else
        // it owns (docs/testing.md §7.7); waiting here for every delete job would only slow the teardown down.
        await Promise.allSettled([...scans.values(), ...published.values()])
        for (const scanId of started) {
          const cancelled = await tenantApi.cancelScan(scanId)
          if (![200, 404, 409].includes(cancelled.status)) throw new ApiError(`cancelScan ${scanId}`, cancelled)
        }
      },
      { scope: 'worker' },
    ],
  })
}
