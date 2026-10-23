import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Page } from '#shared/types/common'
import type { Event } from '#shared/types/events'
import type { Scan } from '#shared/types/scans'
import type { Worker } from '#shared/types/workers'
import { ok, type ApiClient } from '../helpers/api-client'
import { withPlatformScans, withPlatformTasks } from '../helpers/api-platform-cleanup'
import { connectAsScan, EXCHANGES, publish } from '../helpers/amqp'
import { FakeRuntime, NodeTracker, runtimeError, settingsOn, withEchoTask, type FakeNode } from '../helpers/api-platform-nodes'
import { stackEnv } from '../helpers/docker'
import { stackKeys } from '../helpers/keys'
import { withLazyTenant, withPlatformAdmin, withWorkerTenant } from '../helpers/api-platform-tenant'
import type { UploadedTask } from '../helpers/tasks'
import { expect, test as base, unique } from '../fixtures'

// The runtime API (docs/api.md §8, docs/runtime.md §4) from the worker's side. A fake node serves the scan's workers,
// so their worker tokens come from the node's assignments and every call can be made without a container: bootstrap
// per role, presigned uploads, redelivery status, error reports, the scheduler routes with their epoch fencing, and
// the principal rules of the worker scope (docs/auth.md §10.2).

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
const STATE_REPORT = { processes: { running: 1, busy: 0 }, busy: [], consuming: true, clockOffsetMs: 0, tmpFreeBytes: 10 * 1024 * MIB }
const hash = (char: string) => `sha256:${char.repeat(64)}`

interface Bootstrap {
  action: string
  worker: { id: string; role: string; scanId: string; nodeId: string; epoch: number }
  scan: {
    id: string
    state: string
    round: number
    taskConfig: Record<string, unknown>
    scanConfig?: Record<string, unknown>
    settings: Record<string, unknown>
  }
  revision: { id: string; number: number; entry: string; protocolVersion: number; schedule: Record<string, unknown> }
  amqp: Record<string, unknown>
  uploads: Record<string, unknown>
  limits: Record<string, unknown>
  intervals: Record<string, unknown>
  scheduler: null | {
    restarts: number
    checkpoint: { confirmed: number; tailHash: string | null }
    resolved: Record<string, unknown>
    uploads: Record<string, unknown>
    dataSources: Record<string, string>
  }
}

/** A running scan on a fresh fake node, with runtime clients for its scheduler and runner. */
async function scanOnFakeNode(
  nodes: NodeTracker,
  scans: { start(body: { revision: string; name?: string; taskConfig?: Record<string, unknown>; settings?: Record<string, unknown> }): Promise<Scan> },
  revisionId: string,
  options: { node?: FakeNode; taskConfig?: Record<string, unknown> } = {},
) {
  const node = options.node ?? (await nodes.fake())
  if (!options.node) await node.online()
  const scan = await scans.start({ revision: revisionId, taskConfig: options.taskConfig, settings: settingsOn(node) })
  const placed = await node.waitForScanWorkers(scan.id)
  const runner = placed.runners[0]!
  node.reportRunning(placed.scheduler, runner)
  return {
    node,
    scan,
    schedulerAssignment: placed.scheduler,
    runnerAssignment: runner,
    scheduler: FakeRuntime.of(node.daemon.api, placed.scheduler, node.daemon.version),
    runner: FakeRuntime.of(node.daemon.api, runner, node.daemon.version),
  }
}

async function workersOf(api: ApiClient, scanId: string): Promise<Worker[]> {
  return ok(await api.listScanWorkers(scanId), 'listScanWorkers').items
}

async function getScan(api: ApiClient, scanId: string): Promise<Scan> {
  return ok(await api.getScan(scanId), 'getScan')
}

test.describe('bootstrap', () => {
  test('the first bootstrap starts the worker and hands each role its configuration', { tag: ['@RT-001'] }, async ({ api, nodes, scans, tasks }) => {
    test.setTimeout(180_000)
    const zoo = await tasks.fixture('schema-zoo')
    const secret = `secret-${randomBytes(8).toString('hex')}`
    const { node, scan, scheduler, runner, schedulerAssignment, runnerAssignment } = await scanOnFakeNode(nodes, scans, zoo.revision.id, {
      taskConfig: { text: 'rt', api_token: secret },
    })
    expect((await getScan(api, scan.id)).scheduling.state).toBe('pending')
    const before = await workersOf(api, scan.id)
    expect(before.map((worker) => worker.state)).not.toContain('running')

    const schedulerBoot = await scheduler.bootstrap()
    expect(schedulerBoot.status).toBe(200)
    const s = schedulerBoot.body as unknown as Bootstrap
    expect(s.action).toBe('run')
    expect(s.worker).toEqual({ id: schedulerAssignment.workerId, role: 'scheduler', scanId: scan.id, nodeId: node.id, epoch: expect.any(Number) })
    expect(s.worker.epoch).toBeGreaterThanOrEqual(1)
    expect(s.scan).toMatchObject({ id: scan.id, state: 'running', round: 1 })
    expect(s.scan.taskConfig).toMatchObject({ text: 'rt', api_token: secret })
    expect(s.scan.scanConfig).toEqual(expect.any(Object))
    expect(s.scan.settings).toMatchObject({
      processes: 1,
      timeoutMs: expect.any(Number),
      maxAttempts: expect.any(Number),
      backoff: expect.any(Object),
      resources: expect.any(Object),
    })
    expect(s.revision).toMatchObject({ id: zoo.revision.id, number: zoo.revision.number, entry: 'main.py', protocolVersion: expect.any(Number) })
    expect(s.revision.schedule).toEqual(zoo.revision.description!.schedule)
    // The node is remote: AMQP through Traefik, credentials of the scan's own RabbitMQ user.
    expect(s.amqp).toMatchObject({
      url: stackEnv().SCANTOR_AMQP_PUBLIC_URL,
      vhost: 'scantor',
      username: `scan-${scan.id}`,
      password: stackKeys().amqpPassword(scan.id),
      queue: `scantor.scan.${scan.id}`,
      routingKey: scan.id,
    })
    expect(s.uploads).toMatchObject({ mode: 'presigned' })
    expect(s.limits).toMatchObject({ maxAnalysesPerScan: Number(stackEnv().SCANTOR_MAX_ANALYSES_PER_SCAN) })
    expect(s.intervals).toMatchObject({ statePollMs: expect.any(Number), drainGraceMs: expect.any(Number) })
    expect(s.scheduler).toEqual({
      restarts: 0,
      checkpoint: { confirmed: 0, tailHash: null },
      resolved: {},
      uploads: {},
      dataSources: { tranco: stackEnv().SCANTOR_TRANCO_URL, crux: stackEnv().SCANTOR_CRUX_URL },
    })

    const runnerBoot = await runner.bootstrap()
    expect(runnerBoot.status).toBe(200)
    const r = runnerBoot.body as unknown as Bootstrap
    expect(r.action).toBe('run')
    expect(r.worker).toEqual({ id: runnerAssignment.workerId, role: 'runner', scanId: scan.id, nodeId: node.id, epoch: 0 })
    expect(r.scan).not.toHaveProperty('scanConfig')
    expect(r.scan.taskConfig).toMatchObject({ api_token: secret })
    expect(r.scan.settings).toMatchObject({ processes: 1 })
    expect(r.scheduler).toBeNull()

    // Effects: both workers run, scheduling runs; the secret stays masked everywhere else.
    const after = await workersOf(api, scan.id)
    for (const worker of after) {
      expect(worker.state, worker.role).toBe('running')
      expect(worker.runtime?.bootstrappedAt, worker.role).not.toBeNull()
    }
    const current = await getScan(api, scan.id)
    expect(current.scheduling.state).toBe('running')
    expect(current.taskConfig).toMatchObject({ api_token: '***' })
    expect(JSON.stringify(current)).not.toContain(secret)
    expect(JSON.stringify(after)).not.toContain(secret)
  })

  test('bootstrap answers stop once the scan no longer runs', { tag: ['@RT-002'] }, async ({ api, echo, nodes, scans }) => {
    const { scan, scheduler, runner } = await scanOnFakeNode(nodes, scans, echo.revision.id)
    expect(ok(await runner.bootstrap(), 'runtimeBootstrap').action).toBe('run')

    ok(await api.call('pauseScan', { path: { scanId: scan.id } }), 'pauseScan')
    expect((await getScan(api, scan.id)).state).toBe('paused')
    for (const runtime of [runner, scheduler]) {
      const paused = await runtime.bootstrap()
      expect(paused.status).toBe(200)
      expect(paused.body.action).toBe('stop')
    }

    ok(await api.cancelScan(scan.id), 'cancelScan')
    const cancelled = await runner.bootstrap()
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.action).toBe('stop')
  })
})

test.describe('uploads', () => {
  test('presigned keys stay inside the scan prefix and the signed size is enforced', { tag: ['@RT-003'] }, async ({ echo, nodes, scans }) => {
    const { scan, scheduler, runner } = await scanOnFakeNode(nodes, scans, echo.revision.id)
    const executionId = randomUUID()
    const content = Buffer.from('presigned content\n')
    const sha256 = createHash('sha256').update(content).digest('hex')
    const file = (name: string, overrides: Record<string, unknown> = {}) => ({
      fileId: randomUUID(),
      name,
      size: content.length,
      sha256,
      contentType: 'text/plain',
      ...overrides,
    })
    const presign = (body: Record<string, unknown>, worker = runner) =>
      worker.call<{ files: { fileId: string; name: string; url: string; method: string; headers: Record<string, string>; expiresAt: string }[] }>(
        'runtimePresignUploads',
        { body },
      )
    const request = { seq: 7, round: 1, attempt: 1, executionId }

    const names = ['..', '.', '%2e%2e%2f..', 'a..b', 'report.txt', '..∕etc∕passwd']
    const files = names.map((name) => file(name))
    const signed = await presign({ ...request, files })
    expect(signed.status).toBe(200)
    expect(signed.body.files.map((entry) => entry.fileId)).toEqual(files.map((entry) => entry.fileId))
    for (const [index, entry] of signed.body.files.entries()) {
      expect(entry.method).toBe('PUT')
      expect(entry.name).toBe(names[index])
      const url = new URL(entry.url)
      const path = decodeURIComponent(url.pathname)
      const prefix = `/files/${scan.id}/7/${executionId}/${files[index]!.fileId}/`
      expect(path, names[index]).toContain(prefix)
      const key = path.slice(path.indexOf(prefix) + prefix.length)
      expect(key, names[index]).toMatch(/^[A-Za-z0-9._-]+$/)
      expect(['.', '..']).not.toContain(key)
      expect(entry.headers).toMatchObject({
        'Content-Type': 'text/plain',
        'Content-Length': String(content.length),
        'x-amz-meta-file-id': files[index]!.fileId,
      })
    }

    // The scan comes from the token: a scanId in the body is an unknown field.
    const override = await presign({ ...request, scanId: randomUUID(), files: [file('x.txt')] })
    expect(override.status).toBe(400)

    // Uploading with exactly the signed headers works; a larger body than signed is refused by S3.
    const target = signed.body.files[4]!
    const put = await fetch(target.url, { method: 'PUT', headers: target.headers, body: content })
    expect(put.status, await put.text()).toBe(200)
    const bigger = Buffer.concat([content, Buffer.from('more bytes than signed')])
    const tooBig = await fetch(signed.body.files[3]!.url, {
      method: 'PUT',
      headers: { ...signed.body.files[3]!.headers, 'Content-Length': String(bigger.length) },
      body: bigger,
    })
    expect(tooBig.status).toBeGreaterThanOrEqual(400)

    // Validation: file ids, seq range, duplicate names, the file count and the file size.
    const duplicateId = randomUUID()
    const invalid: [string, Record<string, unknown>][] = [
      ['malformed fileId', { ...request, files: [file('a.txt', { fileId: 'not-a-uuid' })] }],
      ['uuid that is not v4', { ...request, files: [file('a.txt', { fileId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' })] }],
      ['duplicate fileId', { ...request, files: [file('a.txt', { fileId: duplicateId }), file('b.txt', { fileId: duplicateId })] }],
      ['seq out of range', { ...request, seq: Number(stackEnv().SCANTOR_MAX_ANALYSES_PER_SCAN), files: [file('a.txt')] }],
      ['duplicate names', { ...request, files: [file('same.txt'), file('same.txt')] }],
      ['too many files', { ...request, files: Array.from({ length: Number(stackEnv().SCANTOR_MAX_FILES_PER_ANALYSIS) + 1 }, (_, i) => file(`f${i}.txt`)) }],
      ['oversized file', { ...request, files: [file('big.bin', { size: 1024 * 1024 * 1024 + 1 })] }],
      ['slash in the name', { ...request, files: [file('../escape.txt')] }],
    ]
    for (const [label, body] of invalid) {
      const response = await presign(body)
      expect(response.status, label).toBe(400)
      expect(response.body, label).toMatchObject({ error: { code: 'validationFailed' } })
    }

    // Presigning is a runner route.
    const asScheduler = await presign({ ...request, files: [file('a.txt')] }, scheduler)
    expect(asScheduler.status).toBe(403)
    expect(asScheduler.body).toMatchObject({ error: { code: 'forbidden' } })
  })
})

test.describe('redelivery status', () => {
  test('answers at most 1000 seqs and only for the scan of the token', { tag: ['@RT-004'] }, async ({ echo, nodes, scans }) => {
    const first = await scanOnFakeNode(nodes, scans, echo.revision.id)
    const second = await scanOnFakeNode(nodes, scans, echo.revision.id, { node: first.node })

    // A succeeded result of seq 0 of the first scan, published as that scan's RabbitMQ user (what its runner does).
    const session = await connectAsScan(first.scan.id)
    try {
      const now = Date.now()
      await publish(
        session,
        EXCHANGES.results,
        first.scan.id,
        {
          v: 1,
          kind: 'result',
          analysisId: `${first.scan.id}-0`,
          scanId: first.scan.id,
          seq: 0,
          round: 1,
          attempt: 1,
          executionId: randomUUID(),
          workerId: first.runnerAssignment.workerId,
          nodeId: first.node.id,
          config: {},
          status: 'succeeded',
          result: { echo: 'status' },
          error: null,
          files: [],
          logTail: '',
          timings: { scheduledAt: now, startedAt: now, finishedAt: now, durationMs: 0 },
        },
        { type: 'result', messageId: randomUUID() },
      )
    } finally {
      await session.close()
    }
    await expect.poll(() => scans.counts(first.scan.id), { timeout: 30_000 }).toEqual({ succeeded: 1 })

    const status = (runtime: FakeRuntime, seqs: number[]) =>
      runtime.call<{ items: { seq: number; status: string | null; round: number | null; attempt: number | null }[] }>('runtimeAnalysesStatus', {
        body: { seqs },
      })
    const own = ok(await status(first.runner, [0, 1]), 'runtimeAnalysesStatus')
    expect(own.items).toEqual([
      { seq: 0, status: 'succeeded', round: 1, attempt: 1 },
      { seq: 1, status: null, round: null, attempt: null },
    ])
    const foreign = ok(await status(second.runner, [0]), 'runtimeAnalysesStatus')
    expect(foreign.items).toEqual([{ seq: 0, status: null, round: null, attempt: null }])

    const thousand = Array.from({ length: 1000 }, (_, i) => i)
    expect(ok(await status(first.runner, thousand), 'runtimeAnalysesStatus').items).toHaveLength(1000)
    const tooMany = await status(first.runner, [...thousand, 1000])
    expect(tooMany.status).toBe(400)
    expect(tooMany.body).toMatchObject({ error: { code: 'validationFailed' } })

    const asScheduler = await status(first.scheduler, [0])
    expect(asScheduler.status).toBe(403)
  })
})

test.describe('error reports', () => {
  test('a reported error is accepted with 202 and raises workerErrors and a worker.error event', { tag: ['@RT-005'] }, async ({ api, echo, nodes, scans }) => {
    const { scan, runner, runnerAssignment } = await scanOnFakeNode(nodes, scans, echo.revision.id)
    const message = `connector did not send hello ${unique('rt5')}`
    const reported = await runner.call<{ recorded: boolean }>('runtimeReportError', {
      body: { fatal: false, error: runtimeError({ message }), context: { stderrTail: 'ModuleNotFoundError: No module named requests\n' } },
    })
    expect(reported.status).toBe(202)
    expect(reported.body).toEqual({ recorded: true })

    const current = await getScan(api, scan.id)
    const condition = current.conditions.find((entry) => entry.type === 'workerErrors')
    expect(condition, JSON.stringify(current.conditions)).toBeDefined()
    expect(condition).toMatchObject({ type: 'workerErrors', details: { workerId: runnerAssignment.workerId } })
    expect(JSON.stringify(condition)).toContain(message)

    const events = ok(await api.call<Page<Event>>('listScanEvents', { path: { scanId: scan.id }, query: { type: 'worker.error' } }), 'listScanEvents')
    expect(events.items).toHaveLength(1)
    expect(events.items[0]).toMatchObject({ type: 'worker.error', workerId: runnerAssignment.workerId })
    expect(events.items[0]!.message).toContain(message)

    const worker = (await workersOf(api, scan.id)).find((entry) => entry.id === runnerAssignment.workerId)!
    expect(worker.runtime?.lastError).toMatchObject({ type: 'platform', phase: 'bootstrap', message })

    const malformed = await runner.call('runtimeReportError', { body: { fatal: false, error: { type: 'nonsense' } } })
    expect(malformed.status).toBe(400)
  })
})

test.describe('worker scope', () => {
  test(
    'worker routes accept only worker tokens of active workers in their role',
    { tag: ['@AUTHZ-013'] },
    async ({ adminApi, anonApi, api, apiKeyApi, echo, nodes, scans }) => {
      const { node, scan, scheduler, runner, schedulerAssignment, runnerAssignment } = await scanOnFakeNode(nodes, scans, echo.revision.id)
      const epoch = ok(await scheduler.bootstrap(), 'runtimeBootstrap') as unknown as Bootstrap
      const bodies: Record<string, unknown> = {
        runtimeBootstrap: undefined,
        runtimeState: STATE_REPORT,
        runtimePresignUploads: { seq: 0, round: 1, attempt: 1, executionId: randomUUID(), files: [] },
        runtimeAnalysesStatus: { seqs: [0] },
        schedulerResolved: { epoch: epoch.worker.epoch, key: 'schedule', template: 'single', scanConfig: {}, provenance: {}, expectedTotal: 1 },
        schedulerCheckpoint: { epoch: epoch.worker.epoch, confirmed: 1, tailHash: hash('a') },
        schedulerDone: { epoch: epoch.worker.epoch, outcome: 'done', confirmed: 1, tailHash: hash('a') },
        runtimeReportError: { fatal: false, error: runtimeError() },
      }
      const nodeHeaders = { Authorization: `Bearer ${node.daemon.token}` }
      for (const [operationId, body] of Object.entries(bodies)) {
        for (const [label, client, headers] of [
          ['anonymous', anonApi, {}],
          ['session', api, {}],
          ['API key', apiKeyApi, {}],
          ['node token', anonApi, nodeHeaders],
        ] as const) {
          const response = await client.call(operationId, { body, headers })
          expect(response.status, `${operationId} as ${label}`).toBe(401)
          expect(response.body, `${operationId} as ${label}`).toMatchObject({ error: { code: 'unauthorized' } })
        }
      }

      for (const operationId of ['schedulerResolved', 'schedulerCheckpoint', 'schedulerDone']) {
        const response = await runner.call(operationId, { body: bodies[operationId] })
        expect(response.status, operationId).toBe(403)
        expect(response.body, operationId).toMatchObject({ error: { code: 'forbidden' } })
      }
      expect((await getScan(api, scan.id)).scheduling).toMatchObject({ state: 'running', confirmed: 0 })

      // A stopped worker: pause drains both workers; the node reports their containers removed.
      ok(await api.call('pauseScan', { path: { scanId: scan.id } }), 'pauseScan')
      node.reports.set(schedulerAssignment.workerId, { workerId: schedulerAssignment.workerId, state: 'removed' })
      node.reports.set(runnerAssignment.workerId, { workerId: runnerAssignment.workerId, state: 'removed' })
      await expect
        .poll(
          async () => {
            await node.report()
            return (await workersOf(api, scan.id)).map((worker) => worker.state)
          },
          { timeout: 30_000 },
        )
        .toEqual(['stopped', 'stopped'])
      for (const runtime of [scheduler, runner]) {
        const stopped = await runtime.bootstrap()
        expect(stopped.status).toBe(401)
        expect(stopped.body).toMatchObject({ error: { code: 'unauthorized' } })
      }

      // A lost worker: resume places new workers on the node; deleting the node loses them.
      node.reports.clear()
      ok(await api.call('resumeScan', { path: { scanId: scan.id } }), 'resumeScan')
      const replaced = await node.waitForAssignments((current) => current.workers.filter((worker) => worker.scanId === scan.id).length === 2)
      const fresh = replaced.workers
        .filter((worker) => worker.scanId === scan.id)
        .map((assignment) => FakeRuntime.of(node.daemon.api, assignment, node.daemon.version))
      expect((await fresh[0]!.call('runtimeState', { body: STATE_REPORT })).status).toBe(200)
      await node.stopHeartbeat()
      expect((await adminApi.deleteNode(node.id)).status).toBe(204)
      await expect.poll(async () => (await workersOf(api, scan.id)).filter((worker) => worker.state === 'lost').length, { timeout: 30_000 }).toBe(2)
      for (const runtime of fresh) {
        const lost = await runtime.call('runtimeState', { body: STATE_REPORT })
        expect(lost.status).toBe(401)
      }
    },
  )
})

test.describe('scheduler routes', () => {
  test('checkpoints only move forward and an existing resolution is returned unchanged', { tag: ['@SCHED-002'] }, async ({ api, echo, nodes, scans }) => {
    const { scan, scheduler } = await scanOnFakeNode(nodes, scans, echo.revision.id)
    const { worker } = ok(await scheduler.bootstrap(), 'runtimeBootstrap') as unknown as Bootstrap
    const checkpoint = (confirmed: number, tailHash: string | null) =>
      scheduler.call<{ confirmed: number; tailHash: string | null; serverTime: number }>('schedulerCheckpoint', {
        body: { epoch: worker.epoch, confirmed, tailHash },
      })

    expect(ok(await checkpoint(10, hash('a')), 'schedulerCheckpoint')).toMatchObject({ confirmed: 10, tailHash: hash('a') })
    expect((await getScan(api, scan.id)).scheduling).toMatchObject({ confirmed: 10, tailHash: hash('a') })
    expect(ok(await checkpoint(5, hash('b')), 'schedulerCheckpoint')).toMatchObject({ confirmed: 10, tailHash: hash('a') })
    expect(ok(await checkpoint(10, hash('c')), 'schedulerCheckpoint')).toMatchObject({ confirmed: 10, tailHash: hash('a') })
    expect((await getScan(api, scan.id)).scheduling).toMatchObject({ confirmed: 10, tailHash: hash('a') })
    expect(ok(await checkpoint(20, hash('d')), 'schedulerCheckpoint')).toMatchObject({ confirmed: 20, tailHash: hash('d') })
    const inconsistent = await checkpoint(0, hash('e'))
    expect(inconsistent.status).toBe(400)

    const resolve = (expectedTotal: number, key = 'schedule') =>
      scheduler.call<{
        stored: boolean
        resolution: { template: string; scanConfig: Record<string, unknown>; provenance: Record<string, unknown>; expectedTotal: number | null; at: string }
      }>('schedulerResolved', {
        body: {
          epoch: worker.epoch,
          key,
          template: 'single',
          scanConfig: { marker: expectedTotal },
          provenance: { source: `test-${expectedTotal}` },
          expectedTotal,
        },
      })
    const stored = ok(await resolve(1), 'schedulerResolved')
    expect(stored).toMatchObject({
      stored: true,
      resolution: { template: 'single', scanConfig: { marker: 1 }, provenance: { source: 'test-1' }, expectedTotal: 1 },
    })
    const current = await getScan(api, scan.id)
    expect(current.scheduling.resolved?.schedule).toMatchObject({ template: 'single', expectedTotal: 1 })
    expect(current.stats.expectedTotal).toBe(1)

    const again = ok(await resolve(99), 'schedulerResolved')
    expect(again).toEqual({ stored: false, resolution: stored.resolution })
    expect((await getScan(api, scan.id)).stats.expectedTotal).toBe(1)
    expect(ok(await resolve(5, 'call:1'), 'schedulerResolved').stored).toBe(true)
  })

  test('a superseded scheduler epoch gets 409 staleEpoch and cannot end scheduling', { tag: ['@SCHED-010'] }, async ({ api, echo, nodes, scans }) => {
    const { node, scan, scheduler, schedulerAssignment } = await scanOnFakeNode(nodes, scans, echo.revision.id)
    const old = (ok(await scheduler.bootstrap(), 'runtimeBootstrap') as unknown as Bootstrap).worker.epoch
    ok(await scheduler.call('schedulerCheckpoint', { body: { epoch: old, confirmed: 3, tailHash: hash('1') } }), 'schedulerCheckpoint')

    // An epoch in the body other than the token's is fenced as well.
    const wrongBody = await scheduler.call('schedulerCheckpoint', { body: { epoch: old + 1, confirmed: 4, tailHash: hash('2') } })
    expect(wrongBody.status).toBe(409)
    expect(wrongBody.body).toMatchObject({ error: { code: 'staleEpoch', details: { currentEpoch: old } } })

    // Pause and resume: a new scheduler with epoch + 1 fences the old one, which is still draining. The reconciler is
    // level-triggered, so the resume waits until the pause has taken the workers out of the node's desired set.
    ok(await api.call('pauseScan', { path: { scanId: scan.id } }), 'pauseScan')
    await node.waitForAssignments((current) => !current.workers.some((worker) => worker.scanId === scan.id))
    ok(await api.call('resumeScan', { path: { scanId: scan.id } }), 'resumeScan')
    const isSuccessor = (worker: { scanId: string; role: string; workerId: string }) =>
      worker.scanId === scan.id && worker.role === 'scheduler' && worker.workerId !== schedulerAssignment.workerId
    const next = await node.waitForAssignments((current) => current.workers.some(isSuccessor))
    const newAssignment = next.workers.find(isSuccessor)!
    const current = await getScan(api, scan.id)
    expect(current.scheduling.epoch).toBe(old + 1)

    for (const [operationId, body] of [
      ['schedulerCheckpoint', { epoch: old, confirmed: 9, tailHash: hash('3') }],
      ['schedulerResolved', { epoch: old, key: 'schedule', template: 'single', scanConfig: {}, provenance: {}, expectedTotal: 1 }],
      ['schedulerDone', { epoch: old, outcome: 'done', confirmed: 9, tailHash: hash('3') }],
    ] as const) {
      const stale = await scheduler.call(operationId, { body })
      expect(stale.status, operationId).toBe(409)
      expect(stale.body, operationId).toMatchObject({ error: { code: 'staleEpoch', details: { currentEpoch: old + 1 } } })
    }
    expect((await getScan(api, scan.id)).scheduling).toMatchObject({ state: 'running', confirmed: 3, epoch: old + 1 })
    expect(ok(await scheduler.bootstrap(), 'runtimeBootstrap').action).toBe('stop')

    // The current scheduler continues from the stored prefix.
    const successor = FakeRuntime.of(node.daemon.api, newAssignment, node.daemon.version)
    const resumed = ok(await successor.bootstrap(), 'runtimeBootstrap') as unknown as Bootstrap
    expect(resumed.worker.epoch).toBe(old + 1)
    expect(resumed.scheduler?.checkpoint).toEqual({ confirmed: 3, tailHash: hash('1') })
    expect(
      ok(await successor.call('schedulerCheckpoint', { body: { epoch: old + 1, confirmed: 4, tailHash: hash('4') } }), 'schedulerCheckpoint'),
    ).toMatchObject({ confirmed: 4 })
  })
})
