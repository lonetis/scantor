import { randomBytes, randomUUID } from 'node:crypto'
import type { Page } from '#shared/types/common'
import type { Event } from '#shared/types/events'
import type { Node } from '#shared/types/nodes'
import type { Worker } from '#shared/types/workers'
import { ok, type ApiClient } from '../helpers/api-client'
import { withPlatformScans, withPlatformTasks } from '../helpers/api-platform-cleanup'
import {
  FakeRuntime,
  NodeTracker,
  registryTokenGet,
  serverVersion,
  settingsOn,
  taskRepository,
  withEchoTask,
  type AssignmentsResponse,
} from '../helpers/api-platform-nodes'
import { stackEnv } from '../helpers/docker'
import { stackKeys } from '../helpers/keys'
import { withLazyTenant, withPlatformAdmin, withWorkerTenant } from '../helpers/api-platform-tenant'
import type { UploadedTask } from '../helpers/tasks'
import { expect, test as base, unique } from '../fixtures'

// The node API (docs/api.md §7, docs/nodes.md §5–§7) from the daemon's side: a fake daemon with the token of a node
// created for the test says hello, long-polls its assignments and reports status, so placement, leases and the
// admin view of a node can be checked without containers. Each fake node has a unique pool; scans reach it only
// through `settings.nodeSelector`. The built-in node is only observed, never driven.

const test = base.extend<{ nodes: NodeTracker }, { echo: UploadedTask }>({
  // An admin of the worker and a tenant with a uniquely named session (helpers/api-platform-tenant.ts).
  adminApi: [async ({ openapi }, use) => withPlatformAdmin(openapi, use), { scope: 'worker', timeout: 150_000 }],
  user: [
    async ({ adminApi, openapi }, use, workerInfo) => withWorkerTenant(adminApi, openapi, `w${workerInfo.workerIndex}`, use),
    { scope: 'worker', timeout: 150_000 },
  ],
  // tasks and scans that never wait for the stack's deletion jobs (helpers/api-platform-cleanup.ts).
  tasks: async ({ api }, use) => withPlatformTasks(api, use),
  scans: async ({ api, tasks: _tasks }, use) => withPlatformScans(api, use),
  freshUserHandle: async ({ adminApi, openapi }, use) => withLazyTenant(adminApi, openapi, 'fresh', use),
  nodes: async ({ adminApi, openapi }, use) => {
    const tracker = new NodeTracker(adminApi, openapi)
    await use(tracker)
    await tracker.dispose()
  },
  echo: [async ({ user, openapi }, use) => withEchoTask(user.storageState, openapi, use), { scope: 'worker', timeout: 180_000 }],
})

// Placement on a fake node takes up to a minute while the shared stack is busy.
test.describe.configure({ timeout: 180_000 })

const MIB = 1024 * 1024

/** `10s`, `25s`, `2m` → milliseconds (the stack's .env values). */
function durationMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value.trim())
  if (!match) throw new Error(`not a duration: ${value}`)
  return Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] as 'ms' | 's' | 'm' | 'h']
}

/** `1GiB`, `512MiB` → bytes. */
function byteSize(value: string): number {
  const match = /^(\d+)(B|KiB|MiB|GiB)?$/.exec(value.trim())
  if (!match) throw new Error(`not a byte size: ${value}`)
  return Number(match[1]) * { B: 1, KiB: 1024, MiB: MIB, GiB: 1024 * MIB }[(match[2] ?? 'B') as 'B' | 'KiB' | 'MiB' | 'GiB']
}

async function nodeEvents(adminApi: ApiClient, nodeId: string, query: Record<string, string | number> = {}): Promise<Page<Event>> {
  return ok(await adminApi.call<Page<Event>>('listNodeEvents', { path: { nodeId }, query }), 'listNodeEvents')
}

async function scanWorkers(api: ApiClient, scanId: string): Promise<Worker[]> {
  return ok(await api.listScanWorkers(scanId), 'listScanWorkers').items
}

test.describe('hello', () => {
  test('sets the node online, stores its info and returns its identity and configuration', { tag: ['@NODE-015'] }, async ({ adminApi, env, nodes }) => {
    const fake = await nodes.fake({ labels: { zone: 'test' } })
    expect(fake.created.node.state).toBe('pending')

    const before = Date.now()
    const hello = await fake.daemon.hello(fake.info)
    expect(hello.status).toBe(200)
    const stack = stackEnv()
    expect(hello.body.serverTime).toBeGreaterThanOrEqual(before - 5_000)
    expect(hello.body.serverTime).toBeLessThanOrEqual(Date.now() + 5_000)
    expect(hello.body.node).toEqual({ id: fake.id, name: fake.name, builtIn: false, endpointProfile: 'public', pool: fake.pool, labels: { zone: 'test' } })
    expect(hello.body.config).toEqual({
      statusIntervalMs: durationMs(stack.SCANTOR_NODE_STATUS_INTERVAL!),
      assignmentsWaitSeconds: durationMs(stack.SCANTOR_NODE_ASSIGNMENTS_WAIT!) / 1000,
      offlineAfterMs: durationMs(stack.SCANTOR_NODE_OFFLINE_AFTER!),
      drainGraceMs: durationMs(stack.SCANTOR_WORKER_DRAIN_GRACE!),
      registry: { host: stack.SCANTOR_REGISTRY_PUBLIC_HOST, username: 'node' },
      minFreeDiskBytes: byteSize(stack.SCANTOR_NODE_MIN_FREE_DISK!),
    })
    expect(hello.body.config.registry.host).not.toContain(env.publicUrl)

    const node = ok(await adminApi.call<Node>('getNode', { path: { nodeId: fake.id } }), 'getNode')
    expect(node.state).toBe('online')
    expect(node.info).toMatchObject({ ...fake.info, version: fake.daemon.version })
    expect(node.instance).toMatchObject({ version: fake.daemon.version })
    expect(Date.parse(node.lastSeenAt!)).toBeGreaterThanOrEqual(before - 5_000)

    const online = await nodeEvents(adminApi, fake.id, { type: 'node.online' })
    expect(online.items).toHaveLength(1)
    expect(online.items[0]).toMatchObject({ type: 'node.online', nodeId: fake.id })
  })

  test('refuses an unknown or revoked node token with 401', { tag: ['@NODE-016'] }, async ({ adminApi, nodes }) => {
    const fake = await nodes.fake()
    const unknown = fake.otherDaemon()
    unknown.token = `snt_${randomBytes(32).toString('base64url')}`
    const refused = await unknown.hello(fake.info)
    expect(refused.status).toBe(401)
    expect(refused.body).toMatchObject({ error: { code: 'unauthorized' } })

    // A credential of another kind is ignored on the node prefix.
    const other = fake.otherDaemon()
    other.token = `sk_scantor_${randomBytes(24).toString('base64url')}`
    expect((await other.hello(fake.info)).status).toBe(401)

    expect((await fake.daemon.hello(fake.info)).status).toBe(200)
    expect((await adminApi.call('revokeNodeToken', { path: { nodeId: fake.id } })).status).toBe(200)
    const revoked = await fake.daemon.hello(fake.info)
    expect(revoked.status).toBe(401)
    expect(revoked.body).toMatchObject({ error: { code: 'unauthorized' } })
  })

  test('refuses a daemon version outside the same or previous minor with 426', { tag: ['@NODE-016'] }, async ({ adminApi, nodes }) => {
    const version = await serverVersion(adminApi)
    const release = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
    // docs/api.md §1.10: only a release orchestrator has a version window; dev builds (the test stack) accept any.
    test.skip(!release, `the orchestrator runs the non-release version ${version}, which has no version window`)
    const [, major, minor] = release!
    const fake = await nodes.fake()
    const tooOld = `${major}.${Math.max(0, Number(minor) - 2)}.0`
    const old = await fake.daemon.call('nodeHello', {
      headers: { 'X-Scantor-Version': tooOld, 'User-Agent': `scantor-node/${tooOld}` },
      body: { instanceId: fake.daemon.instanceId, version: tooOld, info: fake.info, containers: [] },
    })
    expect(old.status).toBe(426)
    expect(old.body).toMatchObject({ error: { code: 'incompatibleVersion', details: { minVersion: `${major}.${Math.max(0, Number(minor) - 1)}.0` } } })
  })
})

test.describe('instance lease', () => {
  test('a daemon on another engine gets 409, a restart on the same engine takes over', { tag: ['@NODE-017'] }, async ({ adminApi, nodes }) => {
    const fake = await nodes.fake()
    await fake.online()
    await fake.stopHeartbeat()
    const first = fake.daemon

    const intruder = fake.otherDaemon()
    const conflict = await intruder.hello(fake.info)
    expect(conflict.status).toBe(409)
    expect(conflict.body).toMatchObject({ error: { code: 'nodeInstanceConflict' } })
    const retryAfterMs = (conflict.body as unknown as { error: { details: { retryAfterMs: number } } }).error.details.retryAfterMs
    expect(retryAfterMs).toBeGreaterThan(0)
    expect(retryAfterMs).toBeLessThanOrEqual(durationMs(stackEnv().SCANTOR_NODE_OFFLINE_AFTER!))

    const intruderStatus = await intruder.status(fake.info, [])
    expect(intruderStatus.status).toBe(409)
    expect(intruderStatus.body).toMatchObject({ error: { code: 'nodeInstanceConflict', details: { retryAfterMs: expect.any(Number) } } })
    expect((await intruder.assignments()).status).toBe(409)
    expect((await first.status(fake.info, [])).status).toBe(200)

    const conflicts = await nodeEvents(adminApi, fake.id, { type: 'node.instanceConflict' })
    expect(conflicts.items.length).toBeGreaterThanOrEqual(1)
    expect(conflicts.items[0]).toMatchObject({ type: 'node.instanceConflict', nodeId: fake.id })

    // The daemon restarts on the same engine (new boot nonce): it takes the lease over at once.
    const restarted = fake.otherDaemon(first.engineId)
    expect(restarted.instanceId).not.toBe(first.instanceId)
    const takeover = await restarted.hello(fake.info)
    expect(takeover.status).toBe(200)
    expect((await restarted.status(fake.info, [])).status).toBe(200)
    const stale = await first.status(fake.info, [])
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({ error: { code: 'nodeInstanceConflict' } })
  })
})

test.describe('assignments', () => {
  test(
    'long-poll returns at once for a newer revision, after the wait otherwise, and early on a placement',
    { tag: ['@NODE-018'] },
    async ({ api, echo, nodes, scans }) => {
      const fake = await nodes.fake()
      await fake.online()

      // A revision older than the node's returns at once, whatever the wait.
      let started = Date.now()
      const initial = await fake.daemon.assignments({ rev: -1, wait: 30 })
      expect(initial.status).toBe(200)
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(initial.body).toMatchObject({ workers: [], logRequests: [] })
      const rev = initial.body.rev

      started = Date.now()
      const idle = ok(await fake.daemon.assignments({ rev, wait: 3 }), 'getNodeAssignments')
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_500)
      expect(idle).toMatchObject({ rev, workers: [], logRequests: [] })

      const tooLong = await fake.daemon.assignments({ rev, wait: 61 })
      expect(tooLong.status).toBe(400)
      expect(tooLong.body).toMatchObject({ error: { code: 'validationFailed' } })

      // A pending long-poll wakes when placement assigns the workers of a new scan to the node: the poll that sees the
      // new revision returns before its wait is over. Placement normally takes seconds; should a busy stack need more
      // than one wait, the poll that timed out is repeated once.
      const WAIT_SECONDS = 60
      const scanStarted = scans.start({ revision: echo.revision.id, settings: settingsOn(fake) })
      // A failed start surfaces at the `await` below, not as an unhandled rejection while a poll is pending.
      scanStarted.catch(() => undefined)
      let woken: AssignmentsResponse | null = null
      for (let poll = 0; poll < 2 && woken === null; poll++) {
        started = Date.now()
        const answer = ok(await fake.daemon.assignments({ rev, wait: WAIT_SECONDS }), 'getNodeAssignments')
        const elapsed = Date.now() - started
        if (answer.rev > rev) {
          expect(elapsed, 'the placement ended the pending long-poll early').toBeLessThan(WAIT_SECONDS * 1000 - 1000)
          woken = answer
        } else {
          expect(elapsed, 'a long-poll without a change waits').toBeGreaterThanOrEqual((WAIT_SECONDS - 1) * 1000)
        }
      }
      const scan = await scanStarted
      expect(woken, 'placement changed the assignments within two long-polls').not.toBeNull()

      // Every response is the complete desired set: the scheduler and the runner of the scan.
      const { response } = await fake.waitForScanWorkers(scan.id)
      expect(response.workers.map((worker) => worker.role).sort()).toEqual(['runner', 'scheduler'])
      const placed = await scanWorkers(api, scan.id)
      expect(response.workers.map((worker) => worker.workerId).sort()).toEqual(placed.map((worker) => worker.id).sort())
      started = Date.now()
      const again = ok(await fake.daemon.assignments({ rev: response.rev - 1, wait: 30 }), 'getNodeAssignments')
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(again.rev).toBe(response.rev)
      expect(again.workers.map((worker) => worker.workerId).sort()).toEqual(response.workers.map((worker) => worker.workerId).sort())
    },
  )

  test(
    'an assignment pulls the task image by digest from the public registry host, sized by processes',
    { tag: ['@NODE-019'] },
    async ({ env, echo, nodes, scans }) => {
      const fake = await nodes.fake()
      await fake.online()
      const resources = { cpus: 0.25, memoryMiB: 256 }
      const scan = await scans.start({ revision: echo.revision.id, settings: settingsOn(fake, { workers: 1, processes: 2, resources }) })
      const { scheduler, runners } = await fake.waitForScanWorkers(scan.id)
      const runner = runners[0]!

      const image = `${stackEnv().SCANTOR_REGISTRY_PUBLIC_HOST}/${taskRepository(echo.task.id)}@${echo.revision.image!.digest}`
      expect(echo.revision.image!.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
      for (const [assignment, processes] of [
        [runner, 2],
        [scheduler, 1],
      ] as const) {
        expect(assignment.image).toBe(image)
        expect(assignment.processes).toBe(processes)
        expect(assignment.resources).toEqual({ nanoCpus: processes * resources.cpus * 1e9, memoryBytes: processes * resources.memoryMiB * MIB + 256 * MIB })
        expect(Object.keys(assignment.env).sort()).toEqual(['SCANTOR_URL', 'SCANTOR_WORKER_TOKEN'])
        expect(assignment.env.SCANTOR_URL).toBe(env.publicUrl)
        expect(assignment.env.SCANTOR_WORKER_TOKEN).toBe(
          stackKeys().workerToken({ workerId: assignment.workerId, scanId: scan.id, role: assignment.role, nodeId: fake.id }),
        )
        expect(assignment).toMatchObject({ scanId: scan.id, privileged: false, dindMode: null })
      }
    },
  )

  test('the built-in node pulls by digest from localhost with the same limits', { tag: ['@NODE-019'] }, async ({ api, docker, scans, tasks }) => {
    const sleep = await tasks.example('sleep')
    const resources = { cpus: 0.25, memoryMiB: 256 }
    const scan = await scans.start({
      revision: sleep.revision.id,
      taskConfig: { seconds: 600 },
      scanConfig: { times: 1 },
      settings: { workers: 1, processes: 2, resources },
    })
    let runner: Worker | undefined
    await expect
      .poll(
        async () => {
          runner = (await scanWorkers(api, scan.id)).find((worker) => worker.role === 'runner' && worker.state === 'running')
          return runner?.state
        },
        { timeout: 120_000, intervals: [1000, 2000, 5000] },
      )
      .toBe('running')
    const container = await docker.inspect<{ Config: { Image: string; Env: string[] }; HostConfig: { Memory: number; NanoCpus: number } }>(
      `scantor-w-${runner!.id}`,
    )
    expect(container.Config.Image).toBe(`localhost:${stackEnv().SCANTOR_REGISTRY_PORT}/${taskRepository(sleep.task.id)}@${sleep.revision.image!.digest}`)
    expect(container.HostConfig.Memory).toBe(2 * resources.memoryMiB * MIB + 256 * MIB)
    expect(container.HostConfig.NanoCpus).toBe(2 * resources.cpus * 1e9)
    expect(container.Config.Env).toContain(`SCANTOR_URL=${stackEnv().SCANTOR_INTERNAL_URL}`)
  })

  test('status entries and log answers for workers of another node are ignored', { tag: ['@NODE-020'] }, async ({ api, echo, nodes, scans }) => {
    const owner = await nodes.fake()
    const stranger = await nodes.fake()
    await owner.online()
    await stranger.online()
    const scan = await scans.start({ revision: echo.revision.id, settings: settingsOn(owner) })
    const { runners } = await owner.waitForScanWorkers(scan.id)
    const runner = runners[0]!

    // The stranger claims to run the owner's worker: ignored.
    const claim = await stranger.daemon.status(stranger.info, [
      { workerId: runner.workerId, state: 'running', containerId: randomBytes(32).toString('hex'), startedAt: new Date().toISOString(), restarts: 0 },
    ])
    expect(claim.status).toBe(200)
    const unchanged = (await scanWorkers(api, scan.id)).find((worker) => worker.id === runner.workerId)!
    expect(unchanged).toMatchObject({ state: 'assigned', nodeId: owner.id, container: null })

    // A log request of the scan's owner reaches the owner node only.
    const requested = ok(
      await api.call<{ pending: boolean }>('getWorkerLogs', { path: { scanId: scan.id, workerId: runner.workerId }, query: { tailBytes: 4096 } }),
      'getWorkerLogs',
    )
    expect(requested.pending).toBe(true)
    const withRequest = await owner.waitForAssignments((current) => current.logRequests.some((request) => request.workerId === runner.workerId))
    const logRequest = withRequest.logRequests.find((request) => request.workerId === runner.workerId)!
    expect(logRequest.tailBytes).toBe(4096)
    expect(ok(await stranger.daemon.assignments(), 'getNodeAssignments').logRequests).toEqual([])

    const answer = { text: 'stranger output\n', bytes: 16, truncated: false, collectedAt: new Date().toISOString() }
    const foreign = await stranger.daemon.logs(runner.workerId, { requestId: logRequest.requestId, ...answer })
    expect(foreign.status).toBe(404)
    expect(foreign.body).toMatchObject({ error: { code: 'notFound' } })
    const unknownRequest = await owner.daemon.logs(runner.workerId, { requestId: randomUUID(), ...answer })
    expect(unknownRequest.status).toBe(404)
    const unknownWorker = await owner.daemon.logs(randomUUID(), { requestId: logRequest.requestId, ...answer })
    expect(unknownWorker.status).toBe(404)
    // Nothing was stored: the request is still open (listScanWorkers reads it without opening a new one).
    const open = (await scanWorkers(api, scan.id)).find((worker) => worker.id === runner.workerId)!
    expect(open.logs).toMatchObject({ requestId: logRequest.requestId, text: null, collectedAt: null })

    // The owner's answer to its open request is stored.
    const own = await owner.daemon.logs(runner.workerId, {
      requestId: logRequest.requestId,
      text: 'own output\n',
      bytes: 11,
      truncated: false,
      collectedAt: new Date().toISOString(),
    })
    expect(own.status).toBe(204)
    const stored = (await scanWorkers(api, scan.id)).find((worker) => worker.id === runner.workerId)!
    expect(stored.logs).toMatchObject({ requestId: logRequest.requestId, text: 'own output\n', collectedAt: expect.any(String) })
  })
})

test.describe('removing a node', () => {
  test(
    'deleting a node loses its workers, replaces them elsewhere and locks out its daemon',
    { tag: ['@NODE-007'] },
    async ({ adminApi, api, echo, nodes, scans }) => {
      const pool = unique('pool-delete')
      const first = await nodes.fake({ pool })
      const second = await nodes.fake({ pool })
      await first.online()
      await second.online()
      const scan = await scans.start({ revision: echo.revision.id, settings: settingsOn(first) })

      let placed: Worker[] = []
      await expect
        .poll(
          async () => {
            placed = await scanWorkers(api, scan.id)
            return placed.filter((worker) => worker.role === 'runner' && worker.nodeId !== null).length
          },
          { timeout: 60_000 },
        )
        .toBe(1)
      const runner = placed.find((worker) => worker.role === 'runner')!
      const doomed = runner.nodeId === first.id ? first : second
      const survivor = doomed === first ? second : first

      const deleted = await adminApi.deleteNode(doomed.id)
      expect(deleted.status).toBe(204)
      expect((await adminApi.call('getNode', { path: { nodeId: doomed.id } })).status).toBe(404)
      await doomed.stopHeartbeat()
      for (const response of [await doomed.daemon.status(doomed.info, []), await doomed.daemon.hello(doomed.info)]) {
        expect(response.status).toBe(401)
      }

      const lost = (await scanWorkers(api, scan.id)).find((worker) => worker.id === runner.id)!
      expect(lost.state).toBe('lost')
      expect(lost.stateReason).toMatchObject({ code: 'nodeDeleted' })
      const replacement = await survivor.waitForAssignments((current) =>
        current.workers.some((worker) => worker.scanId === scan.id && worker.role === 'runner'),
      )
      const replaced = replacement.workers.find((worker) => worker.scanId === scan.id && worker.role === 'runner')!
      expect(replaced.workerId).not.toBe(runner.id)
    },
  )

  test('revoking a token loses the workers at once and denies registry pulls', { tag: ['@NODE-009'] }, async ({ adminApi, api, echo, nodes, scans }) => {
    const fake = await nodes.fake()
    await fake.online()
    const scan = await scans.start({ revision: echo.revision.id, settings: settingsOn(fake) })
    const { runners } = await fake.waitForScanWorkers(scan.id)
    const runtime = FakeRuntime.of(fake.daemon.api, runners[0]!, fake.daemon.version)
    expect((await runtime.bootstrap()).status).toBe(200)
    const credential = { username: 'node', password: fake.daemon.token }
    const repository = taskRepository(echo.task.id)
    const granted = await registryTokenGet(fake.daemon.api.request, credential, { scopes: [`repository:${repository}:pull`] })
    expect(granted.status).toBe(200)

    const revoked = await adminApi.call<Node>('revokeNodeToken', { path: { nodeId: fake.id } })
    expect(revoked.status).toBe(200)
    expect(revoked.body.state).toBe('revoked')

    const workers = await scanWorkers(api, scan.id)
    for (const worker of workers.filter((candidate) => candidate.nodeId === fake.id)) {
      expect(worker.state, worker.role).toBe('lost')
      expect(worker.stateReason).toMatchObject({ code: 'nodeRevoked' })
    }
    const afterRevoke = await runtime.call('runtimeState', {
      body: { processes: { running: 1, busy: 0 }, busy: [], consuming: true, clockOffsetMs: 0, tmpFreeBytes: 10 * 1024 * MIB },
    })
    expect(afterRevoke.status).toBe(401)
    const denied = await registryTokenGet(fake.daemon.api.request, credential, { scopes: [`repository:${repository}:pull`] })
    expect(denied.status).toBe(401)
    expect(denied.body).toEqual({ errors: [expect.objectContaining({ code: 'UNAUTHORIZED' })] })

    const events = await nodeEvents(adminApi, fake.id, { type: 'node.revoked' })
    expect(events.items).toHaveLength(1)
    expect(events.items[0]).toMatchObject({ type: 'node.revoked', nodeId: fake.id })

    const again = await adminApi.call<Node>('revokeNodeToken', { path: { nodeId: fake.id } })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ state: 'revoked', updatedAt: revoked.body.updatedAt })
    expect((await nodeEvents(adminApi, fake.id, { type: 'node.revoked' })).items).toHaveLength(1)
  })
})

test.describe('node detail', () => {
  test(
    'lists the workers on a node with their scan, and its events newest first by type or prefix',
    { tag: ['@NODE-011'] },
    async ({ adminApi, api, echo, nodes, scans }) => {
      const fake = await nodes.fake()
      await fake.online()
      const scan = await scans.start({ name: unique('node-detail'), revision: echo.revision.id, settings: settingsOn(fake) })
      const { scheduler, runners } = await fake.waitForScanWorkers(scan.id)
      expect((await FakeRuntime.of(fake.daemon.api, runners[0]!, fake.daemon.version).bootstrap()).status).toBe(200)

      const listWorkers = (query: Record<string, string | number> = {}) =>
        adminApi.call<Page<Worker>>('listNodeWorkers', { path: { nodeId: fake.id }, query }).then((response) => ok(response, 'listNodeWorkers'))
      const all = await listWorkers()
      expect(all.items.map((worker) => worker.id).sort()).toEqual([scheduler.workerId, runners[0]!.workerId].sort())
      for (const worker of all.items) {
        expect(worker.scan).toEqual({ id: scan.id, name: scan.name })
        expect(worker.node).toEqual({ id: fake.id, name: fake.name })
      }
      expect((await listWorkers({ state: 'running' })).items.map((worker) => worker.id)).toEqual([runners[0]!.workerId])
      expect((await listWorkers({ state: 'assigned' })).items.map((worker) => worker.id)).toEqual([scheduler.workerId])
      expect((await listWorkers({ state: 'assigned,running' })).items).toHaveLength(2)

      const firstPage = await listWorkers({ limit: 1 })
      expect(firstPage.items).toHaveLength(1)
      expect(firstPage.nextCursor).not.toBeNull()
      const secondPage = await listWorkers({ limit: 1, cursor: firstPage.nextCursor! })
      expect(secondPage.items).toHaveLength(1)
      expect(secondPage.items[0]!.id).not.toBe(firstPage.items[0]!.id)
      expect(secondPage.nextCursor).toBeNull()

      const events = await nodeEvents(adminApi, fake.id)
      const times = events.items.map((event) => Date.parse(event.at))
      expect(times).toEqual([...times].sort((a, b) => b - a))
      expect(events.items.map((event) => event.type)).toEqual(expect.arrayContaining(['node.online', 'worker.started']))
      expect((await nodeEvents(adminApi, fake.id, { type: 'node.online' })).items.every((event) => event.type === 'node.online')).toBe(true)
      const nodePrefix = await nodeEvents(adminApi, fake.id, { type: 'node.' })
      expect(nodePrefix.items.length).toBeGreaterThan(0)
      expect(nodePrefix.items.every((event) => event.type.startsWith('node.'))).toBe(true)
      const workerPrefix = await nodeEvents(adminApi, fake.id, { type: 'worker.' })
      expect(workerPrefix.items.map((event) => event.type)).toContain('worker.started')
      expect(workerPrefix.items.every((event) => event.type.startsWith('worker.'))).toBe(true)
      expect((await nodeEvents(adminApi, fake.id, { type: 'worker' })).items).toEqual([])

      const missing = await adminApi.call('listNodeWorkers', { path: { nodeId: randomUUID() } })
      expect(missing.status).toBe(404)
      const denied = await api.call('listNodeEvents', { path: { nodeId: fake.id } })
      expect(denied.status).toBe(403)
    },
  )
})
