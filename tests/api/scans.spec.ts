import { randomUUID } from 'node:crypto'
import type { Revision } from '#shared/types/revisions'
import type { Scan, ScanSummary } from '#shared/types/scans'
import type { Upload } from '#shared/types/uploads'
import type { Worker } from '#shared/types/workers'
import { ok, type ApiClient, type ApiResponse } from '../helpers/api-client'
import {
  apiErrorOf,
  eventTypes,
  getScan,
  otherKeyApi,
  cancellingScansFixture,
  scanLimits,
  scanOps,
  sharedTasksFixture,
  tenantKeyApi,
  tryStartScan,
  UNPLACEABLE_POOL,
  UNPLACEABLE_SETTINGS,
  waitFor,
  waitRunning,
  withKeyClient,
  workerKeyApi,
  type SharedTasks,
} from '../helpers/api-scans'
import { exampleWithChangedCode, exampleWithDefaults, lifecycleTask } from '../helpers/api-scans-tasks'
import { scantor } from '../helpers/cli'
import { SMALL_SETTINGS } from '../helpers/scans'
import { exampleTaskDir, packTask, removeDir, uploadAndPublish, waitForRevision } from '../helpers/tasks'
import { expect, test as base, unique } from '../fixtures'

// The scans tag of the REST API (docs/api.md §4.13, §5.1; docs/architecture.md §11.3): start validation and its
// order, the read routes (list, get with wait, conditions, events, workers, in-flight analyses, worker logs) and the
// lifecycle transition table. Scans that only need a state use UNPLACEABLE_SETTINGS (a pool without nodes), so they
// become `running` without taking node capacity; scans that must run use SMALL_SETTINGS and a few short analyses.
// Broker, scaling and retry behaviour that needs real work is in e2e/lifecycle.spec.ts.
//
// Speed: every worker builds the `sleep` example and the generated lifecycle task once (`shared`) and every test
// reuses them; only tests that need a revision of their own (references, privileged, a removed revision) build one.

const test = base.extend<object, { workerApi: ApiClient; shared: SharedTasks }>({
  // The tenants act through their API keys (helpers/api-scans.ts explains why).
  api: tenantKeyApi,
  otherApi: [otherKeyApi, { scope: 'worker' }],
  workerApi: [workerKeyApi, { scope: 'worker' }],
  shared: [sharedTasksFixture(['sleep', 'lifecycle']), { scope: 'worker', auto: true }],
  scans: cancellingScansFixture,
})

// The first test of a worker also builds the shared tasks.
test.describe.configure({ timeout: 180_000 })

const SCAN_SUMMARY_KEYS = [
  'completedAt',
  'conditionsCount',
  'createdAt',
  'id',
  'name',
  'progress',
  'revision',
  'settings',
  'state',
  'stateReason',
  'stats',
  'task',
  'userId',
]

/** Uploads `text` (kind list) as the client's user. */
async function createUpload(api: ApiClient, text: string): Promise<Upload> {
  const response = await api.call<Upload>('createUpload', {
    body: Buffer.from(text),
    headers: { 'Content-Type': 'text/plain' },
    query: { name: 'targets.txt', kind: 'list' },
  })
  return ok(response, 'createUpload')
}

async function deleteUpload(api: ApiClient, uploadId: string): Promise<void> {
  const response = await api.call('deleteUpload', { path: { uploadId } })
  if (response.status !== 204 && response.status !== 404) throw new Error(`deleteUpload answered ${response.status}`)
}

/** The ids of `items` that are in `mine`, in list order (lists are filtered by the test's own ids). */
const mineOf = (items: { id: string }[], mine: string[]) => items.map((item) => item.id).filter((id) => mine.includes(id))

test.describe('start validation', () => {
  test('a new scan starts in creating with merged settings and runs to completion', { tag: ['@SCAN-001'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.get('sleep')
    const scan = await scans.start({ revision: revision.ref, name: 'first scan', taskConfig: { seconds: 0 } })

    expect(scan.state).toBe('creating')
    expect(scan.round).toBe(1)
    expect(scan.name).toBe('first scan')
    expect(scan.revision).toMatchObject({ id: revision.id, number: revision.number, ref: revision.ref })
    expect(scan.settings).toEqual({
      ...revision.settingsDefaults,
      workers: SMALL_SETTINGS.workers,
      processes: SMALL_SETTINGS.processes,
      resources: SMALL_SETTINGS.resources,
      nodeSelector: { pool: 'shared', labels: {} },
    })
    expect(scan.scheduling).toMatchObject({ state: 'pending', confirmed: 0, epoch: 0 })
    expect(await eventTypes(api, scan.id, 'scan.created')).toEqual(['scan.created'])

    const done = await scans.wait(scan.id, { timeoutMs: 120_000 })
    expect(done).toMatchObject({ state: 'completed', round: 1 })
    expect(await scans.counts(scan.id)).toEqual({ succeeded: 1 })
  })

  test(
    'the revision reference accepts task@N, task@latest, a bare task, a revision id and a task id; unfinished revisions are refused first',
    { tag: ['@SCAN-002', '@SCAN-003', '@SCAN-010'] },
    async ({ api, tasks, scans }) => {
      // A failed revision (forbidden labels: the static check fails), built while the rest of the test runs.
      const failing = tasks.fixture('hostile-label', { expectState: 'failed' })
      failing.catch(() => undefined)

      // Two revisions of one task, published without waiting: both are queued or building at first.
      const name = unique('refs')
      tasks.track(name)
      const first = ok(await api.uploadTask(await packTask(exampleTaskDir('sleep'), { name }), { publish: true }), 'uploadTask')
      const dir = await exampleWithChangedCode('sleep', 'main.py', 'the second revision')
      let secondId: string
      try {
        const second = ok(await api.uploadTask(await packTask(dir, { name }), { publish: true }), 'uploadTask')
        expect(second.revision?.number).toBe(first.revision!.number + 1)
        secondId = second.revision!.id
      } finally {
        await removeDir(dir)
      }

      // Not ready: 409 before the invalid task config would be reported (422). The requests run at once, right after
      // the uploads, so both revisions are still unfinished.
      const notReady = async (ref: string, states: string[]) => {
        const response = await tryStartScan(api, scans.track, { revision: ref, taskConfig: { notAField: true } })
        const details = apiErrorOf(response, 409, 'revisionNotReady').details
        expect(states, ref).toContain(details?.state)
      }
      await Promise.all([`${name}@1`, `${name}@2`, `${name}@latest`, name, first.revision!.id].map((ref) => notReady(ref, ['queued', 'building'])))

      // The failed revision and @latest of its task.
      const failed = await failing
      await Promise.all([failed.revision.ref, `${failed.task.name}@latest`, failed.task.name].map((ref) => notReady(ref, ['failed'])))

      const [one, two] = await Promise.all([waitForRevision(api, name, first.revision!.id), waitForRevision(api, name, secondId)])
      expect([one.state, two.state]).toEqual(['ready', 'ready'])
      const cases: [string, Revision][] = [
        [`${name}@${one.number}`, one],
        [`${name}@latest`, two],
        [name, two],
        [one.id, one],
        [first.task.id, two],
      ]
      for (const [ref, expected] of cases) {
        const scan = await scans.start({ revision: ref, settings: UNPLACEABLE_SETTINGS })
        expect(scan.revision, ref).toMatchObject({ id: expected.id, number: expected.number, ref: `${name}@${expected.number}` })
      }
    },
  )

  test('task and scan configs are validated against the revision schemas and stored with defaults', { tag: ['@SCAN-004'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.get('sleep')

    const rejected = await tryStartScan(api, scans.track, {
      revision: revision.ref,
      taskConfig: { seconds: -1 },
      scanConfig: { times: 0, extra: true },
    })
    const issues = apiErrorOf(rejected, 422, 'configInvalid').details?.issues as { path: string; message: string }[]
    expect(issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(['/taskConfig/seconds', '/scanConfig/times', '/scanConfig/extra']))
    for (const issue of issues) expect(issue.message).toEqual(expect.any(String))

    const scan = await scans.start({ revision: revision.ref, taskConfig: {}, scanConfig: {}, settings: UNPLACEABLE_SETTINGS })
    expect({ taskConfig: scan.taskConfig, scanConfig: scan.scanConfig }).toEqual({ taskConfig: { seconds: 5 }, scanConfig: { times: 1 } })
    const stored = await getScan(api, scan.id)
    expect({ taskConfig: stored.taskConfig, scanConfig: stored.scanConfig }).toEqual({ taskConfig: { seconds: 5 }, scanConfig: { times: 1 } })
  })

  test('a task or scan config above the size limit is a validation failure', { tag: ['@SCAN-005'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.get('sleep')
    const { maxScanConfigBytes } = scanLimits()
    // {"pad":"…"}: 10 bytes of JSON around the padding.
    const ofSize = (bytes: number) => ({ pad: 'x'.repeat(bytes - 10) })
    expect(Buffer.byteLength(JSON.stringify(ofSize(maxScanConfigBytes)))).toBe(maxScanConfigBytes)

    for (const kind of ['taskConfig', 'scanConfig'] as const) {
      const tooLarge = await tryStartScan(api, scans.track, { revision: revision.ref, [kind]: ofSize(maxScanConfigBytes + 1) })
      const issues = apiErrorOf(tooLarge, 400, 'validationFailed').details?.issues as { path: string }[]
      expect(issues.map((issue) => issue.path)).toContain(kind)

      // Exactly at the limit the size passes, and the unknown key fails the schema instead.
      const atLimit = await tryStartScan(api, scans.track, { revision: revision.ref, [kind]: ofSize(maxScanConfigBytes) })
      expect(apiErrorOf(atLimit, 422, 'configInvalid').details?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: `/${kind}/pad` })]))
    }
  })

  test('settings outside the static bounds are rejected by startScan, scaleScan and restartScan', { tag: ['@SCAN-006'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.get('sleep')
    const limits = scanLimits()
    const labels = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`key${index}`, 'value']))
    const invalid: [string, Record<string, unknown>][] = [
      ['timeoutMs below 1000', { timeoutMs: 999 }],
      ['timeoutMs above 24 h', { timeoutMs: 86_400_001 }],
      ['maxAttempts above 20', { maxAttempts: 21 }],
      ['cpus below 0.1', { resources: { cpus: 0.09 } }],
      ['memoryMiB below 64', { resources: { memoryMiB: 63 } }],
      ['17 node labels', { nodeSelector: { labels } }],
      ['an invalid pool', { nodeSelector: { pool: 'Not_A_Pool' } }],
      ['workers above the instance limit', { workers: limits.maxWorkersPerScan + 1 }],
      ['processes above the instance limit', { processes: limits.maxProcessesPerWorker + 1 }],
      ['the unknown key privileged', { privileged: false }],
    ]
    for (const [label, override] of invalid) {
      const response = await tryStartScan(api, scans.track, { revision: revision.ref, settings: { ...UNPLACEABLE_SETTINGS, ...override } })
      expect(response.status, label).toBe(400)
      apiErrorOf(response, 400, 'validationFailed')
    }

    const scan = await scans.start({ revision: revision.ref, settings: UNPLACEABLE_SETTINGS })
    const ops = scanOps(api)
    for (const body of [{ workers: limits.maxWorkersPerScan + 1 }, { processes: limits.maxProcessesPerWorker + 1 }, { workers: 0 }]) {
      apiErrorOf(await ops.scale(scan.id, body), 400, 'validationFailed')
    }
    for (const settings of [{ workers: limits.maxWorkersPerScan + 1 }, { processes: limits.maxProcessesPerWorker + 1 }, { timeoutMs: 60_000 }]) {
      apiErrorOf(await ops.restart(scan.id, { settings }), 400, 'validationFailed')
    }
    // Nothing changed and no clone was created.
    expect((await getScan(api, scan.id)).settings).toEqual(scan.settings)
    expect(await eventTypes(api, scan.id, 'scan.')).not.toContain('scan.restarted')
  })

  test('partial nested settings merge over the revision defaults, also through the CLI', { tag: ['@SCAN-007'] }, async ({ user, shared, scans }) => {
    // The lifecycle task's manifest sets timeout, attempts, backoff.initial and resources (LIFECYCLE_DEFAULTS).
    const { revision } = await shared.get('lifecycle')
    const defaults = revision.settingsDefaults!
    expect(defaults).toMatchObject({ timeoutMs: 45_000, maxAttempts: 4, backoff: { initialMs: 2000 }, resources: { cpus: 0.5, memoryMiB: 200 } })

    // resources {cpus} alone keeps the default memory; nodeSelector {pool} without labels gets empty labels.
    const cpusOnly = await scans.start({ revision: revision.ref, settings: { resources: { cpus: 0.25 }, nodeSelector: { pool: UNPLACEABLE_POOL } } })
    expect(cpusOnly.settings).toEqual({ ...defaults, resources: { cpus: 0.25, memoryMiB: 200 }, nodeSelector: { pool: UNPLACEABLE_POOL, labels: {} } })

    // backoff {factor} alone keeps the other backoff defaults; labels without a pool keep the default pool.
    const factorOnly = await scans.start({ revision: revision.ref, settings: { backoff: { factor: 3 }, nodeSelector: { labels: { zone: UNPLACEABLE_POOL } } } })
    expect(factorOnly.settings).toEqual({
      ...defaults,
      backoff: { ...defaults.backoff, factor: 3 },
      nodeSelector: { pool: 'shared', labels: { zone: UNPLACEABLE_POOL } },
    })

    const settings = JSON.stringify({ resources: { memoryMiB: 128 }, nodeSelector: { pool: UNPLACEABLE_POOL } })
    const cli = await scantor(['scans', 'start', revision.ref, '--settings', settings, '--workers', '1', '-o', 'json'], { token: user.apiKey })
    const started = cli.json as Scan | undefined
    if (started?.id) scans.track(started.id)
    expect(cli.exitCode, cli.stdout + cli.stderr).toBe(0)
    expect(started?.settings).toEqual({
      ...defaults,
      workers: 1,
      resources: { cpus: 0.5, memoryMiB: 128 },
      nodeSelector: { pool: UNPLACEABLE_POOL, labels: {} },
    })
  })

  test(
    'referenced uploads must exist and belong to the owner, at most 32 of them; validation runs in order',
    { tag: ['@SCAN-008', '@SCAN-010'] },
    async ({ api, otherApi, shared, scans }) => {
      const { revision } = await shared.get('lifecycle')
      expect(revision.description?.uploadPaths.taskConfig).toEqual(['/lists/*'])
      const limits = scanLimits()
      const randomIds = (count: number) => Array.from({ length: count }, () => randomUUID())
      const start = (taskConfig: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
        tryStartScan(api, scans.track, { revision: revision.ref, taskConfig, settings: UNPLACEABLE_SETTINGS, ...extra })

      const own = await createUpload(api, `example.org\n${unique('own')}\n`)
      const foreign = await createUpload(otherApi, `example.net\n${unique('foreign')}\n`)
      try {
        apiErrorOf(await start({ lists: randomIds(1) }), 404, 'notFound')
        apiErrorOf(await start({ lists: [own.id, foreign.id] }), 404, 'notFound')
        apiErrorOf(await start({ lists: randomIds(33) }), 400, 'validationFailed')

        // Order (docs/api.md §5.1): body schema → revision → configs → settings bounds → uploads.
        const tooManyWorkers = { settings: { ...UNPLACEABLE_SETTINGS, workers: limits.maxWorkersPerScan + 1 } }
        apiErrorOf(await api.startScan({ revision: `${unique('missing')}@1`, unknownKey: true }), 400, 'validationFailed')
        apiErrorOf(await api.startScan({ revision: `${unique('missing')}@1`, taskConfig: { lists: 'not-a-list' } }), 404, 'notFound')
        apiErrorOf(await start({ lists: 'not-a-list' }, tooManyWorkers), 422, 'configInvalid')
        expect(apiErrorOf(await start({ lists: randomIds(1) }, tooManyWorkers), 400, 'validationFailed').details?.issues).toEqual([
          expect.objectContaining({ path: 'settings.workers' }),
        ])

        const scan = ok(await start({ lists: [own.id] }), 'startScan')
        expect(scan.uploadIds).toEqual([own.id])
      } finally {
        await deleteUpload(otherApi, foreign.id)
      }
    },
  )

  test(
    'template estimates need confirmation above the threshold and are refused above the maximum; a restart needs no confirmation',
    { tag: ['@SCAN-009', '@SCAN-035'] },
    async ({ api, shared, scans }) => {
      const { revision } = await shared.get('sleep')
      const { confirmThreshold, maxAnalysesPerScan } = scanLimits()
      const start = (times: number, confirm?: boolean) =>
        tryStartScan(api, scans.track, { revision: revision.ref, scanConfig: { times }, settings: UNPLACEABLE_SETTINGS, confirm })

      expect(apiErrorOf(await start(confirmThreshold + 1), 422, 'confirmationRequired').details).toEqual({
        expectedTotal: confirmThreshold + 1,
        threshold: confirmThreshold,
      })
      expect(apiErrorOf(await start(confirmThreshold + 1, false), 422, 'confirmationRequired').details).toMatchObject({ threshold: confirmThreshold })
      expect(apiErrorOf(await start(maxAnalysesPerScan + 1, true), 422, 'scanTooLarge').details).toEqual({
        expectedTotal: maxAnalysesPerScan + 1,
        max: maxAnalysesPerScan,
      })

      const atThreshold = ok(await start(confirmThreshold), 'startScan')
      expect(atThreshold.stats.expectedTotal).toBe(confirmThreshold)
      const confirmed = ok(await start(confirmThreshold + 1, true), 'startScan')
      expect(confirmed.stats.expectedTotal).toBe(confirmThreshold + 1)

      // A restart estimates again but needs no confirmation.
      const clone = ok(await scanOps(api).restart(confirmed.id), 'restartScan')
      scans.track(clone.id)
      expect(clone).toMatchObject({ clonedFrom: confirmed.id, state: 'creating', stats: { expectedTotal: confirmThreshold + 1 } })
    },
  )

  test('the privilege check runs before the settings and config validation', { tag: ['@SCAN-010'] }, async ({ adminApi, openapi, freshUser }) => {
    const grant = async (canRunPrivileged: boolean) =>
      ok(await adminApi.call('updateUser', { path: { userId: freshUser.id }, body: { canRunPrivileged } }), 'updateUser')
    // The fresh user (and its task) is purged at teardown; a scan that was created by mistake would go with it.
    await withKeyClient(openapi, freshUser, async (freshApi) => {
      await grant(true)
      const dir = await exampleWithDefaults('sleep', { privileged: true })
      let revision: Revision
      try {
        revision = (await uploadAndPublish(freshApi, dir, unique('privileged'))).revision
      } finally {
        await removeDir(dir)
      }
      expect(revision.privileged).toBe(true)
      await grant(false)

      const { maxWorkersPerScan } = scanLimits()
      const response = await freshApi.startScan({
        revision: revision.ref,
        taskConfig: { seconds: -1 },
        settings: { ...UNPLACEABLE_SETTINGS, workers: maxWorkersPerScan + 1 },
      })
      apiErrorOf(response, 403, 'privilegedNotAllowed')
    })
  })

  test('a custom schedule has no expected total and needs no confirmation', { tag: ['@SCAN-011', '@SCAN-009'] }, async ({ shared, scans }) => {
    const { revision } = await shared.get('lifecycle')
    expect(revision.description?.schedule.kind).not.toBe('template')
    const { confirmThreshold } = scanLimits()
    const scan = await scans.start({ revision: revision.ref, scanConfig: { count: confirmThreshold * 2 }, settings: UNPLACEABLE_SETTINGS })
    expect(scan.stats.expectedTotal).toBeNull()
    expect(scan.progress).toEqual({ scheduled: 0, terminal: 0, total: null, percent: null, etaSeconds: null })
  })
})

test.describe('reads', () => {
  test('listScans returns summaries filtered by state and task, without deleted scans', { tag: ['@SCAN-014'] }, async ({ api, shared, scans }) => {
    const sleep = await shared.get('sleep')
    const start = (name: string) => scans.start({ revision: sleep.revision.ref, name, settings: UNPLACEABLE_SETTINGS })
    const active = await start('active')
    const cancelled = await start('cancelled')
    ok(await api.cancelScan(cancelled.id), 'cancelScan')
    const deleted = await start('deleted')
    ok(await api.cancelScan(deleted.id), 'cancelScan')
    ok(await api.deleteScan(deleted.id), 'deleteScan')
    const mine = [active.id, cancelled.id, deleted.id]

    const ids = async (query: Record<string, string>) => mineOf(ok(await api.listScans({ limit: 200, ...query }), 'listScans').items, mine)

    const page = ok(await api.listScans({ task: sleep.task.name, limit: 200 }), 'listScans')
    expect(mineOf(page.items, mine)).toEqual([cancelled.id, active.id])
    for (const summary of page.items) expect(Object.keys(summary).sort()).toEqual(SCAN_SUMMARY_KEYS)
    const summary = page.items.find((item) => item.id === cancelled.id) as ScanSummary
    expect(summary).toMatchObject({
      userId: cancelled.userId,
      name: 'cancelled',
      task: { id: sleep.task.id, name: sleep.task.name },
      revision: { id: sleep.revision.id, number: sleep.revision.number, ref: sleep.revision.ref },
      state: 'cancelled',
      stateReason: { code: 'user' },
      settings: { workers: 1, processes: 1 },
      progress: { total: 1 },
      stats: { expectedTotal: 1 },
      completedAt: expect.any(String),
    })
    expect(typeof summary.conditionsCount).toBe('number')

    expect(await ids({})).toEqual([cancelled.id, active.id])
    expect(await ids({ task: sleep.task.id })).toEqual([cancelled.id, active.id])
    expect(await ids({ task: sleep.task.name, state: 'cancelled' })).toEqual([cancelled.id])
    expect(await ids({ task: sleep.task.name, state: 'creating,running' })).toEqual([active.id])
    expect(await ids({ task: sleep.task.name, state: 'cancelled,creating,running' })).toEqual([cancelled.id, active.id])
    expect(await ids({ task: sleep.task.name, state: 'deleting,deleted' })).toEqual([deleted.id])
  })

  test('getScan returns progress and workers and long-polls until the scan settles', { tag: ['@SCAN-015', '@SCAN-017'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.get('sleep')
    const scan = await scans.start({ revision: revision.ref, settings: UNPLACEABLE_SETTINGS })

    const plain = await api.getScan(scan.id)
    expect(plain.headers['scantor-wait']).toBeUndefined()
    expect(plain.body.progress).toEqual({ scheduled: 0, terminal: 0, total: 1, percent: 0, etaSeconds: null })
    expect(Object.keys(plain.body.workers).sort()).toEqual(['active', 'byState', 'desired', 'pending'])

    // creating or running: the wait runs out.
    const timedOutAt = Date.now()
    const timedOut = await api.getScan(scan.id, 2)
    expect(timedOut.headers['scantor-wait']).toBe('timeout')
    expect(Date.now() - timedOutAt).toBeGreaterThanOrEqual(1_500)
    expect(['creating', 'running']).toContain(timedOut.body.state)

    // A running scan with its workers pending: the scheduler (scheduling is pending) and one runner.
    const running = await waitRunning(api, scan.id)
    expect(running.workers).toMatchObject({ desired: 2, active: 0 })

    // A wait in progress returns as soon as the scan pauses.
    const pausedAt = Date.now()
    const waiting = api.getScan(scan.id, 60)
    ok(await scanOps(api).pause(scan.id), 'pauseScan')
    const settled = await waiting
    expect(settled.headers['scantor-wait']).toBe('settled')
    expect(settled.body.state).toBe('paused')
    expect(Date.now() - pausedAt).toBeLessThan(30_000)

    // A paused scan is settled: the wait returns at once.
    const immediateAt = Date.now()
    const immediate = await api.getScan(scan.id, 60)
    expect(immediate.headers['scantor-wait']).toBe('settled')
    expect(Date.now() - immediateAt).toBeLessThan(10_000)
    expect(immediate.body.workers.desired).toBe(0)
  })

  test('conditions and events of a scan whose workers cannot be placed', { tag: ['@SCAN-018', '@SCAN-019'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.get('sleep')
    const scan = await scans.start({ revision: revision.ref, settings: UNPLACEABLE_SETTINGS })
    const ops = scanOps(api)

    // Both workers (the scheduler and the one runner) are pending, so the condition no longer changes.
    const conditions = await waitFor(
      'the workersPending condition for two workers',
      async () => ok(await ops.conditions(scan.id), 'listScanConditions').items,
      (items) => items.some((condition) => condition.type === 'workersPending' && (condition.details as { count?: number } | undefined)?.count === 2),
      { timeoutMs: 60_000 },
    )
    expect(conditions.find((condition) => condition.type === 'workersPending')).toMatchObject({
      severity: 'warning',
      reason: 'selectorMismatch',
      message: expect.stringContaining('cannot be placed'),
      details: { count: 2, reasons: { selectorMismatch: 2 } },
    })
    expect((await getScan(api, scan.id)).conditions).toEqual(conditions)

    await waitRunning(api, scan.id)
    ok(await ops.scale(scan.id, { workers: 2 }), 'scaleScan')
    const clone = ok(await ops.restart(scan.id), 'restartScan')
    scans.track(clone.id)
    ok(await ops.pause(scan.id), 'pauseScan')
    ok(await api.cancelScan(scan.id), 'cancelScan')

    // The condition is cleared once the scan stops running; the stream records every step.
    await waitFor(
      'the conditionCleared event',
      () => eventTypes(api, scan.id),
      (types) => types.includes('scan.conditionCleared'),
      { timeoutMs: 60_000 },
    )
    expect(ok(await ops.conditions(scan.id), 'listScanConditions').items).toEqual([])

    const page = ok(await ops.events(scan.id, { limit: 200 }), 'listScanEvents')
    expect(page.items.map((event) => event.type)).toEqual(
      expect.arrayContaining(['scan.created', 'worker.pending', 'scan.scaled', 'scan.restarted', 'scan.stateChanged', 'scan.conditionCleared']),
    )
    const times = page.items.map((event) => Date.parse(event.at))
    expect(times).toEqual([...times].sort((a, b) => b - a))
    expect(page.items.at(-1)?.type).toBe('scan.created')
    for (const event of page.items) expect(event.scanId).toBe(scan.id)

    const stateChanges = ok(await ops.events(scan.id, { type: 'scan.stateChanged' }), 'listScanEvents').items
    expect(stateChanges.map((event) => event.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'running', to: 'paused', reason: 'user' }),
        expect.objectContaining({ from: 'paused', to: 'cancelled', reason: 'user' }),
      ]),
    )
    expect(new Set(stateChanges.map((event) => event.type))).toEqual(new Set(['scan.stateChanged']))
    const workerEvents = await eventTypes(api, scan.id, 'worker.')
    expect(workerEvents.length).toBeGreaterThan(0)
    for (const type of workerEvents) expect(type).toMatch(/^worker\./)
    for (const type of await eventTypes(api, scan.id, 'scan.')) expect(type).toMatch(/^scan\./)
  })

  test(
    'workers, in-flight analyses and worker logs of a running scan',
    { tag: ['@SCAN-019', '@SCAN-020', '@SCAN-021', '@SCAN-022'] },
    async ({ api, user, shared, scans }) => {
      const { revision } = await shared.get('sleep')
      const scan = await scans.start({ revision: revision.ref, name: 'observed', taskConfig: { seconds: 12 }, scanConfig: { times: 1 } })
      const parked = await scans.start({ revision: revision.ref, settings: UNPLACEABLE_SETTINGS })
      const ops = scanOps(api)

      // In flight: the analysis reports its progress through the runtime's state polls.
      const inflight = await waitFor(
        'an in-flight analysis with progress',
        async () => ok(await ops.inflight(scan.id), 'listInflightAnalyses'),
        (list) => list.items.some((item) => (item.progress as { message?: string } | null)?.message !== undefined),
        { timeoutMs: 90_000 },
      )
      expect(inflight.updatedAt).not.toBeNull()
      expect(inflight.items).toHaveLength(1)
      expect(inflight.items[0]).toMatchObject({ analysisId: `${scan.id}-0`, seq: 0, round: 1, attempt: 1, startedAt: expect.any(String) })
      expect(Object.keys(inflight.items[0]!).sort()).toEqual(['analysisId', 'attempt', 'nodeId', 'progress', 'round', 'seq', 'startedAt', 'workerId'])
      const cli = await scantor(['scans', 'inflight', scan.id], { token: user.apiKey })
      expect(cli.exitCode, cli.stderr).toBe(0)
      expect(cli.stdout).toMatch(/\b\d{1,3}% \d+(\.\d+)? of 12 s\b/)

      // Workers: the runner that executes the analysis.
      const workers = ok(await api.listScanWorkers(scan.id), 'listScanWorkers').items
      const runner = workers.find((worker) => worker.id === inflight.items[0]!.workerId) as Worker
      expect(runner).toMatchObject({
        role: 'runner',
        state: 'running',
        scanId: scan.id,
        node: { id: inflight.items[0]!.nodeId, name: expect.any(String) },
        scan: { id: scan.id, name: 'observed' },
        processes: { desired: 1, assigned: 1, applied: 1 },
      })
      expect(runner.processes).toHaveProperty('running')
      expect(runner.container).toMatchObject({ id: expect.any(String), restarts: expect.any(Number) })
      expect(runner.container).toHaveProperty('lastExit')
      expect(runner.runtime).toMatchObject({ bootstrappedAt: expect.any(String) })
      for (const worker of workers) {
        expect(['scheduler', 'runner']).toContain(worker.role)
        expect(worker.spec).not.toHaveProperty('specHash')
      }
      const running = ok(await api.listScanWorkers(scan.id, { state: 'running' }), 'listScanWorkers').items
      expect(running.map((worker) => worker.id)).toContain(runner.id)
      for (const worker of running) expect(worker.state).toBe('running')
      expect(await eventTypes(api, scan.id, 'worker.placed')).not.toHaveLength(0)

      // Logs: a fresh tail from the node, bounded parameters, and only workers of this scan.
      const logs = ok(await ops.workerLogs(scan.id, runner.id, { wait: 30, tailBytes: 4096 }), 'getWorkerLogs')
      expect(Object.keys(logs).sort()).toEqual(['collectedAt', 'pending', 'requestedAt', 'text', 'truncated'])
      expect(logs).toMatchObject({ pending: false, collectedAt: expect.any(String), requestedAt: expect.any(String) })
      expect(logs.text.length).toBeGreaterThan(0)
      expect(Buffer.byteLength(logs.text)).toBeLessThanOrEqual(4096)
      for (const query of [{ tailBytes: 1023 }, { tailBytes: 262_145 }, { wait: 31 }]) {
        apiErrorOf(await ops.workerLogs(scan.id, runner.id, query), 400, 'validationFailed')
      }
      const parkedWorkers = await waitFor(
        'a pending worker of the parked scan',
        async () => ok(await api.listScanWorkers(parked.id), 'listScanWorkers').items,
        (items) => items.length > 0,
        { timeoutMs: 60_000 },
      )
      apiErrorOf(await ops.workerLogs(scan.id, parkedWorkers[0]!.id), 404, 'notFound')

      // After completion nothing is in flight (the list follows the state polls and the node's report of the stopped
      // runner, so the last report can stay visible for one stale window of 20 s), and the stopped runner keeps its
      // last collected tail.
      await scans.wait(scan.id, { timeoutMs: 90_000 })
      await waitFor(
        'no analysis in flight after completion',
        async () => ok(await ops.inflight(scan.id), 'listInflightAnalyses').items,
        (items) => items.length === 0,
        {
          timeoutMs: 30_000,
        },
      )
      await waitFor(
        'the runner stopped',
        async () => ok(await api.listScanWorkers(scan.id), 'listScanWorkers').items.find((worker) => worker.id === runner.id),
        (worker) => worker?.state === 'stopped',
        { timeoutMs: 60_000 },
      )
      const last = ok(await ops.workerLogs(scan.id, runner.id, { wait: 5 }), 'getWorkerLogs')
      expect(last.pending).toBe(false)
      expect(last.text.length).toBeGreaterThan(0)
      expect(last.collectedAt).not.toBeNull()
    },
  )

  test('live hint counters only rise until the recount', { tag: ['@SCAN-042'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.get('sleep')
    const total = 6
    const scan = await scans.start({ revision: revision.ref, taskConfig: { seconds: 1 }, scanConfig: { times: total } })

    const samples: { succeeded: number; ratePerMin: number; recountedAt: string | null; state: string }[] = []
    await waitFor(
      'the scan completed',
      async () => {
        const current = await getScan(api, scan.id)
        samples.push({ succeeded: current.stats.succeeded, ratePerMin: current.stats.ratePerMin, recountedAt: current.stats.recountedAt, state: current.state })
        return current
      },
      (current) => current.state === 'completed',
      { timeoutMs: 120_000, intervalMs: 300 },
    )

    // Between two recounts the hint never decreases.
    for (let index = 1; index < samples.length; index++) {
      const [previous, next] = [samples[index - 1]!, samples[index]!]
      if (previous.recountedAt === next.recountedAt) expect(next.succeeded, JSON.stringify(samples)).toBeGreaterThanOrEqual(previous.succeeded)
    }
    const whileRunning = samples.filter((sample) => sample.state === 'running')
    expect(new Set(whileRunning.map((sample) => sample.succeeded)).size, JSON.stringify(samples)).toBeGreaterThan(2)
    expect(
      whileRunning.some((sample) => sample.succeeded > 0 && sample.ratePerMin > 0),
      JSON.stringify(samples),
    ).toBe(true)
    expect(samples.at(-1)!.succeeded).toBe(total)
    expect(await scans.counts(scan.id)).toEqual({ succeeded: total })
  })
})

test.describe('transitions', () => {
  test('repeating the current state returns 200, forbidden transitions 409 with the allowed states', { tag: ['@SCAN-024'] }, async ({ api, shared, scans }) => {
    const [sleep, lifecycle] = await Promise.all([shared.get('sleep'), shared.get('lifecycle')])
    const ops = scanOps(api)
    const conflict = async (response: Promise<ApiResponse>, state: string, allowed: string[]) => {
      expect(apiErrorOf(await response, 409, 'invalidState').details).toMatchObject({ state, allowed })
    }

    // A completed scan, and a failed one (its schedule raises Fatal before the first analysis).
    const completed = await scans.start({ revision: sleep.revision.ref, taskConfig: { seconds: 0 } })
    const failed = await scans.start({ revision: lifecycle.revision.ref, scanConfig: { count: 0, fail: 'fatal' } })

    // creating or running: delete is refused; resuming a running scan is unchanged.
    const active = await scans.start({ revision: sleep.revision.ref, settings: UNPLACEABLE_SETTINGS })
    const early = apiErrorOf(await api.deleteScan(active.id), 409, 'invalidState').details
    expect(['creating', 'running']).toContain(early?.state)
    expect(early).toMatchObject({ allowed: ['completed', 'failed', 'cancelled'] })
    // The resume writes no event: the stream checked below holds only the three real transitions.
    const running = await waitRunning(api, active.id)
    const resumedRunning = ok(await ops.resume(active.id), 'resumeScan')
    expect(resumedRunning).toMatchObject({ state: 'running', stateReason: running.stateReason })
    await conflict(api.deleteScan(active.id), 'running', ['completed', 'failed', 'cancelled'])

    // running → paused; pausing again is unchanged.
    const paused = ok(await ops.pause(active.id), 'pauseScan')
    expect(paused).toMatchObject({ state: 'paused', stateReason: { code: 'user' }, pausedAt: expect.any(String) })
    const pausedAgain = ok(await ops.pause(active.id), 'pauseScan')
    expect(pausedAgain).toMatchObject({ state: 'paused', pausedAt: paused.pausedAt, stateReason: paused.stateReason })
    await conflict(api.deleteScan(active.id), 'paused', ['completed', 'failed', 'cancelled'])

    // paused → cancelled; cancelling again is unchanged.
    const cancelled = ok(await api.cancelScan(active.id), 'cancelScan')
    expect(cancelled).toMatchObject({ state: 'cancelled', completedAt: expect.any(String) })
    const cancelledAgain = ok(await api.cancelScan(active.id), 'cancelScan')
    expect(cancelledAgain).toMatchObject({ state: 'cancelled', completedAt: cancelled.completedAt, stateReason: cancelled.stateReason })
    // Only the real transitions wrote events: creating → running → paused → cancelled.
    expect(ok(await ops.events(active.id, { type: 'scan.stateChanged' }), 'listScanEvents').items.map((event) => event.data)).toEqual([
      expect.objectContaining({ from: 'paused', to: 'cancelled' }),
      expect.objectContaining({ from: 'running', to: 'paused' }),
      expect.objectContaining({ from: 'creating', to: 'running' }),
    ])

    // Terminal scans (deleting and deleted ones: the next test).
    await scans.wait(completed.id, { timeoutMs: 120_000 })
    expect(await scans.wait(failed.id, { state: 'failed', timeoutMs: 120_000 })).toMatchObject({ stateReason: { code: 'schedulingFailed' } })
    await conflict(ops.pause(completed.id), 'completed', ['running'])
    await conflict(ops.resume(completed.id), 'completed', ['paused'])
    await conflict(ops.scale(completed.id, { workers: 2 }), 'completed', ['creating', 'running', 'paused'])
    await conflict(api.cancelScan(completed.id), 'completed', ['creating', 'running', 'paused'])
    await conflict(api.cancelScan(failed.id), 'failed', ['creating', 'running', 'paused'])
    await conflict(ops.pause(failed.id), 'failed', ['running'])
    await conflict(ops.scale(cancelled.id, { processes: 2 }), 'cancelled', ['creating', 'running', 'paused'])
    await conflict(ops.resume(cancelled.id), 'cancelled', ['paused'])
  })

  // The state `deleted` (the tombstone) is reached when the scanDelete job finishes; that job queue is shared by the
  // whole stack, so the transitions of a deleted scan are asserted in e2e/lifecycle.spec.ts, which waits for it anyway.
  test(
    'delete accepts a terminal scan and is repeatable while deleting; a deleting scan refuses every other transition',
    { tag: ['@SCAN-036', '@SCAN-024', '@SCAN-026', '@SCAN-034'] },
    async ({ api, shared, scans }) => {
      const { revision } = await shared.get('sleep')
      const scan = await scans.start({ revision: revision.ref, taskConfig: { seconds: 0 } })
      await scans.wait(scan.id, { timeoutMs: 120_000 })
      const ops = scanOps(api)

      const accepted = await api.deleteScan(scan.id)
      expect(accepted.status).toBe(202)
      expect(accepted.body.scan.state).toBe('deleting')
      expect(accepted.body.job).toMatchObject({ id: expect.any(String), kind: 'scanDelete' })
      const repeated = await api.deleteScan(scan.id)
      expect(repeated.status).toBe(202)
      expect(repeated.body.scan.state).toBe('deleting')
      expect(repeated.body.job.id).toBe(accepted.body.job.id)

      // While deleting: no cancel, pause, resume, scale, restart or retry. The job may already have finished when a
      // request arrives, so `deleted` is accepted as well.
      for (const response of [
        await api.cancelScan(scan.id),
        await ops.pause(scan.id),
        await ops.resume(scan.id),
        await ops.scale(scan.id, { workers: 2 }),
        await ops.restart(scan.id),
        await ops.retryFailed(scan.id),
      ]) {
        const details = apiErrorOf(response, 409, 'invalidState').details
        expect(['deleting', 'deleted']).toContain(details?.state)
      }
      expect(['deleting', 'deleted']).toContain((await getScan(api, scan.id)).state)
    },
  )

  test('resume, restart and retry-failed need the scan revision', { tag: ['@SCAN-026'] }, async ({ api, docker, tasks, scans }) => {
    const ops = scanOps(api)
    // A revision of its own, removed out of band below: a paused scan holds its task, so the task cannot be deleted.
    const dir = await lifecycleTask()
    let own: Awaited<ReturnType<typeof tasks.upload>>
    try {
      own = await tasks.upload(dir)
    } finally {
      await removeDir(dir)
    }
    const completed = await scans.start({ revision: own.revision.ref })
    const paused = await scans.start({ revision: own.revision.ref, settings: UNPLACEABLE_SETTINGS })
    await waitRunning(api, paused.id)
    ok(await ops.pause(paused.id), 'pauseScan')
    await scans.wait(completed.id, { timeoutMs: 120_000 })

    await docker.mongosh(`printjson(db.revisions.deleteOne({ _id: ${JSON.stringify(own.revision.id)} }))`, { as: 'root' })
    apiErrorOf(await ops.restart(completed.id), 409, 'revisionUnavailable')
    apiErrorOf(await ops.retryFailed(completed.id), 409, 'revisionUnavailable')
    apiErrorOf(await ops.resume(paused.id), 409, 'revisionUnavailable')
    expect((await getScan(api, paused.id)).state).toBe('paused')
  })

  test('scaleScan updates the settings, writes scan.scaled and ignores unchanged values', { tag: ['@SCAN-027'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.get('sleep')
    const scan = await scans.start({ revision: revision.ref, settings: UNPLACEABLE_SETTINGS })
    const ops = scanOps(api)

    // creating (or already running), then paused.
    const scaled = ok(await ops.scale(scan.id, { workers: 2 }), 'scaleScan')
    expect(scaled.settings).toMatchObject({ workers: 2, processes: 1 })
    const unchanged = ok(await ops.scale(scan.id, { workers: 2, processes: 1 }), 'scaleScan')
    expect(unchanged.settings).toEqual(scaled.settings)
    apiErrorOf(await ops.scale(scan.id, {}), 400, 'validationFailed')

    await waitRunning(api, scan.id)
    ok(await ops.pause(scan.id), 'pauseScan')
    const whilePaused = ok(await ops.scale(scan.id, { processes: 2 }), 'scaleScan')
    expect(whilePaused).toMatchObject({ state: 'paused', settings: { workers: 2, processes: 2 } })

    // Two real changes, two events (newest first); the unchanged request wrote none.
    const events = ok(await ops.events(scan.id, { type: 'scan.scaled' }), 'listScanEvents').items
    expect(events.map((event) => event.data)).toEqual([
      expect.objectContaining({ workers: 2, processes: 2 }),
      expect.objectContaining({ workers: 2, processes: 1 }),
    ])
  })

  test('retry-failed needs finished scheduling, no active retry and something to retry', { tag: ['@SCAN-034'] }, async ({ api, shared, scans }) => {
    const [sleep, lifecycle] = await Promise.all([shared.get('sleep'), shared.get('lifecycle')])
    const ops = scanOps(api)
    const succeeded = await scans.start({ revision: sleep.revision.ref, taskConfig: { seconds: 0 } })
    const failing = await scans.start({ revision: lifecycle.revision.ref, taskConfig: { mode: 'fatal' }, scanConfig: { count: 2 } })

    // Scheduling still pending (creating or running), then paused.
    const parked = await scans.start({ revision: sleep.revision.ref, settings: UNPLACEABLE_SETTINGS })
    const early = apiErrorOf(await ops.retryFailed(parked.id), 409, 'invalidState')
    expect(['creating', 'running']).toContain(early.details?.state)
    await waitRunning(api, parked.id)
    expect(apiErrorOf(await ops.retryFailed(parked.id), 409, 'invalidState').details).toMatchObject({ state: 'running', schedulingState: 'pending' })
    ok(await ops.pause(parked.id), 'pauseScan')
    expect(apiErrorOf(await ops.retryFailed(parked.id), 409, 'invalidState').details).toMatchObject({ state: 'paused' })

    // Only succeeded analyses: nothing to retry.
    await scans.wait(succeeded.id, { timeoutMs: 120_000 })
    apiErrorOf(await ops.retryFailed(succeeded.id), 409, 'nothingToRetry')

    // Failed analyses: the first retry is accepted, a second one while it runs is refused.
    await scans.wait(failing.id, { timeoutMs: 120_000 })
    expect(await scans.counts(failing.id)).toEqual({ failed: 2 })
    const retry = await ops.retryFailed(failing.id)
    expect(retry.status).toBe(202)
    expect(apiErrorOf(await ops.retryFailed(failing.id), 409, 'invalidState').details).toMatchObject({ state: 'running', schedulingState: 'retrying' })
  })
})
