import type { Revision } from '#shared/types/revisions'
import type { ScansFixture, TasksFixture } from '../fixtures'
import { ApiError, type ApiClient } from './api-client'
import { cancelAndDeleteScan, scanCounts, startScan, waitForScanState } from './scans'
import { exampleTaskDir, fixtureTaskDir, manifestName, uploadAndPublish } from './tasks'
import { unique } from './unique'

// The `tasks` and `scans` fixtures of the api-platform writer's specs. They behave like the shared ones (tests see the
// same interface), but their teardown never waits for the platform's deletion jobs: scanDelete runs at most two jobs at
// a time for the whole stack (docs/data-model.md §4.12), so while other runs delete scans, waiting for this test's job
// can take minutes. A scan is cancelled and its deletion requested; a task whose deletion is refused because one of
// those scans is still being deleted (409 taskInUse) is left to the purge of the worker's tenant, which deletes
// everything the tenant owns at worker teardown (docs/testing.md §7.7). All names are unique, so nothing that is
// deleted late can meet another test.

/** Body of a `tasks` override for specs whose tasks belong to the worker's tenant (`api`). */
export async function withPlatformTasks(api: ApiClient, use: (tasks: TasksFixture) => Promise<void>): Promise<void> {
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
  for (const task of created.reverse()) await deleteTaskOrLeaveToPurge(api, task)
}

/** Body of a `scans` override: cancels and deletes every scan of the test without waiting for the deletion job. */
export async function withPlatformScans(api: ApiClient, use: (scans: ScansFixture) => Promise<void>): Promise<void> {
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
  for (const scanId of started.reverse()) await cancelAndDeleteScan(api, scanId)
}

/**
 * Deletes a task (202, or 404 when it is gone). 409 taskInUse means a scan of the task is still being deleted: the
 * task then stays until the tenant's purge, which is the documented backstop. Any other answer fails the teardown.
 */
export async function deleteTaskOrLeaveToPurge(api: ApiClient, task: string): Promise<void> {
  const response = await api.deleteTask(task)
  if (response.status === 202 || response.status === 404) return
  const code = (response.body as { error?: { code?: string } }).error?.code
  if (response.status === 409 && code === 'taskInUse') return
  throw new ApiError(`deleteTask ${task}`, response)
}
