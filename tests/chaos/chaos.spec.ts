import { randomUUID } from 'node:crypto'
import type { Job } from '#shared/types/jobs'
import type { NodeWithToken } from '#shared/types/nodes'
import type { Revision } from '#shared/types/revisions'
import type { Scan } from '#shared/types/scans'
import type { Worker } from '#shared/types/workers'
import { ApiClient, ok } from '../helpers/api-client'
import { connectAsScan, EXCHANGES, publish } from '../helpers/amqp'
import {
  analysesOf,
  apiKeyContext,
  broker,
  builtinNode,
  directApiContext,
  directGet,
  expectOnePerSeq,
  getNode,
  getScan,
  holdFor,
  INGEST_QUEUE,
  inflightOf,
  isActiveWorker,
  memoryWatermark,
  metricValue,
  nodeEvents,
  platformContainers,
  publicHealth,
  readRemoteNode,
  rejoinRemoteDaemon,
  remoteContainerState,
  remoteDaemonLogs,
  remoteScanContainers,
  removeDir,
  RESULT_FIELDS,
  resultMessage,
  runningWorker,
  scanEvents,
  scanQueueName,
  scanUserName,
  scanWorkers,
  startOrchestrator,
  statusCounts,
  stopOrchestrator,
  storedSessionTokens,
  updateNode,
  waitFor,
  waitForHealthyPlatform,
  waitForNodeState,
  waitForOrchestrator,
  waitForScan,
  waitForScanStartsAccepted,
  waitForScanState,
  withMemoryAlarm,
  workerContainerName,
  workerRequest,
  writeChaosTask,
  type ChaosScanConfig,
  type ChaosTaskConfig,
  type DirectResponse,
} from '../helpers/chaos'
import { CONTAINERS, docker as runDocker, REMOTE_NODE_NETWORK, stackEnv } from '../helpers/docker'
import { env } from '../helpers/env'
import { stackKeys } from '../helpers/keys'
import { cancelAndDeleteScan, scanCounts, SMALL_SETTINGS, startScan, waitForScanState as waitForScanStateLongPoll } from '../helpers/scans'
import { fixtureTaskDir, packTask, uploadAndPublish, waitForRevision } from '../helpers/tasks'
import { expect, test as base, unique, type ScansFixture } from '../fixtures'

// Chaos cases (docs/testing.md §8.7) plus the features that need the shared platform objects: faults injected into
// one scan, into the remote node remote-1 and into the platform's components. The file runs serially after every
// other project (re-runs: --project=chaos --no-deps). Every case asserts final states and exact counts
// (aggregateAnalyses), never timing; it starts only on a healthy platform (beforeEach) and undoes its fault in a
// `finally` block, so the next case starts healthy too.
//
// The chaos probe (helpers/chaos.ts) and the `nondeterministic` fixture task are built once per worker. Scans that do
// not need remote-1 select the built-in node's pool, so their worker containers run in the runner's own dockerd.
// Every request uses one worker-scoped client with the tenant's API key (`keyApi`, also usable in beforeAll and
// afterAll hooks); the test-scoped `api` is that client.
//
// Cleanup never waits for a scanDelete job (concurrency 2 with a settle delay, so a busy stack queues them for
// minutes): scans are cancelled and deleted at test teardown, the tasks once their scans are gone, and whatever is
// still held then goes with the tenant, which the `user` fixture deletes at worker teardown.

interface Probe {
  revision: Revision
  /** the `nondeterministic` fixture task (SCHED-004) */
  nondeterministic: Revision
  /** pool of the built-in node: a nodeSelector that keeps a scan on the built-in node */
  builtinPool: string
}

/** Deletes a task; a task whose deleted scans still hold it (409 taskInUse) is left to the tenant's purge. */
async function deleteTaskSoon(api: ApiClient, name: string): Promise<void> {
  const status = await waitFor(
    `task ${name} deleted`,
    async () => (await api.deleteTask(name)).status,
    (code) => code === 202 || code === 404 || code === 409,
    { timeoutMs: 30_000, intervalMs: 2000 },
  )
  if (status === 409) return
  expect([202, 404]).toContain(status)
}

const test = base.extend<{ api: ApiClient; scans: ScansFixture }, { keyApi: ApiClient; probe: Probe }>({
  keyApi: [
    async ({ user, openapi }, use) => {
      const context = await apiKeyContext(user.apiKey)
      try {
        await use(new ApiClient(context, openapi))
      } finally {
        await context.dispose()
      }
    },
    { scope: 'worker' },
  ],
  probe: [
    async ({ keyApi, adminApi }, use) => {
      const dir = await writeChaosTask()
      const names = [unique('chaos-probe'), unique('nondeterministic')] as const
      try {
        const [probe, nondeterministic] = await Promise.all([
          uploadAndPublish(keyApi, dir, names[0], { timeoutMs: 360_000 }),
          uploadAndPublish(keyApi, fixtureTaskDir('nondeterministic'), names[1], { timeoutMs: 360_000 }),
        ])
        await use({ revision: probe.revision, nondeterministic: nondeterministic.revision, builtinPool: (await builtinNode(adminApi)).pool })
      } finally {
        await removeDir(dir)
        for (const name of names) await deleteTaskSoon(keyApi, name)
      }
    },
    // Builds share SCANTOR_BUILD_CONCURRENCY with every other build of the stack.
    { scope: 'worker', timeout: 420_000 },
  ],
  api: async ({ keyApi }, use) => use(keyApi),
  // The suite's `scans` fixture, except that teardown does not wait for the scanDelete jobs (see above).
  scans: async ({ api }, use) => {
    const started: string[] = []
    await use({
      start: async (body) => {
        const scan = await startScan(api, body)
        started.push(scan.id)
        return scan
      },
      wait: (scanId, options = {}) => waitForScanStateLongPoll(api, scanId, options.state ?? 'completed', options.timeoutMs),
      counts: (scanId) => scanCounts(api, scanId),
      track: (scanId) => void started.push(scanId),
    })
    for (const scanId of started.reverse()) await cancelAndDeleteScan(api, scanId)
  },
})

const REMOTE_SELECTOR = { pool: 'remote', labels: { zone: 'remote' } }

const onBuiltin = (probe: Probe, extra: Record<string, unknown> = {}) => ({ ...SMALL_SETTINGS, nodeSelector: { pool: probe.builtinPool }, ...extra })
const onRemote = (extra: Record<string, unknown> = {}) => ({ ...SMALL_SETTINGS, nodeSelector: REMOTE_SELECTOR, ...extra })
/** A fixed retry delay (no jitter), so a test knows when delayed retries become due. */
const fixedBackoff = (ms: number) => ({ initialMs: ms, factor: 1, maxMs: ms, jitter: false })

function probeScan(probe: Probe, taskConfig: ChaosTaskConfig, scanConfig: ChaosScanConfig, settings: Record<string, unknown>) {
  return { revision: probe.revision.ref, taskConfig: { ...taskConfig }, scanConfig: { ...scanConfig }, settings }
}

/** A task config the chaos probe rejects (422 configInvalid): the side-effect-free startScan probe. */
const INVALID_TASK_CONFIG = { seconds: -1 }

test.beforeEach(async ({ adminApi, api, probe }) => {
  await waitForHealthyPlatform(adminApi)
  await waitForScanStartsAccepted(api, probe.revision.ref, INVALID_TASK_CONFIG)
})

test.describe('faults of one scan', () => {
  test(
    'killing a runner while analyses are in flight still completes the scan with one document per seq',
    { tag: ['@CHAOS-001'] },
    async ({ api, scans, probe, docker }) => {
      test.setTimeout(300_000)
      const total = 6
      const scan = await scans.start(probeScan(probe, { seconds: 8 }, { count: total }, onBuiltin(probe, { workers: 2 })))

      // Both runners hold an analysis; one of them is killed with its delivery unacknowledged.
      const inflight = await waitFor(
        'both runners busy',
        () => inflightOf(api, scan.id),
        (items) => new Set(items.map((i) => i.workerId)).size === 2,
        {
          timeoutMs: 180_000,
          intervalMs: 500,
        },
      )
      const victim = inflight[0]!.workerId
      await docker.kill(workerContainerName(victim), 'KILL')
      const killed = await waitFor(
        'the killed runner reported',
        async () => (await scanWorkers(api, scan.id)).find((w) => w.id === victim),
        (worker) => worker?.container?.lastExit?.exitCode === 137,
        { timeoutMs: 60_000 },
      )
      expect(killed!.container!.lastExit).toMatchObject({ exitCode: 137, oomKilled: false })

      const done = await waitForScanState(api, scan.id, 'completed', 180_000)
      expect(done.scheduling).toMatchObject({ state: 'done', confirmed: total })
      expect(await scans.counts(scan.id)).toEqual({ succeeded: total })
      expectOnePerSeq(await analysesOf(api, scan.id), total)
    },
  )

  test('re-published and conflicting result messages are absorbed by the guarded upserts', { tag: ['@ING-010'] }, async ({ api, adminApi, scans, probe }) => {
    test.setTimeout(300_000)
    const total = 4
    // seq 0 succeeds and seq 1 fails fatally at once; seqs 2 and 3 keep the scan (and its RabbitMQ user) alive.
    const scan = await scans.start(probeScan(probe, { seconds: 12, fast_seqs: 2, fatal_seqs: [1] }, { count: total }, onBuiltin(probe)))
    const rows = await waitFor(
      'seq 0 succeeded and seq 1 failed',
      () => analysesOf(api, scan.id, RESULT_FIELDS),
      (all) => all.find((r) => r.seq === 0)?.status === 'succeeded' && all.find((r) => r.seq === 1)?.status === 'failed',
      { timeoutMs: 180_000, intervalMs: 500 },
    )
    const succeeded = rows.find((r) => r.seq === 0)!
    const failed = rows.find((r) => r.seq === 1)!
    expect(failed.error).toMatchObject({ type: 'fatal', retryable: false })
    const duplicates = () => metricValue(adminApi, 'scantor_ingest_messages_total', { kind: 'result', outcome: 'duplicate' })
    const duplicatesBefore = await duplicates()

    const session = await connectAsScan(scan.id)
    try {
      const properties = () => ({ type: 'result', messageId: randomUUID() })
      // 1. The captured result of seq 0 again: a duplicate.
      await publish(session, EXCHANGES.results, scan.id, resultMessage(scan.id, succeeded), properties())
      // 2. A failure in the same round for the succeeded seq 0: the first terminal result wins.
      const lateAttempt = succeeded.attempt + 1
      await publish(
        session,
        EXCHANGES.results,
        scan.id,
        resultMessage(scan.id, succeeded, {
          attempt: lateAttempt,
          executionId: randomUUID(),
          status: 'failed',
          result: null,
          error: { type: 'taskError', message: 'chaos: a late failure', retryable: false, phase: 'run', attempt: lateAttempt, at: Date.now() },
        }),
        properties(),
      )
      // 3. A success in the same round for the failed seq 1: a later success beats a failure.
      await publish(
        session,
        EXCHANGES.results,
        scan.id,
        resultMessage(scan.id, failed, { executionId: randomUUID(), status: 'succeeded', result: { index: 1, attempt: failed.attempt } }),
        properties(),
      )
    } finally {
      await session.close()
    }

    const replaced = await waitFor(
      'seq 1 replaced by the later success',
      async () => (await analysesOf(api, scan.id, RESULT_FIELDS)).find((r) => r.seq === 1)!,
      (row) => row.status === 'succeeded',
      { timeoutMs: 60_000, intervalMs: 500 },
    )
    expect(replaced.result).toEqual({ index: 1, attempt: failed.attempt })
    expect(replaced.error).toBeUndefined()

    // The results of seqs 2 and 3 are published after the forged ones, so completion means all of them were ingested.
    await waitForScanState(api, scan.id, 'completed', 180_000)
    expect(await scans.counts(scan.id)).toEqual({ succeeded: total })
    expect((await analysesOf(api, scan.id, RESULT_FIELDS)).find((r) => r.seq === 0)).toEqual(succeeded)
    expect(await duplicates()).toBeGreaterThanOrEqual(duplicatesBefore + 2)
  })

  test(
    'an analysis that kills every worker processing it is recorded as a crash at the delivery limit',
    { tag: ['@ING-012'] },
    async ({ api, scans, probe }) => {
      test.setTimeout(480_000)
      const total = 4
      // Four runners with one process each: every delivery of seq 0 kills one runner container (crash backoff 5 s,
      // 10 s, …), so the delivery limit is reached within a few backoff rounds.
      const scan = await scans.start(
        probeScan(probe, { seconds: 1, poison_seqs: [0] }, { count: total }, onBuiltin(probe, { workers: 4, resources: { cpus: 0.25, memoryMiB: 192 } })),
      )
      await waitForScanState(api, scan.id, 'completed', 420_000)
      expect(await scans.counts(scan.id)).toEqual({ succeeded: total - 1, failed: 1 })

      const deliveryLimit = Number(stackEnv().SCANTOR_DELIVERY_LIMIT)
      const poisoned = (await analysesOf(api, scan.id, ['error', 'config'])).find((r) => r.seq === 0)!
      expect(poisoned).toMatchObject({
        status: 'failed',
        config: { index: 0 },
        error: { type: 'crash', retryable: false, phase: 'run', details: { deathReason: 'delivery_limit', deathQueue: scanQueueName(scan.id) } },
      })
      expect(poisoned.error!.message).toMatch(
        new RegExp(`^every worker that received this analysis died while processing it \\(delivered \\d+ times, delivery limit ${deliveryLimit}\\)$`),
      )
      expect(Number(poisoned.error!.details!.deliveryCount)).toBeGreaterThanOrEqual(deliveryLimit)
    },
  )

  test('a non-deterministic custom schedule fails on resume after its scheduler is killed', { tag: ['@SCHED-004'] }, async ({ api, scans, probe, docker }) => {
    test.setTimeout(300_000)
    const scan = await scans.start({ revision: probe.nondeterministic.ref, scanConfig: { count: 150, delay_seconds: 0.2 }, settings: onBuiltin(probe) })
    await waitForScan(api, scan.id, 'a scheduler checkpoint', (s) => s.scheduling.confirmed > 0, 180_000)
    const scheduler = await runningWorker(api, scan.id, 'scheduler')
    await docker.kill(workerContainerName(scheduler.id), 'KILL')

    const failed = await waitForScanState(api, scan.id, 'failed', 240_000)
    expect(failed.stateReason).toMatchObject({ code: 'schedulingFailed' })
    expect(failed.scheduling.state).toBe('failed')
    expect(failed.scheduling.error).toMatchObject({ type: 'validation', retryable: false, phase: 'schedule' })
    expect(failed.scheduling.error!.message).toMatch(/^schedule\(\) is not deterministic: /)
  })

  test('pausing while retries are delayed, waiting 30 s and resuming loses no analysis', { tag: ['@CHAOS-004'] }, async ({ api, scans, probe }) => {
    test.setTimeout(300_000)
    const total = 3
    const scan = await scans.start(
      probeScan(probe, { fail_attempts: 1 }, { count: total }, onBuiltin(probe, { maxAttempts: 3, backoff: fixedBackoff(20_000) })),
    )
    await waitFor(
      'every analysis retrying',
      () => statusCounts(api, scan.id),
      (counts) => counts.retrying === total,
      { timeoutMs: 180_000, intervalMs: 500 },
    )

    expect(ok(await api.call<Scan>('pauseScan', { path: { scanId: scan.id } }), 'pauseScan').state).toBe('paused')
    const pausedAt = Date.now()
    await waitFor(
      'the workers drained',
      () => scanWorkers(api, scan.id),
      (workers) => workers.length > 0 && !workers.some(isActiveWorker),
      { timeoutMs: 120_000 },
    )
    // The delayed retries become due while the scan is paused.
    await holdFor(pausedAt + 30_000 - Date.now())
    expect((await getScan(api, scan.id)).state).toBe('paused')
    expect(await scans.counts(scan.id)).toEqual({ retrying: total })

    ok(await api.call<Scan>('resumeScan', { path: { scanId: scan.id } }), 'resumeScan')
    const done = await waitForScanState(api, scan.id, 'completed', 180_000)
    expect(done.stats).toMatchObject({ succeeded: total, lost: 0, failed: 0 })
    expect(await scans.counts(scan.id)).toEqual({ succeeded: total })
    for (const row of await analysesOf(api, scan.id)) expect(row, `seq ${row.seq}`).toMatchObject({ status: 'succeeded', attempt: 2 })
  })

  test(
    'analyses whose queued messages vanished become lost, and retry-failed then completes the scan',
    { tag: ['@CHAOS-007'] },
    async ({ api, scans, probe }) => {
      test.setTimeout(480_000)
      const total = 3
      // Every first attempt fails before failBefore and waits for a ten-minute retry delay, so the delayed retries are
      // still in the queue when it is deleted; the retry of round 2, started after failBefore, succeeds.
      const failBefore = Date.now() + 90_000
      const retrying = await scans.start(
        probeScan(probe, { fail_before: failBefore / 1000 }, { count: total }, onBuiltin(probe, { maxAttempts: 5, backoff: fixedBackoff(600_000) })),
      )
      // A second scan whose seq 1 is still in its queue (never delivered) while seq 0 occupies the only process slot.
      const gapped = await scans.start(probeScan(probe, { seconds: 15 }, { count: 2 }, onBuiltin(probe)))

      await waitFor(
        'every analysis retrying',
        () => statusCounts(api, retrying.id),
        (counts) => counts.retrying === total,
        { timeoutMs: 180_000, intervalMs: 500 },
      )
      await waitForScan(api, retrying.id, 'scheduling done', (s) => s.scheduling.state === 'done', 60_000)
      await waitForScan(api, gapped.id, 'scheduling done', (s) => s.scheduling.state === 'done', 120_000)
      await waitFor(
        'seq 0 in flight',
        () => inflightOf(api, gapped.id),
        (items) => items.some((i) => i.seq === 0),
        { timeoutMs: 120_000, intervalMs: 500 },
      )

      // An operator deletes both queues with their delayed and ready messages; the reconciler recreates them empty.
      await broker.deleteQueue(scanQueueName(retrying.id))
      await broker.deleteQueue(scanQueueName(gapped.id))
      for (const scanId of [retrying.id, gapped.id]) {
        await waitFor(
          `the queue of ${scanId} recreated empty`,
          () => broker.queue(scanQueueName(scanId)),
          (queue) => queue !== null && queue.messages === 0,
          {
            timeoutMs: 60_000,
          },
        )
      }

      // After SCANTOR_SCAN_STALL_AFTER the waiting analyses are lost with their config, and the scan ends.
      const stalled = await waitForScanState(api, retrying.id, 'completed', 180_000)
      expect(await scans.counts(retrying.id)).toEqual({ lost: total })
      for (const row of await analysesOf(api, retrying.id, ['config', 'error'])) {
        expect(row, `seq ${row.seq}`).toMatchObject({
          status: 'lost',
          config: { index: row.seq },
          error: { type: 'platform', retryable: false, message: 'lost: no message for this analysis remained in the queue and no worker was processing it' },
        })
      }
      expect(stalled.conditions.find((c) => c.type === 'stalled')?.details).toMatchObject({ lost: total })
      expect((await scanEvents(api, retrying.id, 'scan.lostAnalyses')).map((e) => e.data)).toContainEqual(expect.objectContaining({ count: total }))

      // The never-delivered seq of the second scan is recorded as lost without a config.
      await waitForScanState(api, gapped.id, 'completed', 180_000)
      expect(await scans.counts(gapped.id)).toEqual({ succeeded: 1, lost: 1 })
      const gap = (await analysesOf(api, gapped.id, ['config', 'error'])).find((r) => r.seq === 1)!
      expect(gap).toMatchObject({ status: 'lost', attempt: 0, error: { type: 'platform', retryable: false } })
      expect(gap.config).toBeUndefined()

      // retry-failed re-runs the lost analyses that kept their config (round 2) and completes the scan.
      await holdFor(failBefore + 1000 - Date.now())
      const retried = await api.call<{ scan: Scan }>('retryFailedAnalyses', { path: { scanId: retrying.id } })
      expect(retried.status, JSON.stringify(retried.body)).toBe(202)
      const done = await waitForScan(api, retrying.id, 'round 2 completed', (s) => s.round === 2 && s.state === 'completed', 240_000)
      expect(done.stats).toMatchObject({ succeeded: total, lost: 0 })
      expect(await scans.counts(retrying.id)).toEqual({ succeeded: total })
      for (const row of await analysesOf(api, retrying.id)) expect(row, `seq ${row.seq}`).toMatchObject({ status: 'succeeded', round: 2 })
    },
  )
})

test.describe('the remote node remote-1', () => {
  test(
    'cancelling a scan on remote-1 closes its worker connections, removes the broker objects and keeps the counts stable',
    { tag: ['@SCAN-030', '@RT-008', '@SCAN-041'] },
    async ({ api, scans, probe, docker }) => {
      test.setTimeout(540_000)
      const remote = readRemoteNode()
      const total = 6
      // seqs 0 and 1 succeed at once, then two long analyses occupy both process slots of the runner on remote-1.
      const scan = await scans.start(probeScan(probe, { seconds: 90, fast_seqs: 2 }, { count: total }, onRemote({ processes: 2 })))
      await waitFor(
        'two analyses succeeded and two in flight',
        async () => ({ counts: await statusCounts(api, scan.id), inflight: await inflightOf(api, scan.id) }),
        (state) => state.counts.succeeded === 2 && state.inflight.length === 2,
        { timeoutMs: 300_000, intervalMs: 500 },
      )
      const active = (await scanWorkers(api, scan.id)).filter(isActiveWorker)
      expect(active.length).toBeGreaterThan(0)
      for (const worker of active) expect(worker.nodeId, `${worker.role} ${worker.id}`).toBe(remote.id)
      expect(await broker.connectionsOf(scanUserName(scan.id))).toBeGreaterThan(0)

      // `docker wait` in remote-1's dockerd reports how each runtime exits.
      const running = (await docker.remote(['ps', '-q', '--filter', `label=scantor.scan=${scan.id}`])).stdout.split('\n').filter(Boolean)
      expect(running.length).toBeGreaterThan(0)
      const exits = running.map((id) => docker.remote(['wait', id], { allowFailure: true, timeoutMs: 180_000 }))

      const cancelled = ok(await api.cancelScan(scan.id), 'cancelScan')
      expect(cancelled).toMatchObject({ state: 'cancelled', completedAt: expect.any(String) })

      // The user goes first (the kill switch), then the queue.
      const observations: { queue: boolean; user: boolean }[] = []
      await waitFor(
        'the RabbitMQ user and queue removed',
        async () => {
          const observed = { queue: (await broker.queue(scanQueueName(scan.id))) !== null, user: await broker.userExists(scanUserName(scan.id)) }
          observations.push(observed)
          return observed
        },
        (observed) => !observed.queue && !observed.user,
        { timeoutMs: 60_000, intervalMs: 250 },
      )
      expect(
        observations.filter((o) => !o.queue && o.user),
        JSON.stringify(observations),
      ).toEqual([])
      await waitFor(
        'every connection of the scan closed',
        () => broker.connectionsOf(scanUserName(scan.id)),
        (n) => n === 0,
        { timeoutMs: 30_000 },
      )
      for (const exit of exits) expect((await exit).stdout.trim()).toBe('0')
      await waitFor(
        'the worker containers removed from remote-1',
        () => remoteScanContainers(scan.id),
        (names) => names.length === 0,
        { timeoutMs: 120_000 },
      )

      // Quiescence: no pending or retrying document.
      const converged = await waitForScan(
        api,
        scan.id,
        'the cancel recount',
        (s) => s.stats.recountedAt !== null && Date.parse(s.stats.recountedAt) >= Date.parse(s.completedAt!),
        60_000,
      )
      expect(converged.stats).toMatchObject({ pending: 0, retrying: 0, succeeded: 2, failed: 0, cancelled: total - 2 })
      expect(converged.stats.succeeded + converged.stats.failed + converged.stats.cancelled).toBe(converged.scheduling.confirmed)
      const counts = await scans.counts(scan.id)
      expect(counts).toEqual({ succeeded: 2 })

      // SCAN-041: a transient over-count (61/60 style) is corrected by the recount 2 minutes after the terminal state.
      // The exact counts stay stable meanwhile (SCAN-030: at least 30 s, here until that recount).
      await docker.mongosh(`db.scans.updateOne({ _id: ${JSON.stringify(scan.id)} }, { $set: { 'stats.succeeded': 3, updatedAt: new Date() } })`, { as: 'root' })
      expect((await getScan(api, scan.id)).stats.succeeded).toBe(3)
      const stableFrom = Date.now()
      const recounted = await waitForScan(
        api,
        scan.id,
        'the final recount',
        (s) => s.stats.succeeded === 2 && Date.parse(s.stats.recountedAt!) >= Date.parse(s.completedAt!) + 120_000,
        240_000,
        async () => expect(await scans.counts(scan.id)).toEqual(counts),
      )
      expect(Date.now() - stableFrom).toBeGreaterThanOrEqual(30_000)
      expect(await scans.counts(scan.id)).toEqual(counts)
      expect(recounted.state).toBe('cancelled')
      expect(recounted.stats).toMatchObject({ succeeded: 2, cancelled: total - 2 })
    },
  )

  test(
    'a cordoned remote-1 keeps its running workers and gets new ones only after uncordoning',
    { tag: ['@NODE-013'] },
    async ({ api, adminApi, scans, probe }) => {
      test.setTimeout(420_000)
      const remote = readRemoteNode()
      const first = await scans.start(probeScan(probe, { seconds: 15 }, { count: 2 }, onRemote()))
      const runner = await runningWorker(api, first.id, 'runner', remote.id)
      let second: Scan | undefined
      try {
        expect(await updateNode(adminApi, remote.id, { cordoned: true })).toMatchObject({ cordoned: true })
        second = await scans.start(probeScan(probe, {}, { count: 2 }, onRemote()))
        const pending = await waitForScan(api, second.id, 'workersPending', (s) => s.conditions.some((c) => c.type === 'workersPending'), 90_000)
        expect(pending.conditions.find((c) => c.type === 'workersPending')?.details).toMatchObject({ reasons: { selectorMismatch: expect.any(Number) } })
        for (const worker of await scanWorkers(api, second.id)) expect(worker, worker.id).toMatchObject({ state: 'pending', nodeId: null })
        // The running workers stay: the first scan's runner keeps running on remote-1 and the scan completes.
        expect((await scanWorkers(api, first.id)).find((w) => w.id === runner.id)).toMatchObject({ state: 'running', nodeId: remote.id })
        await waitForScanState(api, first.id, 'completed', 180_000)
        expect(await scans.counts(first.id)).toEqual({ succeeded: 2 })
        expect((await getScan(api, second.id)).state).toBe('running')
        expect(await scans.counts(second.id)).toEqual({})
      } finally {
        await updateNode(adminApi, remote.id, { cordoned: false })
      }
      expect((await getNode(adminApi, remote.id)).cordoned).toBe(false)
      await waitForScanState(api, second.id, 'completed', 240_000)
      expect(await scans.counts(second.id)).toEqual({ succeeded: 2 })
      for (const worker of await scanWorkers(api, second.id)) expect(worker.nodeId, worker.id).toBe(remote.id)
    },
  )

  test(
    "remote-1's daemon exits 0 on SIGTERM, its workers keep running and the restarted daemon adopts them",
    { tag: ['@NODE-025'] },
    async ({ api, adminApi, scans, probe, docker }) => {
      test.setTimeout(420_000)
      const remote = readRemoteNode()
      const total = 4
      const scan = await scans.start(probeScan(probe, { seconds: 12 }, { count: total }, onRemote()))
      const runner = await runningWorker(api, scan.id, 'runner', remote.id)
      const container = workerContainerName(runner.id)
      const before = (await remoteContainerState(container))!
      const instanceBefore = (await getNode(adminApi, remote.id)).instance
      const stoppedAt = Date.now()
      try {
        await docker.remote(['stop', '-t', '30', 'scantor-node'], { timeoutMs: 60_000 })
        expect(await remoteContainerState('scantor-node')).toMatchObject({ Running: false, ExitCode: 0 })
        expect(await remoteContainerState(container)).toMatchObject({ Running: true, StartedAt: before.StartedAt })
      } finally {
        await docker.remote(['start', 'scantor-node'])
      }
      // The new daemon instance took over the lease and adopted the running container (same start time).
      await waitFor(
        'the new daemon instance online',
        () => getNode(adminApi, remote.id),
        (node) => node.state === 'online' && node.instance !== null && node.instance.startedAt !== instanceBefore?.startedAt,
        { timeoutMs: 60_000 },
      )
      expect(await remoteContainerState(container)).toMatchObject({ Running: true, StartedAt: before.StartedAt })

      await waitForScanState(api, scan.id, 'completed', 240_000)
      expect(await scans.counts(scan.id)).toEqual({ succeeded: total })
      const workers = await scanWorkers(api, scan.id)
      expect(workers.filter((w) => w.state === 'lost')).toEqual([])
      expect(workers.filter((w) => w.role === 'runner').map((w) => w.id)).toEqual([runner.id])
      expect((await nodeEvents(adminApi, remote.id)).filter((e) => e.type === 'node.offline' && Date.parse(e.at) >= stoppedAt)).toEqual([])
    },
  )

  test(
    'a partitioned remote-1 goes offline, its workers are lost and replaced on the built-in node, and its stale containers are removed after it returns',
    { tag: ['@CHAOS-006', '@SCHED-010'] },
    async ({ api, adminApi, scans, probe, docker }) => {
      test.setTimeout(600_000)
      const remote = readRemoteNode()
      const builtin = await builtinNode(adminApi)
      const remoteBefore = await getNode(adminApi, remote.id)
      // A label only this test uses: the scan matches exactly the nodes carrying it.
      const mark = { chaos: unique('partition') }
      const total = 30

      // remote-1 joins the built-in node's pool with the label only until the scan's workers are placed, so they land
      // on remote-1; then the label moves to the built-in node, which is where the replacements must go.
      let scan: Scan | undefined
      try {
        await updateNode(adminApi, remote.id, { pool: builtin.pool, labels: { ...remoteBefore.labels, ...mark } })
        // A slow, deterministic schedule: the scheduler is still publishing when the partition starts.
        scan = await scans.start(
          probeScan(probe, { seconds: 0.2 }, { count: total, delay_seconds: 1 }, { ...SMALL_SETTINGS, nodeSelector: { pool: builtin.pool, labels: mark } }),
        )
        const scanId = scan.id
        await waitFor(
          'the scheduler and the runner placed on remote-1',
          () => scanWorkers(api, scanId),
          (workers) => (['scheduler', 'runner'] as const).every((role) => workers.some((w) => w.role === role && w.nodeId === remote.id)),
          { timeoutMs: 60_000, intervalMs: 250 },
        )
      } finally {
        await updateNode(adminApi, remote.id, { pool: remoteBefore.pool, labels: remoteBefore.labels })
      }
      const scanId = scan.id

      const keys = stackKeys()
      const version = (await publicHealth()).body.version
      const tokenOf = (w: Worker) => keys.workerToken({ workerId: w.id, scanId, role: w.role, nodeId: w.nodeId! })
      const checkpoint = async (token: string, epoch: number) => {
        const context = await workerRequest(token, version)
        try {
          const response = await context.post('/api/runtime/scheduler/checkpoint', { data: { epoch, confirmed: 0, tailHash: null } })
          return {
            status: response.status(),
            body: (await response.json().catch(() => ({}))) as { error?: { code: string; details?: Record<string, unknown> } },
          }
        } finally {
          await context.dispose()
        }
      }

      try {
        await updateNode(adminApi, builtin.id, { labels: { ...builtin.labels, ...mark } })
        await waitForScan(api, scanId, 'a scheduler checkpoint', (s) => s.scheduling.state === 'running' && s.scheduling.confirmed > 0, 240_000)
        const original = (await scanWorkers(api, scanId)).filter(isActiveWorker)
        const oldScheduler = original.find((w) => w.role === 'scheduler')
        expect(oldScheduler, JSON.stringify(original)).toBeDefined()
        for (const worker of original) expect(worker.nodeId, `${worker.role} ${worker.id}`).toBe(remote.id)

        const partitionedAt = Date.now()
        await docker.networkDisconnect(REMOTE_NODE_NETWORK, CONTAINERS.remoteNode)
        try {
          await waitForNodeState(adminApi, remote.id, 'offline', 120_000)
          const lost = await waitFor(
            'the original workers lost',
            () => scanWorkers(api, scanId),
            (workers) => original.every((o) => workers.find((w) => w.id === o.id)?.state === 'lost'),
            { timeoutMs: 60_000 },
          )
          for (const worker of lost.filter((w) => original.some((o) => o.id === w.id))) expect(worker.stateReason?.code, worker.id).toBe('nodeOffline')
          // A lost worker's token is rejected at once.
          expect((await checkpoint(tokenOf(oldScheduler!), oldScheduler!.epoch)).status).toBe(401)

          // The replacements are placed on the built-in node; the new scheduler has the next epoch.
          const replacement = await waitFor(
            'a replacement scheduler on the built-in node',
            async () => (await scanWorkers(api, scanId)).find((w) => w.role === 'scheduler' && w.id !== oldScheduler!.id && isActiveWorker(w)),
            (worker) => worker !== undefined && worker.nodeId === builtin.id,
            { timeoutMs: 120_000, intervalMs: 500 },
          )
          expect(replacement!.epoch).toBe(oldScheduler!.epoch + 1)
          // SCHED-010: a scheduler call with the superseded epoch is fenced (the replacement replays all 30 items).
          const stale = await checkpoint(tokenOf(replacement!), oldScheduler!.epoch)
          expect(stale.status, JSON.stringify(stale.body)).toBe(409)
          expect(stale.body.error).toMatchObject({ code: 'staleEpoch', details: { currentEpoch: oldScheduler!.epoch + 1 } })
          // The partition lasts 40 s (docs/testing.md §8.7).
          await holdFor(partitionedAt + 40_000 - Date.now())
        } finally {
          await docker.networkConnect(REMOTE_NODE_NETWORK, CONTAINERS.remoteNode)
        }

        await waitForNodeState(adminApi, remote.id, 'online', 180_000)
        const events = (await nodeEvents(adminApi, remote.id)).filter((e) => Date.parse(e.at) >= partitionedAt).map((e) => e.type)
        expect(events).toEqual(expect.arrayContaining(['node.offline', 'node.online']))
        // The returning daemon removes the lost workers' containers; the stale scheduler never finishes the schedule
        // and its duplicates are absorbed.
        await waitFor(
          "the lost workers' containers removed from remote-1",
          () => remoteScanContainers(scanId),
          (names) => original.every((o) => !names.includes(workerContainerName(o.id))),
          { timeoutMs: 120_000 },
        )
        const done = await waitForScanState(api, scanId, 'completed', 300_000)
        expect(done.scheduling).toMatchObject({ state: 'done', epoch: oldScheduler!.epoch + 1, confirmed: total })
        expect(await scans.counts(scanId)).toEqual({ succeeded: total })
        expectOnePerSeq(await analysesOf(api, scanId), total)
        const replacements = (await scanWorkers(api, scanId)).filter((w) => !original.some((o) => o.id === w.id))
        expect(replacements.map((w) => w.role)).toEqual(expect.arrayContaining(['runner', 'scheduler']))
        for (const worker of replacements) expect(worker.nodeId, `${worker.role} ${worker.id}`).toBe(builtin.id)
      } finally {
        await updateNode(adminApi, builtin.id, { labels: builtin.labels })
      }
    },
  )

  test(
    "after its token is rotated, remote-1's daemon stays unauthorized, removes its workers after the offline window and rejoins with the new token",
    { tag: ['@NODE-031'] },
    async ({ api, adminApi, scans, probe }) => {
      test.setTimeout(600_000)
      const remote = readRemoteNode()
      const total = 4
      const scan = await scans.start(probeScan(probe, { seconds: 20 }, { count: total }, onRemote()))
      const runner = await runningWorker(api, scan.id, 'runner', remote.id)
      const before = await remoteScanContainers(scan.id)
      expect(before).toContain(workerContainerName(runner.id))
      const since = new Date(Date.now() - 1000).toISOString()
      const seen = new Set<string>(before)
      const sample = async () => {
        const names = await remoteScanContainers(scan.id)
        for (const name of names) seen.add(name)
        return names
      }
      let rotated: NodeWithToken | undefined
      try {
        rotated = ok(await adminApi.call<NodeWithToken>('rotateNodeToken', { path: { nodeId: remote.id } }), 'rotateNodeToken')
        await waitFor(
          'the daemon to log the rejected token',
          async () => {
            await sample()
            return remoteDaemonLogs(since)
          },
          (text) => text.includes('orchestrator rejected the node token (401)'),
          { timeoutMs: 90_000 },
        )
        // Within the offline window the worker keeps running.
        expect(await sample()).toContain(workerContainerName(runner.id))
        // Still unauthorized after the offline window, the daemon removes its managed worker containers.
        await waitFor('the daemon to remove its worker containers', sample, (names) => names.length === 0, { timeoutMs: 120_000 })
        expect(await remoteDaemonLogs(since)).toContain('still unauthorized after the offline window')
        // It created no container meanwhile.
        expect([...seen].sort()).toEqual(before)
        await waitForNodeState(adminApi, remote.id, 'offline', 60_000)
      } finally {
        if (rotated) await rejoinRemoteDaemon(rotated.join, rotated.token)
      }
      await waitForNodeState(adminApi, remote.id, 'online', 180_000)
      expect(readRemoteNode().token).toBe(rotated!.token)

      await waitForScanState(api, scan.id, 'completed', 360_000)
      expect(await scans.counts(scan.id)).toEqual({ succeeded: total })
      expect((await scanWorkers(api, scan.id)).find((w) => w.id === runner.id)?.state).toBe('lost')
    },
  )
})

test.describe('platform components', () => {
  test(
    'restarting RabbitMQ while retries are delayed keeps the queue, the retries and the user; /api/health is 200 degraded meanwhile',
    { tag: ['@CHAOS-003', '@PLAT-002'] },
    async ({ api, scans, probe }) => {
      test.setTimeout(420_000)
      const total = 3
      const scan = await scans.start(
        probeScan(probe, { fail_attempts: 1 }, { count: total }, onBuiltin(probe, { maxAttempts: 3, backoff: fixedBackoff(30_000) })),
      )
      await waitFor(
        'every analysis retrying',
        () => statusCounts(api, scan.id),
        (counts) => counts.retrying === total,
        { timeoutMs: 180_000, intervalMs: 500 },
      )

      // A restart as stop and start: RabbitMQ restarts within about 3 s, the length of the health cache, so it stays
      // stopped until /api/health has seen it down.
      const restartedAt = Date.now()
      await runDocker(['stop', CONTAINERS.rabbitmq], { timeoutMs: 90_000 })
      let down: Awaited<ReturnType<typeof publicHealth>>
      try {
        // PLAT-002: a component other than MongoDB is down, so /api/health stays 200 and reports degraded.
        down = await waitFor('RabbitMQ down in /api/health', publicHealth, (h) => h.body.components.rabbitmq === 'down', { timeoutMs: 60_000, intervalMs: 300 })
      } finally {
        await runDocker(['start', CONTAINERS.rabbitmq])
      }
      expect(down.status).toBe(200)
      expect(down.body).toMatchObject({ status: 'degraded', components: { mongo: 'ok', rabbitmq: 'down' } })

      await waitFor(
        'the queue of the scan back',
        () => broker.queue(scanQueueName(scan.id)),
        (queue) => queue !== null,
        { timeoutMs: 120_000 },
      )
      expect(await broker.userExists(scanUserName(scan.id))).toBe(true)
      expect((await getScan(api, scan.id)).state).toBe('running')

      await waitForScanState(api, scan.id, 'completed', 240_000)
      expect(await scans.counts(scan.id)).toEqual({ succeeded: total })
      for (const row of await analysesOf(api, scan.id, ['timings'])) {
        expect(row, `seq ${row.seq}`).toMatchObject({ status: 'succeeded', attempt: 2 })
        expect(Date.parse(row.timings!.startedAt!), `seq ${row.seq}: the retry ran after the restart`).toBeGreaterThan(restartedAt)
      }
    },
  )

  test(
    'during a RabbitMQ memory alarm startScan answers 503 and running scans show brokerAlarm until it clears',
    { tag: ['@CHAOS-008', '@PLAT-002'] },
    async ({ api, adminApi, scans, probe }) => {
      test.setTimeout(420_000)
      const total = 6
      const scan = await scans.start(probeScan(probe, { seconds: 2 }, { count: total }, onBuiltin(probe)))
      await runningWorker(api, scan.id, 'runner')
      const alarmedAt = Date.now()
      await withMemoryAlarm(async () => {
        const health = await waitFor('the memory alarm in /api/health', publicHealth, (h) => h.body.alarms.includes('memory'), { timeoutMs: 60_000 })
        expect(health.body.components).toMatchObject({ mongo: 'ok', rabbitmq: 'ok' })

        const refused = await waitFor(
          'startScan refused',
          async () => {
            const response = await api.startScan(probeScan(probe, {}, { count: 1 }, onBuiltin(probe)))
            if (response.status === 201) scans.track(response.body.id)
            return response
          },
          (response) => response.status === 503,
          { timeoutMs: 60_000, intervalMs: 2000 },
        )
        expect(refused.body as unknown).toMatchObject({ error: { code: 'brokerAlarm' } })
        await waitForScan(api, scan.id, 'the brokerAlarm condition', (s) => s.conditions.some((c) => c.type === 'brokerAlarm'), 60_000)
        await waitFor(
          'scantor_rabbitmq_alarm 1',
          () => metricValue(adminApi, 'scantor_rabbitmq_alarm', { type: 'memory' }),
          (value) => value === 1,
          { timeoutMs: 30_000 },
        )
        await holdFor(alarmedAt + 20_000 - Date.now())
      })
      expect(await memoryWatermark()).not.toEqual(['absolute', '1'])

      await waitForScan(api, scan.id, 'the brokerAlarm condition cleared', (s) => !s.conditions.some((c) => c.type === 'brokerAlarm'), 90_000)
      await waitForScanState(api, scan.id, 'completed', 240_000)
      expect(await scans.counts(scan.id)).toEqual({ succeeded: total })
      await waitFor('no alarm in /api/health', publicHealth, (h) => h.status === 200 && h.body.alarms.length === 0, { timeoutMs: 60_000 })
      expect(await metricValue(adminApi, 'scantor_rabbitmq_alarm', { type: 'memory' })).toBe(0)
    },
  )

  test('the health status is degraded during a RabbitMQ memory alarm', { tag: ['@PLAT-002', '@CHAOS-008'] }, async () => {
    const health = await withMemoryAlarm(() =>
      waitFor('the memory alarm in /api/health', publicHealth, (h) => h.body.alarms.includes('memory'), { timeoutMs: 60_000 }),
    )
    expect(health.status).toBe(200)
    expect(health.body.status).toBe('degraded')
  })

  test(
    'while MongoDB is paused results wait in the ingest queue and /api/health answers 503; ingestion then resumes without loss',
    { tag: ['@CHAOS-009', '@PLAT-002'] },
    async ({ api, scans, probe, docker }) => {
      test.setTimeout(420_000)
      const total = 30
      const scan = await scans.start(probeScan(probe, { seconds: 0.5 }, { count: total }, onBuiltin(probe, { processes: 2 })))
      await waitFor(
        'the first results',
        () => statusCounts(api, scan.id),
        (counts) => (counts.succeeded ?? 0) >= 3,
        { timeoutMs: 180_000, intervalMs: 500 },
      )

      const pausedAt = Date.now()
      await docker.pause(CONTAINERS.mongo)
      try {
        const down = await waitFor('/api/health 503', publicHealth, (h) => h.status === 503, { timeoutMs: 60_000, intervalMs: 500 })
        expect(down.body).toMatchObject({ status: 'degraded', components: { mongo: 'down' } })
        await waitFor(
          'results waiting in scantor.results.ingest',
          () => broker.queue(INGEST_QUEUE),
          (queue) => (queue?.messages ?? 0) > 0,
          { timeoutMs: 30_000 },
        )
        // The runtimes keep working meanwhile.
        await holdFor(pausedAt + 15_000 - Date.now())
      } finally {
        await docker.unpause(CONTAINERS.mongo)
      }
      expect((await waitFor('/api/health 200', publicHealth, (h) => h.status === 200, { timeoutMs: 60_000 })).body.components.mongo).toBe('ok')

      await waitForScanState(api, scan.id, 'completed', 240_000)
      expect(await scans.counts(scan.id)).toEqual({ succeeded: total })
      expectOnePerSeq(await analysesOf(api, scan.id), total)
    },
  )

  test(
    'a scan cancelled and deleted right after a result backlog built up stays a tombstone without analyses',
    { tag: ['@CHAOS-005'] },
    async ({ api, user, openapi, scans, probe, docker }) => {
      test.setTimeout(720_000)
      const total = 3000
      const scan = await scans.start({ ...probeScan(probe, {}, { count: total }, onBuiltin(probe, { processes: 2 })), confirm: true })
      await waitFor(
        'results flowing',
        () => statusCounts(api, scan.id),
        (counts) => (counts.succeeded ?? 0) >= 5,
        { timeoutMs: 180_000, intervalMs: 500 },
      )

      const pausedAt = Date.now()
      await docker.pause(CONTAINERS.orchestrator)
      try {
        await waitFor(
          'a result backlog',
          () => broker.queue(INGEST_QUEUE),
          (queue) => (queue?.messages_ready ?? 0) >= 20,
          { timeoutMs: 20_000, intervalMs: 500 },
        )
        await holdFor(pausedAt + 20_000 - Date.now())
      } finally {
        await docker.unpause(CONTAINERS.orchestrator)
      }
      // At once, through the orchestrator's own listener (Traefik routes to it again only after the unpause event).
      const context = await directApiContext(user.apiKey)
      let deleted: Awaited<ReturnType<ApiClient['deleteScan']>>
      try {
        const direct = new ApiClient(context, openapi)
        const cancelled = await direct.cancelScan(scan.id)
        expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200)
        expect(cancelled.body.state).toBe('cancelled')
        deleted = await direct.deleteScan(scan.id)
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(202)
      } finally {
        await context.dispose()
      }
      // scanDelete jobs run two at a time, so on a busy stack this one may wait for others first.
      const job = await waitFor(
        'the scanDelete job',
        async () => ok(await api.getJob(deleted.body.job.id, 30), 'getJob'),
        (j) => j.state !== 'queued' && j.state !== 'running',
        { timeoutMs: 420_000, intervalMs: 500 },
      )
      expect(job.state).toBe('succeeded')
      expect((await getScan(api, scan.id)).state).toBe('deleted')

      // No late result resurrects an analysis of the tombstone.
      const until = Date.now() + 60_000
      for (;;) {
        expect(await docker.mongoCount('analyses', { scanId: scan.id })).toBe(0)
        if (Date.now() >= until) break
        await holdFor(5000)
      }
      expect(await broker.queue(scanQueueName(scan.id))).toBeNull()
      expect(await broker.userExists(scanUserName(scan.id))).toBe(false)
    },
  )
})

test.describe('an orchestrator restart during a scan and a build', () => {
  // One restart serves four tests: the orchestrator is stopped while a scan is running and a revision is building,
  // inspected while stopped, and started with MongoDB paused, which holds the boot window open.
  interface Restart {
    scanId: string
    total: number
    taskName: string
    revisionId: string
    /** read from MongoDB while the orchestrator is stopped */
    whileStopped: { revision: string; job: string; scan: string; succeeded: number }
    booting: {
      scans: DirectResponse
      tasks: DirectResponse
      forwardAuth: DirectResponse
      docs: DirectResponse
      openapi: DirectResponse
      health: DirectResponse
    }
  }
  let restart: Restart | undefined
  const created: { scanId?: string; taskName?: string } = {}

  test.beforeAll(async ({ keyApi, adminApi, user, probe, docker }) => {
    test.setTimeout(600_000)
    await waitForHealthyPlatform(adminApi)
    const dir = await writeChaosTask({ slowBuildSeconds: 75 })
    const taskName = unique('chaos-slow-build')
    created.taskName = taskName
    let revisionId: string
    try {
      revisionId = ok(await keyApi.uploadTask(await packTask(dir, { name: taskName }), { publish: true }), 'uploadTask').revision!.id
    } finally {
      await removeDir(dir)
    }
    const building = await waitFor(
      'the build to run',
      async () => ok(await keyApi.getRevision(taskName, revisionId), 'getRevision'),
      (r) => r.state !== 'queued',
      {
        timeoutMs: 240_000,
      },
    )
    expect(building.state).toBe('building')

    // About 60 s of work: more than the stop (Nitro drains open requests, the node long-polls among them, for up to
    // SCANTOR_NODE_ASSIGNMENTS_WAIT before the components stop) and the boot together.
    const total = 40
    const scan = await startScan(keyApi, probeScan(probe, { seconds: 3 }, { count: total }, onBuiltin(probe, { processes: 2 })))
    created.scanId = scan.id
    await waitFor(
      'results being ingested',
      () => statusCounts(keyApi, scan.id),
      (counts) => (counts.succeeded ?? 0) >= 2,
      { timeoutMs: 120_000, intervalMs: 500 },
    )
    expect(ok(await keyApi.getRevision(taskName, revisionId), 'getRevision').state).toBe('building')

    const auth = { Authorization: `Bearer ${user.apiKey}` }
    let whileStopped: Restart['whileStopped'] | undefined
    let booting: Restart['booting'] | undefined
    try {
      await stopOrchestrator()
      const id = JSON.stringify(revisionId)
      const sid = JSON.stringify(scan.id)
      whileStopped = JSON.parse(
        await docker.mongosh(
          `print(EJSON.stringify({ revision: db.revisions.findOne({ _id: ${id} }).state, job: db.jobs.find({ kind: 'revisionBuild', 'subject.id': ${id} }).sort({ createdAt: -1 }).limit(1).next().state, scan: db.scans.findOne({ _id: ${sid} }).state, succeeded: db.analyses.countDocuments({ scanId: ${sid}, status: 'succeeded' }) }))`,
          { as: 'root' },
        ),
      ) as Restart['whileStopped']
      await docker.pause(CONTAINERS.mongo)
      try {
        await startOrchestrator()
        const scans = await waitFor(
          'the booting orchestrator to answer',
          () => directGet('/api/scans?limit=1', auth),
          (r) => r.status === 503,
          {
            timeoutMs: 60_000,
            intervalMs: 200,
          },
        )
        booting = {
          scans,
          tasks: await directGet('/api/tasks', auth),
          forwardAuth: await directGet('/api/tools/forward-auth'),
          docs: await directGet('/api/docs'),
          openapi: await directGet('/api/docs/openapi.json'),
          health: await directGet('/api/health'),
        }
      } finally {
        await docker.unpause(CONTAINERS.mongo)
      }
    } finally {
      // `docker start` of a running container is a no-op: the orchestrator runs again in every case.
      await startOrchestrator()
    }
    await waitForOrchestrator(user.apiKey)
    restart = { scanId: scan.id, total, taskName, revisionId, whileStopped: whileStopped!, booting: booting! }
  })

  test.afterAll(async ({ keyApi }) => {
    if (created.scanId) await cancelAndDeleteScan(keyApi, created.scanId)
    if (created.taskName) await deleteTaskSoon(keyApi, created.taskName)
  })

  test('a scan running across the restart completes with exact counts', { tag: ['@CHAOS-002'] }, async ({ api, scans }) => {
    test.setTimeout(360_000)
    const { scanId, total, whileStopped } = restart!
    // The scan was still running when the orchestrator had stopped.
    expect(whileStopped.scan).toBe('running')
    expect(whileStopped.succeeded).toBeLessThan(total)
    const done = await waitForScanState(api, scanId, 'completed', 300_000)
    expect(done.scheduling).toMatchObject({ state: 'done', confirmed: total })
    expect(await scans.counts(scanId)).toEqual({ succeeded: total })
    expectOnePerSeq(await analysesOf(api, scanId), total)
  })

  test('while the orchestrator boots every /api route answers 503 except health and the docs', { tag: ['@API-010'] }, async () => {
    const { booting } = restart!
    expect(booting.scans).toMatchObject({ status: 503, json: { error: { code: 'unavailable' } } })
    expect(booting.tasks).toMatchObject({ status: 503, json: { error: { code: 'unavailable' } } })
    expect(booting.forwardAuth.status).toBe(503)
    expect(booting.forwardAuth.contentType).toContain('text/plain')
    expect(booting.docs.status).toBe(200)
    expect(booting.openapi.status).toBe(200)
    expect((booting.openapi.json as { openapi: string }).openapi).toMatch(/^3\.1\./)
    // /api/health answers its own report (MongoDB is paused, so 503 with mongo down), not the boot error.
    expect(booting.health).toMatchObject({ status: 503, json: { status: 'degraded', components: { mongo: 'down' } } })
  })

  test('a build interrupted by the restart is rebuilt from its stored snapshot', { tag: ['@REV-011'] }, async ({ api }) => {
    test.setTimeout(360_000)
    const { taskName, revisionId, whileStopped } = restart!
    expect(whileStopped.job).toBe('queued')
    const rebuilt = await waitForRevision(api, taskName, revisionId, 300_000)
    expect(rebuilt.state, JSON.stringify(rebuilt.errors)).toBe('ready')
    expect(rebuilt.image?.digest).toMatch(/^sha256:/)
    const jobs = ok(await api.call<{ items: Job[] }>('listJobs', { query: { kind: 'revisionBuild', limit: 200 } }), 'listJobs').items
    const job = jobs.find((j) => j.subject.id === revisionId)
    expect(job).toMatchObject({ state: 'succeeded' })
    expect(job!.attempts).toBeGreaterThanOrEqual(2)
  })

  test('the interrupted revision goes back to queued until its build runs again', { tag: ['@REV-011'] }, async () => {
    expect(restart!.whileStopped.revision).toBe('queued')
  })
})

test.describe('logs', () => {
  test('no live credential appears in any container log of the stack', { tag: ['@SEC-024'] }, async ({ api, user, scans, probe, docker }) => {
    test.setTimeout(300_000)
    // A scan whose worker tokens and RabbitMQ password are live while its containers log.
    const scan = await scans.start(probeScan(probe, { seconds: 8 }, { count: 2 }, onBuiltin(probe)))
    await runningWorker(api, scan.id, 'runner')
    const keys = stackKeys()
    const stack = stackEnv()
    const secrets: Record<string, string> = {
      'the tenant API key': user.apiKey,
      'the built-in node token': keys.builtinNodeToken(),
      "remote-1's node token": readRemoteNode().token,
      "the scan's RabbitMQ password": keys.amqpPassword(scan.id),
      'the registry push password': keys.registryPushPassword(),
      'the scantor_query password': keys.mongoQueryPassword(),
      SCANTOR_SECRET: stack.SCANTOR_SECRET!,
      'the admin password': env.admin.password,
      ...storedSessionTokens(),
    }
    for (const worker of await scanWorkers(api, scan.id)) {
      if (worker.nodeId)
        secrets[`the ${worker.role} token ${worker.id}`] = keys.workerToken({ workerId: worker.id, scanId: scan.id, role: worker.role, nodeId: worker.nodeId })
    }
    // The stack's credentials of its own services, which no scantor component may log.
    const own: Record<string, string> = {
      'the RabbitMQ admin password': stack.SCANTOR_RABBITMQ_PASSWORD!,
      'the MongoDB root password': stack.SCANTOR_MONGO_PASSWORD!,
    }

    const leaks: string[] = []
    const check = (where: string, text: string, values: Record<string, string>) => {
      for (const [what, value] of Object.entries(values)) if (value && value.length >= 8 && text.includes(value)) leaks.push(`${what} in the log of ${where}`)
    }
    // Unredacted token shapes (the redactions keep only the prefix: `snt_***`, `swt_<workerId>.[REDACTED]`, …).
    const shapes = [/sk_scantor_(?:editor_)?[A-Za-z0-9]{8,}/, /\b(?:snt|sst|spk|sic|sec)_[A-Za-z0-9_-]{16,}/, /\bswt_[0-9a-f-]{36}\.[A-Za-z0-9_-]{8,}/]
    const scantorComponent = (name: string) =>
      name === CONTAINERS.orchestrator || name === CONTAINERS.node || name === 'scantor-node' || name.startsWith('scantor-w-')

    const local = (args: string[]) => runDocker(args, { allowFailure: true })
    const remote = (args: string[]) => docker.remote(args, { allowFailure: true })
    let scanned = 0
    for (const [where, run] of [
      ['the runner', local],
      ['remote-1', remote],
    ] as const) {
      for (const name of await platformContainers(run)) {
        const out = await run(['logs', name])
        const text = out.stdout + out.stderr
        scanned += 1
        check(`${name} (${where})`, text, secrets)
        if (!scantorComponent(name)) continue
        check(`${name} (${where})`, text, own)
        for (const shape of shapes) {
          const match = shape.exec(text)
          if (match) leaks.push(`an unredacted ${match[0].slice(0, 6)}… token in the log of ${name} (${where})`)
        }
      }
    }
    expect(scanned).toBeGreaterThan(5)
    expect(leaks).toEqual([])
    await waitForScanState(api, scan.id, 'completed', 180_000)
    expect(await scans.counts(scan.id)).toEqual({ succeeded: 2 })
  })
})
