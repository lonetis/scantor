import type { Scan } from '#shared/types/scans'
import type { Tenant, ScansFixture, test as baseTest } from '../fixtures'
import { ApiClient, ApiError } from './api-client'
import { FakeNodes } from './e2e-runtime-nodes'
import { publishTask } from './e2e-runtime-publish'
import { joinRun, leaveRun, runOnce } from './e2e-runtime-run'
import { removeGeneratedTask, writeGeneratedTask, type GeneratedTaskKind } from './e2e-runtime-tasks'
import { createRuntimeTenant, deleteRuntimeTenant, runtimeAdminApi, runtimeFreshUserHandle } from './e2e-runtime-tenant'
import { cancelAndDeleteScan, scanCounts, startScan, waitForScanState, type StartScanBody } from './scans'
import { exampleTaskDir, fixtureTaskDir, manifestName, type UploadedTask } from './tasks'
import { unique } from './unique'
import { newApiContext } from './users'

// The fixtures of the e2e runtime specs (templates, scheduler, retries, files, workers, placement, breaker,
// privileged, backpressure, limits). Each spec extends the suite's `test` with `extendRuntime(test)`:
//   - `user` is one tenant per run, shared by every Playwright worker of the run (helpers/e2e-runtime-run.ts) and
//     deleted by the last worker that leaves; `api` acts through its API key (so `tasks` and `scans` do too);
//   - `shared` publishes each task the specs need once per run, as that tenant: a publish builds an image, and the
//     stack builds at most SCANTOR_BUILD_CONCURRENCY images at a time for all users; the tasks go with the tenant;
//   - `adminApi` and `freshUserHandle` come from helpers/e2e-runtime-tenant.ts (sessions of their own, so
//     concurrent runs on one kept-alive stack never share them);
//   - `scans` is the suite's fixture, except that its teardown cancels and deletes the test's scans in parallel and
//     does not wait for the scanDelete jobs (each takes over 10 s, docs/queue.md §6.3): the shared tasks outlive the
//     test anyway, and the suite's `tasks` fixture retries while a job still holds one of its tasks. Its waits and
//     counts wait out the per-user caps on concurrent waits and queries (429), which the workers share, and its starts
//     wait out broker alarms (503 brokerAlarm);
//   - `fakeNodes` are nodes in pools of their own whose daemon is the test (helpers/e2e-runtime-nodes.ts).

/** The tasks of one run, published on first use and reused by every later test of the run. */
export interface SharedTasks {
  /** A generated task (helpers/e2e-runtime-tasks.ts); `variant` gives a second copy with its own image digest. */
  generated(kind: GeneratedTaskKind, variant?: string): Promise<UploadedTask>
  /** An example task of tasks/<dir>. */
  example(dir: string): Promise<UploadedTask>
  /** A fixture task of tests/fixtures/tasks/<name>. */
  fixture(name: string): Promise<UploadedTask>
}

interface RuntimeTestFixtures {
  fakeNodes: FakeNodes
}

interface RuntimeWorkerFixtures {
  /** the run tenant's API key client, for worker-scoped setup */
  workerApi: ApiClient
  shared: SharedTasks
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Runs `fn` again while it fails with 429 (a per-user cap shared by the run's workers), until `timeoutMs`. */
async function patiently<T>(timeoutMs: number, fn: (remainingMs: number) => Promise<T>): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return await fn(Math.max(1000, deadline - Date.now()))
    } catch (error) {
      if (!(error instanceof ApiError && error.response.status === 429) || Date.now() >= deadline) throw error
      await sleep(500 + Math.random() * 1000)
    }
  }
}

/**
 * startScan, waiting out 503 brokerAlarm: RabbitMQ refuses new scans during a memory or disk alarm, which the chaos
 * project raises on purpose for a while (docs/testing.md §8.7) and a busy shared stack may raise briefly.
 */
async function startDespiteAlarms(api: ApiClient, body: StartScanBody): Promise<Scan> {
  const deadline = Date.now() + 120_000
  for (;;) {
    try {
      return await startScan(api, body)
    } catch (error) {
      const alarm =
        error instanceof ApiError && error.response.status === 503 && (error.response.body as { error?: { code?: string } }).error?.code === 'brokerAlarm'
      if (!alarm || Date.now() >= deadline) throw error
      await sleep(2000)
    }
  }
}

export function extendRuntime(base: typeof baseTest) {
  return base.extend<RuntimeTestFixtures, RuntimeWorkerFixtures>({
    adminApi: [runtimeAdminApi, { scope: 'worker' }],
    freshUserHandle: runtimeFreshUserHandle,
    api: async ({ apiKeyApi }, use) => use(apiKeyApi),

    user: [
      async ({ adminApi, openapi }, use) => {
        await joinRun()
        try {
          await use(await runOnce<Tenant>('tenant', () => createRuntimeTenant(adminApi, openapi, 'run')))
        } finally {
          const left = await leaveRun()
          const tenant = left.last ? (left.values.tenant as Tenant | undefined) : undefined
          if (tenant) await deleteRuntimeTenant(adminApi, tenant)
        }
      },
      { scope: 'worker' },
    ],

    scans: async ({ api, tasks: _tasks }, use) => {
      const started: string[] = []
      const fixture: ScansFixture = {
        start: async (body) => {
          const scan = await startDespiteAlarms(api, body)
          started.push(scan.id)
          return scan
        },
        wait: (scanId, options = {}) =>
          patiently(options.timeoutMs ?? 300_000, (remainingMs) => waitForScanState(api, scanId, options.state ?? 'completed', remainingMs)),
        counts: (scanId) => patiently(60_000, () => scanCounts(api, scanId)),
        track: (scanId) => void started.push(scanId),
      }
      await use(fixture)
      const results = await Promise.allSettled(started.map((scanId) => cancelAndDeleteScan(api, scanId)))
      const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason as unknown] : []))
      if (errors.length > 0) throw new AggregateError(errors, 'deleting the scans of the test failed')
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
        const publishDir = (dir: string, prefix: string) => publishTask(workerApi, dir, unique(prefix), { timeoutMs: 270_000 })
        await use({
          generated: (kind, variant = '') =>
            runOnce(`generated:${kind}:${variant}`, async () => {
              const dir = await writeGeneratedTask(kind)
              try {
                return await publishDir(dir, variant ? `${kind}-${variant}` : kind)
              } finally {
                await removeGeneratedTask(dir)
              }
            }),
          example: (dir) => runOnce(`example:${dir}`, async () => publishDir(exampleTaskDir(dir), await manifestName(exampleTaskDir(dir)))),
          fixture: (name) => runOnce(`fixture:${name}`, async () => publishDir(fixtureTaskDir(name), await manifestName(fixtureTaskDir(name)))),
        })
        // Nothing to delete here: the run's tenant is deleted by the last worker, and its purge removes the tasks
        // together with every scan that may still be deleting (docs/data-model.md §5).
      },
      { scope: 'worker' },
    ],

    fakeNodes: async ({ adminApi, openapi }, use) => {
      const nodes = new FakeNodes(adminApi, openapi)
      try {
        await use(nodes)
      } finally {
        await nodes.dispose()
      }
    },
  })
}
