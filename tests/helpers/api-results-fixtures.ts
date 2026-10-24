import type { CreatedApiKey } from '#shared/types/account'
import type { Revision } from '#shared/types/revisions'
import type { Scan } from '#shared/types/scans'
import type { test as fixturesTest } from '../fixtures'
import { ApiClient, ok } from './api-client'
import { cancelActiveScans, openSharedTask, RESULT_ITEMS, RESULTS_SCAN_SETTINGS, settleScan, type SharedTask } from './api-results'
import { env } from './env'
import type { StartScanBody } from './scans'
import { unique } from './unique'
import { newApiContext, signedInContext } from './users'

// Fixture overrides and additions of the api-results specs, applied with `apiResultsTest(test)` to the test of
// fixtures.ts:
//
// - `adminApi` authenticates with a worker-owned `default` API key of the seeded admin instead of the `.auth/admin.json`
//   session: every global setup of a `just test-exec` run against the kept-alive stack saves a new admin session
//   there, and other suites may revoke admin sessions, which would turn this worker's admin calls into 401s.
// - `resultsetTask` (worker): the resultset task (helpers/api-results-task.ts) published once per worker, because
//   every publish waits for one of the stack's two build slots. Its active scans are cancelled at worker teardown; the
//   task and its scans go with the tenant, whose deletion right afterwards purges everything it owns.
// - `resultsScan` (worker): the finished results scan of that task (RESULT_ITEMS), read by the analyses and exports
//   specs, so a worker runs it once.
// - `resultset` (test): starts scans of that task and cancels the ones still active when the test ends.

type FixturesTest = typeof fixturesTest

export interface ResultsetScans {
  /** the tenant's client of the worker-scoped task */
  api: ApiClient
  taskName: string
  revision: Revision
  /** starts a scan of the shared revision (small settings unless the body sets them); cancelled after the test */
  start(body: Omit<StartScanBody, 'revision'>): Promise<Scan>
}

/** A `default` API key of the seeded admin, created with the shared admin session or, when that was revoked, a new one. */
async function adminKey(adminApi: ApiClient): Promise<CreatedApiKey> {
  const body = { name: unique('ar-admin') }
  const created = await adminApi.call<CreatedApiKey>('createApiKey', { body })
  if (created.status !== 401) return ok(created, 'createApiKey')
  const session = await signedInContext(env.admin.email, env.admin.password)
  try {
    return ok(await new ApiClient(session, adminApi.openapi).call<CreatedApiKey>('createApiKey', { body }), 'createApiKey')
  } finally {
    await session.dispose()
  }
}

/** The fixtures' test with the overrides and additions described above. */
export function apiResultsTest(base: FixturesTest) {
  return base.extend<{ resultset: ResultsetScans }, { resultsetTask: SharedTask; resultsScan: Scan }>({
    adminApi: [
      async ({ adminApi, openapi }, use) => {
        const key = await adminKey(adminApi)
        const request = await newApiContext({ headers: { Authorization: `Bearer ${key.key}` } })
        const client = new ApiClient(request, openapi)
        let deleted: number
        try {
          await use(client)
        } finally {
          deleted = (await client.call('deleteApiKey', { path: { keyId: key.apiKey.id } })).status
          await request.dispose()
        }
        if (deleted !== 204 && deleted !== 404) throw new Error(`deleteApiKey of the admin's test key answered ${deleted}`)
      },
      { scope: 'worker' },
    ],
    resultsetTask: [
      async ({ user, openapi }, use) => {
        const shared = await openSharedTask(user, openapi)
        try {
          await use(shared)
        } finally {
          await shared.close()
        }
      },
      // The first publish of a worker builds an image and may queue behind other builds of the stack.
      { scope: 'worker', timeout: 180_000 },
    ],
    resultsScan: [
      async ({ resultsetTask }, use) => {
        const started = await resultsetTask.start({ scanConfig: { items: [...RESULT_ITEMS] }, settings: RESULTS_SCAN_SETTINGS })
        await use(await settleScan(resultsetTask.api, started.id, 'completed', 170_000))
      },
      { scope: 'worker', timeout: 180_000 },
    ],
    resultset: async ({ resultsetTask }, use) => {
      const started: string[] = []
      await use({
        api: resultsetTask.api,
        taskName: resultsetTask.taskName,
        revision: resultsetTask.revision,
        start: async (body) => {
          const scan = await resultsetTask.start(body)
          started.push(scan.id)
          return scan
        },
      })
      await cancelActiveScans(resultsetTask.api, started)
    },
  })
}
