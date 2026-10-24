import type { Scan } from '#shared/types/scans'
import type { TestRun } from '#shared/types/test-runs'
import type { User } from '#shared/types/users'
import { ok, type ApiClient } from '../helpers/api-client'
import { errorCode, findCondition, pollScan, pollUntil, scanWorkers } from '../helpers/e2e-runtime'
import { extendRuntime } from '../helpers/e2e-runtime-fixtures'
import { inPool } from '../helpers/e2e-runtime-nodes'
import { removeGeneratedTask, uploadGeneratedTask, writeGeneratedTask } from '../helpers/e2e-runtime-tasks'
import { cancelAndDeleteScan, SMALL_SETTINGS, startScan, waitForScanState } from '../helpers/scans'
import { packTask, uploadAndPublish } from '../helpers/tasks'
import { expect, test as base, unique } from '../fixtures'

// Privileged (Docker-in-Docker) tasks end to end (docs/nodes.md §6.9, §12.3; docs/security.md PRIV-*; docs/api.md
// §4.13, §5.1): publishing needs the owner's canRunPrivileged, every way of running a privileged revision checks it
// again, the test nodes (SCANTOR_NODE_DIND=disabled) leave privileged workers pending with dindUnavailable, and test
// runs never run privileged. The permission is granted and revoked only on a fresh user.

const test = extendRuntime(base)

test.describe.configure({ timeout: 180_000 })

const CAP_SYS_ADMIN = 1n << 21n

function setPrivileged(adminApi: ApiClient, userId: string, canRunPrivileged: boolean): Promise<User> {
  return adminApi.call<User>('updateUser', { path: { userId }, body: { canRunPrivileged } }).then((response) => ok(response, 'updateUser'))
}

test.describe('publishing', () => {
  test('a privileged manifest fails at static for a user without canRunPrivileged', { tag: ['@REV-010'] }, async ({ tasks }) => {
    // Publishes a revision (its static check fails before any build).
    test.setTimeout(300_000)
    const { revision } = await uploadGeneratedTask(tasks, 'privileged', { expectState: 'failed' })
    expect(revision.state).toBe('failed')
    expect(revision.errors).toEqual([
      expect.objectContaining({ phase: 'static', message: expect.stringContaining('privileged tasks require the canRunPrivileged permission') }),
    ])
  })
})

test.describe('running privileged revisions', () => {
  test(
    'without canRunPrivileged every way of running a privileged revision is refused; with it, test nodes leave the workers pending',
    { tag: ['@SCAN-012', '@SCAN-013'] },
    async ({ adminApi, freshUser, freshApi, fakeNodes }) => {
      // Builds the fresh user's privileged task.
      test.setTimeout(300_000)
      await setPrivileged(adminApi, freshUser.id, true)
      const dir = await writeGeneratedTask('privileged')
      const scanIds: string[] = []
      try {
        const { revision } = await uploadAndPublish(freshApi, dir, unique('privileged'))
        expect(revision).toMatchObject({ state: 'ready', privileged: true })

        // On the shared nodes (SCANTOR_NODE_DIND=disabled) the workers wait for a node with Docker-in-Docker.
        const waiting = await startScan(freshApi, { revision: revision.ref })
        scanIds.push(waiting.id)
        expect(waiting.settings.privileged).toBe(true)
        const pending = await pollScan(
          freshApi,
          waiting.id,
          (s) => (findCondition(s, 'workersPending')?.details as { count?: number } | undefined)?.count === 2,
          {
            what: 'workersPending',
            timeoutMs: 90_000,
          },
        )
        expect(findCondition(pending, 'workersPending')?.details).toEqual({ count: 2, reasons: { dindUnavailable: 2 } })
        expect((await scanWorkers(freshApi, waiting.id)).every((w) => w.state === 'pending' && w.stateReason?.code === 'dindUnavailable')).toBe(true)
        ok(await freshApi.call<Scan>('pauseScan', { path: { scanId: waiting.id } }), 'pauseScan')

        // A scan whose scheduling finished: a fake DinD node takes its scheduler, which reports an empty schedule.
        const node = await fakeNodes.start({ info: { dindMode: 'privileged' } })
        const finished = await startScan(freshApi, { revision: revision.ref, settings: inPool(node.pool) })
        scanIds.push(finished.id)
        const scheduler = await pollUntil(
          'the scheduler assigned to the DinD node',
          async () => (await node.assignments()).find((a) => a.scanId === finished.id && a.role === 'scheduler'),
          (assignment) => assignment !== undefined,
          { timeoutMs: 90_000 },
        )
        expect(scheduler!.dindMode).toBe('privileged')
        const epoch = (await scanWorkers(freshApi, finished.id)).find((w) => w.id === scheduler!.workerId)!.epoch
        ok(
          await node.runtimeCall('schedulerDone', scheduler!.env.SCANTOR_WORKER_TOKEN!, { body: { epoch, outcome: 'done', confirmed: 0, tailHash: null } }),
          'schedulerDone',
        )
        await waitForScanState(freshApi, finished.id, 'completed', 90_000)

        // Revoked: start, resume, restart and retry-failed are all refused.
        await setPrivileged(adminApi, freshUser.id, false)
        const attempts = {
          startScan: await freshApi.startScan({ revision: revision.ref, settings: SMALL_SETTINGS }),
          resumeScan: await freshApi.call('resumeScan', { path: { scanId: waiting.id } }),
          restartScan: await freshApi.call('restartScan', { path: { scanId: finished.id }, body: {} }),
          retryFailedAnalyses: await freshApi.call('retryFailedAnalyses', { path: { scanId: finished.id } }),
        }
        for (const [operation, response] of Object.entries(attempts)) {
          expect([response.status, errorCode(response)], `${operation}: ${JSON.stringify(response.body)}`).toEqual([403, 'privilegedNotAllowed'])
        }
      } finally {
        // The fresh user's purge removes whatever is still being deleted.
        await Promise.all(scanIds.map((scanId) => cancelAndDeleteScan(freshApi, scanId)))
        await removeGeneratedTask(dir)
      }
    },
  )
})

test.describe('test runs', () => {
  /** Uploads the privileged task's folder without publishing (test runs use the workspace) and runs one test run. */
  async function privilegedTestRun(api: ApiClient, track: (task: string) => void = () => undefined): Promise<TestRun> {
    const dir = await writeGeneratedTask('privileged')
    try {
      const name = unique('privileged')
      track(name)
      ok(await api.uploadTask(await packTask(dir, { name }), { publish: false }), 'uploadTask')
      const created = ok(await api.call<TestRun>('testTask', { path: { task: name }, body: { limit: 1 }, query: { wait: 120 } }), 'testTask')
      return await pollUntil(
        'the test run settled',
        () =>
          api
            .call<TestRun>('getTestRun', { path: { testRunId: created.id }, query: { wait: 60, analyses: true } })
            .then((response) => ok(response, 'getTestRun')),
        (current) => ['completed', 'failed', 'cancelled'].includes(current.state),
        { timeoutMs: 150_000, intervalMs: 0 },
      )
    } finally {
      await removeGeneratedTask(dir)
    }
  }

  test('a test run of a privileged task runs unprivileged', { tag: ['@TRUN-010'] }, async ({ adminApi, freshUser, freshApi, api, tasks }) => {
    // Builds a test-run image of the fresh user.
    test.setTimeout(300_000)
    // The owner holds canRunPrivileged, as the static checks of test runs require (docs/architecture.md §11.1
    // step 5: --allow-privileged iff the owner has it); the test-run container is never privileged anyway. The
    // fresh user's task is purged with the user.
    await setPrivileged(adminApi, freshUser.id, true)
    const run = await privilegedTestRun(freshApi)
    expect(run.state, JSON.stringify(run.errors)).toBe('completed')
    const [analysis] = run.analyses!
    expect(analysis!.status).toBe('succeeded')
    const result = analysis!.result as { cap_eff: string; dind: boolean }
    expect(result.dind).toBe(false)
    expect(BigInt(`0x${result.cap_eff}`) & CAP_SYS_ADMIN, `CapEff ${result.cap_eff}`).toBe(0n)

    // Without the permission the same static rule as for publishing applies.
    expect(ok(await api.getAccount(), 'getAccount')).toMatchObject({ canRunPrivileged: false })
    const refused = await privilegedTestRun(api, (task) => tasks.track(task))
    expect(refused.state).toBe('failed')
    expect(refused.errors).toEqual([
      expect.objectContaining({ phase: 'static', message: expect.stringContaining('privileged tasks require the canRunPrivileged permission') }),
    ])
  })
})
