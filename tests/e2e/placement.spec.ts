import type { Scan } from '#shared/types/scans'
import type { User } from '#shared/types/users'
import type { Worker } from '#shared/types/workers'
import { ACTIVE_WORKER_STATES } from '#shared/utils/enums'
import { ok, type ApiClient } from '../helpers/api-client'
import { findCondition, getScan, pollScan, pollUntil, scanEvents, scanWorkers, sleep } from '../helpers/e2e-runtime'
import { extendRuntime, type SharedTasks } from '../helpers/e2e-runtime-fixtures'
import { inPool, MIB } from '../helpers/e2e-runtime-nodes'
import { removeGeneratedTask, writeGeneratedTask } from '../helpers/e2e-runtime-tasks'
import { cancelAndDeleteScan, startScan } from '../helpers/scans'
import { uploadAndPublish } from '../helpers/tasks'
import { expect, test as base, unique } from '../fixtures'

// Placement end to end (docs/nodes.md §12; docs/data-model.md §4.5.4, §6.6): desired workers per scan state,
// pending reasons and the workersPending condition, capacity reservations, the per-user worker cap, the built-in
// node for schedulers and the placement events. The capacity and reason cases place scans on fake nodes in pools of
// their own (helpers/e2e-runtime-nodes.ts), so the shared nodes' capacity never matters; their workers are placed
// but never run. Workers assigned to a node without their image count as image pulls in flight, at most
// SCANTOR_PLACEMENT_MAX_CONCURRENT_PULLS = 4 per digest across the cluster, and a fake node never has an image: so the
// tests use a copy of the `probe` task per parallel Playwright worker (published once per run,
// helpers/e2e-runtime-fixtures.ts), the tests of one worker run one after another, and every fake node is deleted at
// teardown (its workers become lost).

const test = extendRuntime(base)

test.describe.configure({ timeout: 180_000 })

/** The probe copy of this parallel worker: no other test running at the same time places workers of its image. */
const probe = (shared: SharedTasks, parallelIndex = test.info().parallelIndex) => shared.generated('probe', `placement-${parallelIndex}`)

test.beforeAll(async ({ shared }, workerInfo) => {
  // Publishing builds images; the stack builds at most SCANTOR_BUILD_CONCURRENCY of them at a time for every user.
  test.setTimeout(300_000)
  await probe(shared, workerInfo.parallelIndex)
})

const ACTIVE: readonly string[] = ACTIVE_WORKER_STATES

/** Polls the scan's workers until `accept` holds. */
function workersUntil(api: ApiClient, scanId: string, what: string, accept: (workers: Worker[]) => boolean, timeoutMs = 90_000): Promise<Worker[]> {
  return pollUntil(what, () => scanWorkers(api, scanId), accept, { timeoutMs, intervalMs: 500 })
}

const count = (workers: Worker[], role: Worker['role'], states: readonly string[]) => workers.filter((w) => w.role === role && states.includes(w.state)).length
const pending = (workers: Worker[]) => workers.filter((w) => w.state === 'pending')

/** The workersPending condition once it reports `count` workers. */
function pendingCondition(api: ApiClient, scanId: string, expectedCount: number): Promise<Scan> {
  return pollScan(api, scanId, (s) => (findCondition(s, 'workersPending')?.details as { count?: number } | undefined)?.count === expectedCount, {
    what: `workersPending with ${expectedCount} workers`,
    timeoutMs: 90_000,
    intervalMs: 500,
  })
}

test.describe('desired workers', () => {
  test(
    'a running scan wants one scheduler while scheduling is unfinished plus settings.workers runners',
    { tag: ['@PLACE-001'] },
    async ({ api, shared, scans, fakeNodes }) => {
      const node = await fakeNodes.start()
      const { revision } = await probe(shared)
      const scan = await scans.start({ revision: revision.ref, scanConfig: { times: 3 }, settings: inPool(node.pool, { workers: 2 }) })
      // The workers never run on the fake node, so scheduling stays pending and the scheduler stays wanted.
      await workersUntil(
        api,
        scan.id,
        '1 scheduler and 2 runners assigned',
        (w) => count(w, 'scheduler', ['assigned']) === 1 && count(w, 'runner', ['assigned']) === 2,
      )
      expect((await getScan(api, scan.id)).scheduling.state).toBe('pending')

      // Missing runners are inserted as pending and placed.
      ok(await api.call<Scan>('scaleScan', { path: { scanId: scan.id }, body: { workers: 3 } }), 'scaleScan')
      await workersUntil(api, scan.id, '3 runners assigned', (w) => count(w, 'runner', ['assigned']) === 3)

      // Surplus runners are drained; the fake node reports no container, so they end stopped.
      ok(await api.call<Scan>('scaleScan', { path: { scanId: scan.id }, body: { workers: 1 } }), 'scaleScan')
      const scaledIn = await workersUntil(
        api,
        scan.id,
        '1 active runner, 2 stopped',
        (w) => count(w, 'runner', ACTIVE) === 1 && count(w, 'runner', ['stopped']) === 2,
      )
      expect(count(scaledIn, 'scheduler', ACTIVE)).toBe(1)

      // A paused scan wants no worker at all.
      ok(await api.call<Scan>('pauseScan', { path: { scanId: scan.id } }), 'pauseScan')
      await workersUntil(api, scan.id, 'no active worker while paused', (w) => w.every((worker) => !ACTIVE.includes(worker.state)))

      // Resumed: a new scheduler (next epoch) and one runner again.
      ok(await api.call<Scan>('resumeScan', { path: { scanId: scan.id } }), 'resumeScan')
      const resumed = await workersUntil(
        api,
        scan.id,
        'scheduler and runner wanted again',
        (w) => count(w, 'scheduler', ['assigned']) === 1 && count(w, 'runner', ['assigned']) === 1,
      )
      const schedulers = resumed.filter((w) => w.role === 'scheduler').map((w) => [w.epoch, w.state])
      expect(schedulers).toEqual(
        expect.arrayContaining([
          [1, 'stopped'],
          [2, 'assigned'],
        ]),
      )

      // A terminal scan wants none.
      ok(await api.cancelScan(scan.id), 'cancelScan')
      await workersUntil(api, scan.id, 'no active worker once cancelled', (w) => w.every((worker) => !ACTIVE.includes(worker.state)))
    },
  )
})

test.describe('pending reasons', () => {
  test(
    'unplaceable workers carry workersPending with the filter that removed the last node; it clears once placed',
    { tag: ['@PLACE-002'] },
    async ({ api, shared, scans, fakeNodes }) => {
      const { revision } = await probe(shared)
      const pool = unique('pool')
      // No node is in this pool: every worker fails the node selector.
      const scan = await scans.start({ revision: revision.ref, scanConfig: { times: 2 }, settings: inPool(pool) })
      const unplaced = await pendingCondition(api, scan.id, 2)
      expect(findCondition(unplaced, 'workersPending')).toMatchObject({ severity: 'warning', details: { count: 2, reasons: { selectorMismatch: 2 } } })
      expect((await scanWorkers(api, scan.id)).map((w) => [w.state, w.stateReason?.code])).toEqual([
        ['pending', 'selectorMismatch'],
        ['pending', 'selectorMismatch'],
      ])

      // A node joins the pool: both workers are placed and the condition clears.
      const node = await fakeNodes.start({ pool })
      await workersUntil(
        api,
        scan.id,
        'both workers assigned',
        (w) => w.length === 2 && w.every((worker) => worker.state === 'assigned' && worker.nodeId === node.id),
      )
      const placed = await pollScan(api, scan.id, (s) => findCondition(s, 'workersPending') === undefined, { what: 'workersPending cleared', intervalMs: 500 })
      expect(placed.workers).toMatchObject({ pending: 0, active: 2 })
      const cleared = await scanEvents(api, scan.id, 'scan.conditionCleared')
      expect(cleared.some((e) => (e.data as { type?: string } | undefined)?.type === 'workersPending')).toBe(true)
    },
  )

  test('nodes below SCANTOR_NODE_MIN_FREE_DISK leave workers pending with diskLow', { tag: ['@PLACE-002'] }, async ({ api, shared, scans, fakeNodes }) => {
    const node = await fakeNodes.start({ info: { diskFreeBytes: 512 * MIB } })
    const { revision } = await probe(shared)
    const scan = await scans.start({ revision: revision.ref, scanConfig: { times: 1 }, settings: inPool(node.pool) })
    const unplaced = await pendingCondition(api, scan.id, 2)
    expect(findCondition(unplaced, 'workersPending')?.details).toEqual({ count: 2, reasons: { diskLow: 2 } })
  })

  test(
    'at most SCANTOR_PLACEMENT_MAX_CONCURRENT_PULLS workers pull one image at a time; the others wait with pullLimit',
    { tag: ['@PLACE-002'] },
    async ({ api, shared, scans, fakeNodes }) => {
      const node = await fakeNodes.start()
      const { revision } = await probe(shared)
      // The scheduler and 6 runners need the image on a node that has none of it: 4 pulls may be in flight.
      const scan = await scans.start({ revision: revision.ref, scanConfig: { times: 1 }, settings: inPool(node.pool, { workers: 6 }) })
      const unplaced = await pendingCondition(api, scan.id, 3)
      expect(findCondition(unplaced, 'workersPending')?.details).toEqual({ count: 3, reasons: { pullLimit: 3 } })
      const workers = await scanWorkers(api, scan.id)
      expect(workers.filter((w) => w.state === 'assigned')).toHaveLength(4)
      expect(count(workers, 'scheduler', ['assigned'])).toBe(1)
    },
  )
})

test.describe('capacity', () => {
  test(
    'placement reserves one slot, processes × cpus and processes × memoryMiB + 256 MiB per worker',
    { tag: ['@PLACE-003', '@PLACE-002'] },
    async ({ api, shared, scans, fakeNodes }) => {
      const { revision } = await probe(shared)
      // Two runners with 2 processes of 0.5 CPU and 64 MiB each; the scheduler always has 1 process.
      const resources = { workers: 2, processes: 2, resources: { cpus: 0.5, memoryMiB: 64 } }
      const schedulerMemory = 64 + 256
      const runnerMemory = 2 * 64 + 256
      const cases = [
        // 2 worker slots: the scheduler and one runner.
        { what: 'worker slots', info: { maxWorkers: 2 }, pending: 1 },
        // 2 CPUs: 0.5 (scheduler) + 1.0 (runner) fit, a second runner (1.0) does not.
        { what: 'CPUs', info: { cpus: 2 }, pending: 1 },
        // exactly the memory of the scheduler and one runner, overhead included
        { what: 'memory', info: { memoryBytes: (schedulerMemory + runnerMemory) * MIB }, pending: 1 },
        // one byte less: only the scheduler fits
        { what: 'memory minus one byte', info: { memoryBytes: (schedulerMemory + runnerMemory) * MIB - 1 }, pending: 2 },
      ]
      // One case after the other: each scan's three workers count as pulls of the one image digest while they are
      // assigned, and a cancelled scan's workers are drained before the next case starts.
      for (const { what, info, pending: expectedPending } of cases) {
        const node = await fakeNodes.start({ info })
        const started = await scans.start({ revision: revision.ref, scanConfig: { times: 1 }, settings: inPool(node.pool, resources) })
        const scan = await pendingCondition(api, started.id, expectedPending)
        expect(findCondition(scan, 'workersPending')?.details, what).toEqual({ count: expectedPending, reasons: { insufficientCapacity: expectedPending } })
        const workers = await scanWorkers(api, scan.id)
        expect(count(workers, 'scheduler', ['assigned']), what).toBe(1)
        expect(count(workers, 'runner', ['assigned']), what).toBe(2 - expectedPending)
        expect(
          pending(workers).every((w) => w.stateReason?.code === 'insufficientCapacity'),
          what,
        ).toBe(true)
        ok(await api.cancelScan(scan.id), 'cancelScan')
        await workersUntil(api, scan.id, 'no worker assigned any more', (w) => w.every((worker) => worker.state !== 'assigned'))
      }
    },
  )
})

test.describe('user worker cap', () => {
  test(
    "a user's maxWorkers caps their active workers across scans; the cap is not checked at scan start",
    { tag: ['@PLACE-004'] },
    async ({ adminApi, freshUser, freshApi, fakeNodes }) => {
      // Builds the fresh user's task.
      test.setTimeout(300_000)
      ok(await adminApi.call<User>('updateUser', { path: { userId: freshUser.id }, body: { maxWorkers: 2 } }), 'updateUser')
      const node = await fakeNodes.start()
      const dir = await writeGeneratedTask('probe')
      const scanIds: string[] = []
      try {
        const { revision } = await uploadAndPublish(freshApi, dir, unique('probe'))
        // 1 scheduler + 3 runners wanted, 2 allowed: started anyway.
        const first = await startScan(freshApi, { revision: revision.ref, scanConfig: { times: 1 }, settings: inPool(node.pool, { workers: 3 }) })
        scanIds.push(first.id)
        const capped = await pendingCondition(freshApi, first.id, 2)
        expect(findCondition(capped, 'workersPending')?.details).toEqual({ count: 2, reasons: { userMaxWorkers: 2 } })
        const workers = await scanWorkers(freshApi, first.id)
        expect(count(workers, 'scheduler', ['assigned'])).toBe(1)
        expect(count(workers, 'runner', ['assigned'])).toBe(1)

        // A second scan of the same user gets no worker at all while the first holds the cap.
        const second = await startScan(freshApi, { revision: revision.ref, scanConfig: { times: 1 }, settings: inPool(node.pool, { workers: 1 }) })
        scanIds.push(second.id)
        const blocked = await pendingCondition(freshApi, second.id, 2)
        expect(findCondition(blocked, 'workersPending')?.details).toEqual({ count: 2, reasons: { userMaxWorkers: 2 } })
        expect(ok(await adminApi.getUser(freshUser.id), 'getUser').usage.activeWorkers).toBe(2)
      } finally {
        // The fresh user's purge removes whatever is still being deleted.
        await Promise.all(scanIds.map((scanId) => cancelAndDeleteScan(freshApi, scanId)))
        await removeGeneratedTask(dir)
      }
    },
  )
})

test.describe('node choice', () => {
  test('the scheduler goes to the built-in node when it is a candidate', { tag: ['@PLACE-006'] }, async ({ api, adminApi, shared, scans }) => {
    const builtin = ok(await adminApi.listNodes(), 'listNodes').items.find((node) => node.builtIn)!
    const { revision } = await probe(shared)
    const scan = await scans.start({ revision: revision.ref, scanConfig: { times: 1 } })
    await scans.wait(scan.id, { timeoutMs: 120_000 })
    const scheduler = (await scanWorkers(api, scan.id)).find((w) => w.role === 'scheduler')!
    expect(scheduler.nodeId).toBe(builtin.id)
    expect(scheduler.node).toEqual({ id: builtin.id, name: builtin.name })
  })

  test('a placed worker never moves to another node', { tag: ['@PLACE-006'] }, async ({ api, shared, scans, fakeNodes }) => {
    const { revision } = await probe(shared)
    // A small node takes the scheduler and the first runner.
    const small = await fakeNodes.start({ info: { maxWorkers: 2 } })
    const scan = await scans.start({ revision: revision.ref, scanConfig: { times: 1 }, settings: inPool(small.pool, { workers: 1 }) })
    const first = await workersUntil(api, scan.id, 'both workers on the small node', (w) => w.length === 2 && w.every((worker) => worker.state === 'assigned'))
    const placedOn = new Map(first.map((w) => [w.id, w.nodeId]))
    expect([...placedOn.values()].every((nodeId) => nodeId === small.id)).toBe(true)

    // A roomier node joins the pool; new runners go there, the placed workers stay where they are.
    const big = await fakeNodes.start({ pool: small.pool })
    ok(await api.call<Scan>('scaleScan', { path: { scanId: scan.id }, body: { workers: 3 } }), 'scaleScan')
    const later = await workersUntil(api, scan.id, 'two more runners assigned', (w) => count(w, 'runner', ['assigned']) === 3)
    for (const worker of later) {
      if (placedOn.has(worker.id)) expect(worker.nodeId, worker.id).toBe(placedOn.get(worker.id))
      else expect(worker.nodeId, worker.id).toBe(big.id)
    }
  })
})

test.describe('placement events', () => {
  test(
    'worker.placed per placement, worker.pending only when the pending reason changes',
    { tag: ['@PLACE-007'] },
    async ({ api, shared, scans, fakeNodes }) => {
      const { revision } = await probe(shared)
      const pool = unique('pool')
      const scan = await scans.start({ revision: revision.ref, scanConfig: { times: 1 }, settings: inPool(pool) })
      await pendingCondition(api, scan.id, 2)
      const pendingEvents = () => scanEvents(api, scan.id, 'worker.pending')
      const first = await pollUntil('a worker.pending event per worker', pendingEvents, (events) => events.length === 2, { timeoutMs: 30_000, intervalMs: 500 })
      expect(first.map((e) => (e.data as { reason?: string }).reason)).toEqual(['selectorMismatch', 'selectorMismatch'])
      expect(new Set(first.map((e) => e.workerId)).size).toBe(2)

      // Later placement passes (every reconciler tick of 10 s and on changes) keep the same reason: no new event
      // during a window that spans at least one periodic pass.
      const quietUntil = Date.now() + 12_000
      while (Date.now() < quietUntil) {
        expect((await pendingEvents()).length).toBe(2)
        await sleep(2000)
      }

      // A node with one slot: the scheduler is placed, the runner's reason changes to insufficientCapacity.
      const node = await fakeNodes.start({ pool, info: { maxWorkers: 1 } })
      const workers = await workersUntil(
        api,
        scan.id,
        'scheduler placed, runner pending',
        (w) => count(w, 'scheduler', ['assigned']) === 1 && pending(w).length === 1,
      )
      const runner = pending(workers)[0]!
      await pollUntil(
        'the runner pending with insufficientCapacity',
        async () => (await scanWorkers(api, scan.id)).find((w) => w.id === runner.id)!,
        (w) => w.stateReason?.code === 'insufficientCapacity',
      )
      const events = await pollUntil('a third worker.pending event', pendingEvents, (e) => e.length === 3, { timeoutMs: 30_000, intervalMs: 500 })
      expect(events[2]).toMatchObject({ workerId: runner.id, data: { reason: 'insufficientCapacity' } })
      const placed = await scanEvents(api, scan.id, 'worker.placed')
      expect(placed).toHaveLength(1)
      expect(placed[0]).toMatchObject({ workerId: workers.find((w) => w.role === 'scheduler')!.id, data: { nodeId: node.id } })
    },
  )
})
