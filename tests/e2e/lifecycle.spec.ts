import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Export, FileDownload } from '#shared/types/exports'
import type { Scan } from '#shared/types/scans'
import type { Worker } from '#shared/types/workers'
import { ok, type ApiClient } from '../helpers/api-client'
import {
  apiErrorOf,
  cancellingScansFixture,
  eventTypes,
  expectStableFor,
  getScan,
  scanLimits,
  scanOps,
  sharedTasksFixture,
  tenantKeyApi,
  UNPLACEABLE_SETTINGS,
  waitFor,
  waitForJob,
  workerKeyApi,
  type SharedTasks,
} from '../helpers/api-scans'
import {
  createOrphanScanObjects,
  ingestedResults,
  publishDelayedResults,
  purgeOwnScanQueue,
  scanBrokerObjects,
  scanQueue,
  scanQueueBindings,
  scanUserExists,
  scanUserPermissions,
  scanUserTopicPermissions,
  type DelayedResult,
} from '../helpers/api-scans-broker'
import { scantor } from '../helpers/cli'
import { allAnalyses } from '../helpers/e2e-runtime'
import { innerDocker } from '../helpers/docker'
import { SMALL_SETTINGS } from '../helpers/scans'
import { expect, test as base, unique } from '../fixtures'

// Scan lifecycles end to end (docs/architecture.md §11.2–§11.3, docs/queue.md §3.5, §4, §6.8–§6.9, §8–§9): the
// per-scan queue and RabbitMQ user, completion and failure, pause and resume with a scheduler checkpoint, live
// scaling, cancel with the broker kill switch, recounts, retry-failed rounds (failed, lost and cancelled analyses),
// restart clones, delete and the tombstone, and progress. Every scan runs real workers on the built-in node.
//
// Speed: every worker builds the generated lifecycle task (custom schedule, run modes, secrets, files;
// helpers/api-scans-tasks.ts) when it starts and every test reuses it; the progress test also builds the `sleep`
// example (template `repeat`). Two tests wait for platform clocks and the shared job queue and come first, so they
// start at once on separate workers: the recount test waits for the terminal recount two minutes after its cancel
// (and observes the 60 s cadence of running and paused scans meanwhile), the delete test for the scanDelete job,
// which the whole stack shares (two at a time, each holding its slot for a settle delay of more than 10 s).

const test = base.extend<object, { workerApi: ApiClient; shared: SharedTasks }>({
  // The tenant acts through its API key (helpers/api-scans.ts explains why).
  api: tenantKeyApi,
  workerApi: [workerKeyApi, { scope: 'worker' }],
  shared: [sharedTasksFixture(['lifecycle']), { scope: 'worker', auto: true }],
  scans: cancellingScansFixture,
})

test.describe.configure({ timeout: 180_000 })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type BrokerObservation = { queue: boolean; user: boolean }

/** Polls the scan's queue and user until both are gone; returns every observation (queue read before the user). */
async function waitForBrokerCleanup(scanId: string, timeoutMs = 60_000): Promise<BrokerObservation[]> {
  const observations: BrokerObservation[] = []
  await waitFor(
    `the queue and RabbitMQ user of ${scanId} removed`,
    async () => {
      const observed = await scanBrokerObjects(scanId)
      observations.push(observed)
      return observed
    },
    (observed) => !observed.queue && !observed.user,
    { timeoutMs, intervalMs: 100 },
  )
  return observations
}

/** The user is deleted before the queue: no observation shows the queue gone while the user still exists. */
function expectUserRemovedFirst(observations: BrokerObservation[]): void {
  expect(
    observations.filter((observed) => !observed.queue && observed.user),
    JSON.stringify(observations),
  ).toEqual([])
}

/** Ids of the scan's running worker containers in the built-in node's Docker. */
function runningContainers(scanId: string): Promise<string[]> {
  return innerDocker.containersByLabel({ 'scantor.scan': scanId, 'scantor.kind': 'worker' }, { all: false })
}

function waitContainersGone(scanId: string, timeoutMs = 90_000): Promise<string[]> {
  return waitFor(
    'the worker containers removed',
    () => runningContainers(scanId),
    (ids) => ids.length === 0,
    { timeoutMs, intervalMs: 1000 },
  )
}

/**
 * The scan's queue once the management statistics caught up with `done` (they lag by about 5–12 s, docs/queue.md
 * §3.5); throws with the last view when the queue is missing or never matches. A queue whose statistics were not
 * collected yet reads 0 everywhere, so it never matches.
 */
function waitQueue(scanId: string, what: string, done: (queue: NonNullable<Awaited<ReturnType<typeof scanQueue>>>) => boolean, timeoutMs = 30_000) {
  return waitFor(
    what,
    () => scanQueue(scanId),
    (queue) => queue !== null && queue.statsReported && done(queue),
    { timeoutMs, intervalMs: 1000 },
  ) as Promise<NonNullable<Awaited<ReturnType<typeof scanQueue>>>>
}

/**
 * The scan's queue as the broker itself counts it (rabbitmqctl), or null when it does not exist: unlike the management
 * statistics, these counts never start out missing for a new queue (a quorum queue still refreshes them on
 * its 5 s tick, docs/testing.md §9).
 */
async function liveQueue(scanId: string) {
  return (await innerDocker.rabbitmqQueues()).find((queue) => queue.name === `scantor.scan.${scanId}`) ?? null
}

type AnalysisRow = { seq: number; status: string; round: number; config?: unknown; attempts: { round: number }[] }

/** Analyses of a scan with the fields the retry tests compare (seq order). */
async function analysesOf(api: ApiClient, scanId: string): Promise<AnalysisRow[]> {
  const result = ok(
    await api.queryAnalyses(scanId, { filter: {}, projection: { seq: 1, status: 1, round: 1, config: 1, 'attempts.round': 1 }, sort: { seq: 1 }, limit: 1000 }),
    'queryAnalyses',
  )
  return result.items as AnalysisRow[]
}

const rounds = (attempts: { round: number }[] | undefined) => [...new Set((attempts ?? []).map((attempt) => attempt.round))].sort()

/**
 * Samples `getScan` every 2 s in the background and collects the distinct `stats.recountedAt` values seen while the
 * scan was running (recounts are at least 60 s apart, so no recount is missed). `stop()` ends the sampling and
 * returns them in time order.
 */
function sampleRecounts(api: ApiClient, scanId: string): { stop(): Promise<number[]> } {
  const seen = new Set<string>()
  let running = true
  // A failed read ends the sampling; stop() reports it, so the loop never rejects unobserved.
  const loop = (async (): Promise<unknown> => {
    try {
      while (running) {
        const scan = await getScan(api, scanId)
        if (scan.state === 'running' && scan.stats.recountedAt) seen.add(scan.stats.recountedAt)
        await sleep(2000)
      }
      return undefined
    } catch (error) {
      return error
    }
  })()
  return {
    async stop() {
      running = false
      const error = await loop
      if (error) throw error
      return [...seen].map((at) => Date.parse(at)).sort((a, b) => a - b)
    },
  }
}

test.describe('recounts and delete', () => {
  test(
    'cancel removes the user, then the queue and the workers; running, paused and terminal scans are recounted on their cadences',
    { tag: ['@SCAN-030', '@SCAN-041', '@SCAN-023', '@ING-003'] },
    async ({ api, shared, scans }) => {
      // The terminal recount runs two minutes after the cancel.
      test.setTimeout(330_000)
      const { revision } = await shared.get('lifecycle')
      const ops = scanOps(api)
      const total = 60
      // cancelled: cancelled mid-run. parked: running, but its workers cannot be placed (recounted every 60 s).
      // paused: paused while both of its analyses run; they finish during the drain.
      const [cancelling, parked, pausing] = await Promise.all([
        scans.start({ revision: revision.ref, taskConfig: { seconds: 2 }, scanConfig: { count: total }, settings: { ...SMALL_SETTINGS, processes: 2 } }),
        scans.start({ revision: revision.ref, settings: UNPLACEABLE_SETTINGS }),
        scans.start({ revision: revision.ref, taskConfig: { seconds: 10 }, scanConfig: { count: 2 }, settings: { ...SMALL_SETTINGS, processes: 2 } }),
      ])
      const parkedRecounts = sampleRecounts(api, parked.id)
      let parkedTimes: number[] = []

      try {
        // The paused scan: scheduling is done and both analyses are in flight when it pauses, so it would complete
        // as soon as they finish if it were running.
        await waitFor(
          'both analyses of the paused scan in flight with scheduling done',
          async () => ({ scan: await getScan(api, pausing.id), inflight: ok(await ops.inflight(pausing.id), 'listInflightAnalyses').items }),
          ({ scan, inflight }) => scan.scheduling.state === 'done' && inflight.length === 2,
          { timeoutMs: 90_000, intervalMs: 250 },
        )
        expect(ok(await ops.pause(pausing.id), 'pauseScan')).toMatchObject({ state: 'paused', stateReason: { code: 'user' } })

        await waitFor(
          'two succeeded analyses of the cancelled scan with scheduling done',
          async () => ({ scan: await getScan(api, cancelling.id), counts: await scans.counts(cancelling.id) }),
          ({ scan, counts }) => scan.scheduling.state === 'done' && (counts.succeeded ?? 0) >= 2,
          { timeoutMs: 90_000, intervalMs: 500 },
        )
        const cancelled = ok(await api.cancelScan(cancelling.id), 'cancelScan')
        expect(cancelled).toMatchObject({ state: 'cancelled', stateReason: { code: 'user' }, completedAt: expect.any(String) })
        const cancelledAt = Date.parse(cancelled.completedAt!)

        // Within seconds: the user (first) and the queue, then the workers.
        expectUserRemovedFirst(await waitForBrokerCleanup(cancelling.id, 30_000))
        await waitContainersGone(cancelling.id)

        // Pending and retrying analyses become cancelled and the scan is recounted; results that were already queued for
        // ingestion are recorded within a few ingest flushes (1 s) of it. From then on the counts stay stable.
        const converged = await waitFor(
          'the cancelled scan converged',
          async () => ({ scan: await getScan(api, cancelling.id), counts: await scans.counts(cancelling.id) }),
          ({ scan, counts }) =>
            counts.pending === undefined &&
            counts.retrying === undefined &&
            scan.stats.recountedAt !== null &&
            Date.parse(scan.stats.recountedAt) >= cancelledAt &&
            Date.now() >= Date.parse(scan.stats.recountedAt) + 5_000,
          { timeoutMs: 60_000, intervalMs: 1000 },
        )
        // The stats are hints on top of that recount: a result that was already queued for ingestion and is recorded
        // after it adds to them, so they can overshoot (61/60) until the terminal recount below. The exact counts cover
        // at most `total` analyses (never-run seqs have no document).
        const exact = converged.counts
        expect((exact.succeeded ?? 0) + (exact.failed ?? 0) + (exact.cancelled ?? 0)).toBeLessThanOrEqual(total)
        const { stats } = converged.scan
        test.info().annotations.push({ type: 'stats after the cancel recount', description: `${stats.succeeded + stats.failed + stats.cancelled}/${total}` })
        const stable = await expectStableFor('the exact counts after the cancel', () => scans.counts(cancelling.id), { durationMs: 30_000 })
        expect(stable.succeeded ?? 0).toBeGreaterThanOrEqual(2)
        expect(stable.succeeded ?? 0).toBeLessThan(total)

        // The paused scan recorded the results of the drain (late results are still ingested) and is recounted while
        // its hints changed, but it never completes.
        await waitFor(
          'the drained analyses of the paused scan recorded',
          () => scans.counts(pausing.id),
          (counts) => counts.succeeded === 2,
          { timeoutMs: 60_000 },
        )
        const drainedAt = Date.now()
        const recountedPause = await waitFor(
          'a recount of the paused scan after its drain',
          () => getScan(api, pausing.id),
          (scan) => scan.stats.recountedAt !== null && Date.parse(scan.stats.recountedAt) > drainedAt,
          { timeoutMs: 90_000, intervalMs: 2000 },
        )
        expect(recountedPause).toMatchObject({
          state: 'paused',
          completedAt: null,
          scheduling: { state: 'done', confirmed: 2 },
          stats: { succeeded: 2, failed: 0, pending: 0, retrying: 0, lost: 0 },
        })

        // Terminal scans are recounted once more two minutes after the terminal state: the stats are then exact.
        const final = await waitFor(
          'the terminal recount',
          () => getScan(api, cancelling.id),
          (scan) => scan.stats.recountedAt !== null && Date.parse(scan.stats.recountedAt) >= cancelledAt + 120_000,
          { timeoutMs: 170_000, intervalMs: 2000 },
        )
        expect(final.state).toBe('cancelled')
        const counts = await scans.counts(cancelling.id)
        expect(final.stats).toMatchObject({ succeeded: counts.succeeded ?? 0, failed: counts.failed ?? 0, lost: 0, pending: 0, retrying: 0 })
        expect(final.stats.succeeded + final.stats.failed + final.stats.cancelled).toBe(final.scheduling.confirmed)
        expect(final.scheduling.confirmed).toBe(total)
        expect((await getScan(api, pausing.id)).state).toBe('paused')
      } finally {
        parkedTimes = await parkedRecounts.stop()
      }

      // The parked scan was observed for the whole test (more than two minutes): it is recounted on its first tick as
      // running, then every 60 s (plus up to one 10 s reconciler tick).
      const gaps = parkedTimes.slice(1).map((at, index) => at - parkedTimes[index]!)
      expect(parkedTimes.length, JSON.stringify(parkedTimes)).toBeGreaterThanOrEqual(2)
      for (const gap of gaps) {
        expect(gap, JSON.stringify(gaps)).toBeGreaterThanOrEqual(55_000)
        expect(gap, JSON.stringify(gaps)).toBeLessThan(75_000)
      }
      expect((await getScan(api, parked.id)).state).toBe('running')
    },
  )

  test(
    'deleting a scan purges its data and leaves a tombstone that refuses every transition; a late result is dropped',
    { tag: ['@SCAN-037', '@SCAN-015', '@SCAN-024', '@SCAN-026', '@SCAN-034', '@SCAN-036'] },
    async ({ api, adminApi, docker, request, shared, scans }) => {
      // The scanDelete job queue is shared by the whole stack (FIFO, two jobs at a time, each holding its slot for a
      // settle delay of more than 10 s, about ten deletions a minute), so the job can wait for minutes behind the
      // other specs' deletions.
      test.setTimeout(600_000)
      const { revision } = await shared.get('lifecycle')
      const scan = await scans.start({ revision: revision.ref, taskConfig: { file: true, seconds: 8 }, scanConfig: { count: 1 } })
      const ops = scanOps(api)

      // While the analysis runs, the scan's user publishes results for seqs 1–300 that the broker hands to the
      // ingestor only later (x-opt-delivery-time), one every 2 s from 30 s on: whenever the delete job finishes within
      // the next ten minutes, the next ones arrive a few seconds after it.
      await waitFor(
        'the analysis in flight',
        async () => ok(await ops.inflight(scan.id), 'listInflightAnalyses').items,
        (items) => items.length > 0,
        {
          timeoutMs: 90_000,
          intervalMs: 250,
        },
      )
      const publishedAt = Date.now()
      const late: DelayedResult[] = Array.from({ length: 300 }, (_, index) => ({ seq: index + 1, deliverAt: publishedAt + 30_000 + index * 2_000 }))
      await publishDelayedResults(scan.id, late)
      await scans.wait(scan.id, { timeoutMs: 60_000 })
      // The late results are held back: only the scan's own analysis is recorded.
      expect(Date.now()).toBeLessThan(late[0]!.deliverAt)
      expect(await scans.counts(scan.id)).toEqual({ succeeded: 1 })

      const rows = ok(await api.queryAnalyses(scan.id, { filter: { seq: 0 }, projection: { result: 1 } }), 'queryAnalyses').items as {
        result: { report: { id: string } }
      }[]
      const file = ok(
        await api.call<FileDownload>('getFileDownload', { path: { analysisId: `${scan.id}-0`, fileId: rows[0]!.result.report.id } }),
        'getFileDownload',
      )
      const exported = ok(await api.call<Export>('exportScan', { path: { scanId: scan.id }, body: { format: 'jsonl' }, query: { wait: 60 } }), 'exportScan')
      expect(exported.state).toBe('ready')
      for (const url of [file.url, exported.download!.url]) expect((await request.get(url)).status()).toBe(200)

      const accepted = ok(await api.deleteScan(scan.id), 'deleteScan')
      const job = await waitForJob(api, accepted.job.id, 480_000)
      expect(job.state).toBe('succeeded')
      const deletedAt = Date.now()
      const seconds = (from: string | null, to: string | null) => (from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 1000) : null)
      test.info().annotations.push({
        type: 'scanDelete job',
        description: `queued ${seconds(job.createdAt, job.startedAt)} s, ran ${seconds(job.startedAt, job.finishedAt)} s`,
      })
      const droppedBefore = await ingestedResults(adminApi, 'dropped')
      const after = late.filter((result) => result.deliverAt >= deletedAt + 1000).slice(0, 2)
      if (after.length < 2)
        throw new Error(
          `the delete job finished ${Math.round((deletedAt - publishedAt) / 1000)} s after the late results were published, after they were delivered`,
        )

      // The tombstone: state deleted with purgeAfter = now + SCANTOR_TOMBSTONE_DAYS, and nothing else is left.
      const tombstone = await getScan(api, scan.id)
      expect(tombstone).toMatchObject({ id: scan.id, state: 'deleted', deletedAt: expect.any(String) })
      const stored = JSON.parse(
        await docker.mongosh(`print(EJSON.stringify(db.scans.findOne({ _id: ${JSON.stringify(scan.id)} }, { purgeAfter: 1 }), { relaxed: true }))`),
      )
      const { tombstoneDays } = scanLimits()
      expect(Math.abs(Date.parse(stored.purgeAfter.$date) - (deletedAt + tombstoneDays * 86_400_000))).toBeLessThan(10 * 60_000)
      for (const collection of ['analyses', 'events', 'exports', 'workers']) {
        expect(await docker.mongoCount(collection, { scanId: scan.id }), collection).toBe(0)
      }
      expect((await api.call('getExport', { path: { exportId: exported.id } })).status).toBe(404)
      expect(await scanBrokerObjects(scan.id)).toEqual({ queue: false, user: false })
      for (const url of [file.url, exported.download!.url]) expect((await request.get(url)).status()).toBe(404)
      expect(await eventTypes(api, scan.id)).toEqual([])

      // A deleted scan refuses every transition, deletion included.
      for (const response of [
        await api.deleteScan(scan.id),
        await api.cancelScan(scan.id),
        await ops.pause(scan.id),
        await ops.restart(scan.id),
        await ops.retryFailed(scan.id),
      ]) {
        expect(apiErrorOf(response, 409, 'invalidState').details).toMatchObject({ state: 'deleted' })
      }

      // The next two late results arrive after the deletion: the ingestor drops them (other scans' drops only add to
      // the counter) and writes nothing.
      const last = after.at(-1)!
      await waitFor(
        'two late results dropped',
        () => ingestedResults(adminApi, 'dropped'),
        (dropped) => dropped >= droppedBefore + 2 && Date.now() > last.deliverAt + 3000,
        {
          timeoutMs: last.deliverAt - Date.now() + 30_000,
          intervalMs: 1000,
        },
      )
      expect(await docker.mongoCount('analyses', { scanId: scan.id })).toBe(0)
      expect((await getScan(api, scan.id)).state).toBe('deleted')
    },
  )

  test('restart clones the scan with its effective configs, secrets included, and the overrides', { tag: ['@SCAN-035'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.get('lifecycle')
    const secret = unique('secret')
    const original = await scans.start({ revision: revision.ref, name: 'original', taskConfig: { api_token: secret }, scanConfig: { count: 1 } })
    const completed = await scans.wait(original.id, { timeoutMs: 120_000 })

    const response = await scanOps(api).restart(original.id, { name: 'clone', settings: { processes: 2 } })
    expect(response.status).toBe(201)
    const clone = response.body
    scans.track(clone.id)
    expect(clone).toMatchObject({ state: 'creating', round: 1, name: 'clone', clonedFrom: original.id, revision: completed.revision })
    expect(clone.id).not.toBe(original.id)
    expect(clone.taskConfig).toEqual(completed.taskConfig)
    expect(clone.taskConfig.api_token).toBe('***')
    expect(clone.scanConfig).toEqual(completed.scanConfig)
    expect(clone.settings).toEqual({ ...completed.settings, processes: 2 })

    await scans.wait(clone.id, { timeoutMs: 120_000 })
    const rows = ok(await api.queryAnalyses(clone.id, { filter: {}, projection: { result: 1 } }), 'queryAnalyses').items as {
      result: { api_token_sha256: string }
    }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.result.api_token_sha256).toBe(createHash('sha256').update(secret).digest('hex'))

    // The original only gains the scan.restarted event.
    const after = await getScan(api, original.id)
    expect(after).toMatchObject({ state: 'completed', round: 1, completedAt: completed.completedAt, clonedFrom: null })
    const restarted = ok(await scanOps(api).events(original.id, { type: 'scan.restarted' }), 'listScanEvents').items
    expect(restarted.map((event) => event.data)).toEqual([expect.objectContaining({ newScanId: clone.id })])
  })
})

test.describe('pause, resume and scale', () => {
  test(
    'pause drains the workers but keeps the queue and user; resume continues the scheduler with epoch + 1',
    { tag: ['@SCAN-023', '@SCAN-025', '@SCAN-034'] },
    async ({ api, shared, scans }) => {
      const { revision } = await shared.get('lifecycle')
      const total = 20
      // The schedule yields one analysis per second and each run takes 3 s on one runner process: analyses pile up in
      // the queue while the scheduler runs (about 20 s).
      const scan = await scans.start({ revision: revision.ref, taskConfig: { seconds: 3 }, scanConfig: { count: total, item_delay: 1 } })
      const ops = scanOps(api)

      // Pause once an analysis is in flight and the scheduler's checkpoint (every 5 s) shows at least two published
      // analyses that are neither recorded nor in flight: the one runner process holds at most one (prefetch 1), so they
      // wait in the queue, and the drain leaves them there.
      const { inflight } = await waitFor(
        'an analysis in flight and two waiting while the scheduler runs',
        async () => ({
          scan: await getScan(api, scan.id),
          inflight: ok(await ops.inflight(scan.id), 'listInflightAnalyses').items,
          counts: await scans.counts(scan.id),
        }),
        ({ scan: current, inflight: items, counts }) => {
          const recorded = Object.values(counts).reduce((sum, count) => sum + count, 0)
          return current.scheduling.state === 'running' && items.length > 0 && current.scheduling.confirmed - recorded - items.length >= 2
        },
        { timeoutMs: 90_000, intervalMs: 250 },
      )
      // retry-failed is refused while scheduling runs.
      expect(apiErrorOf(await ops.retryFailed(scan.id), 409, 'invalidState').details).toMatchObject({ state: 'running', schedulingState: 'running' })

      const paused = ok(await ops.pause(scan.id), 'pauseScan')
      expect(paused).toMatchObject({ state: 'paused', stateReason: { code: 'user' }, pausedAt: expect.any(String) })
      expect(paused.scheduling.state).not.toBe('done')

      // The workers drain: the in-flight analysis finishes and is recorded, then the containers go; the queue (with its
      // ready messages) and the user stay. The scheduler's final checkpoint records an unfinished prefix.
      await waitContainersGone(scan.id)
      const drained = await waitFor(
        'the in-flight analysis recorded',
        () => analysesOf(api, scan.id),
        (rows) => rows.some((row) => row.seq === inflight[0]!.seq && row.status === 'succeeded'),
        { timeoutMs: 30_000 },
      )
      const queue = await waitFor(
        'no consumer on the paused scan queue',
        () => liveQueue(scan.id),
        (current) => current !== null && current.consumers === 0,
        { timeoutMs: 30_000 },
      )
      expect(queue!.messages_ready).toBeGreaterThan(0)
      expect(await scanUserExists(scan.id)).toBe(true)
      const checkpoint = (await getScan(api, scan.id)).scheduling
      expect(checkpoint.state).toBe('running')
      expect(checkpoint.confirmed).toBeGreaterThan(drained.length)
      expect(checkpoint.confirmed).toBeLessThan(total)
      expect((await getScan(api, scan.id)).state).toBe('paused')

      // Resume: a new scheduler with epoch + 1 continues from the checkpoint; more runner slots finish faster.
      const resumed = ok(await ops.resume(scan.id), 'resumeScan')
      expect(resumed.state).toBe('running')
      ok(await ops.scale(scan.id, { workers: 2, processes: 2 }), 'scaleScan')
      const done = await scans.wait(scan.id, { timeoutMs: 120_000 })
      expect(done.scheduling).toMatchObject({ state: 'done', confirmed: total, epoch: paused.scheduling.epoch + 1 })
      expect(await scans.counts(scan.id)).toEqual({ succeeded: total })
      // Every seq exactly once.
      const seqs = ok(
        await api.aggregateAnalyses(scan.id, [
          { $group: { _id: null, n: { $sum: 1 }, seqs: { $addToSet: '$seq' }, min: { $min: '$seq' }, max: { $max: '$seq' } } },
          { $project: { _id: 0, n: 1, distinct: { $size: '$seqs' }, min: 1, max: 1 } },
        ]),
        'aggregateAnalyses',
      )
      expect(seqs.items).toEqual([{ n: total, distinct: total, min: 0, max: total - 1 }])
    },
  )

  test('scaling applies live: processes in place, workers added and drained', { tag: ['@SCAN-028'] }, async ({ api, docker, shared, scans }) => {
    const { revision } = await shared.get('lifecycle')
    const resources = { cpus: 0.25, memoryMiB: 128 }
    // Enough 6 s analyses to keep every slot busy for the whole test; the teardown cancels the rest.
    const scan = await scans.start({
      revision: revision.ref,
      taskConfig: { seconds: 6 },
      scanConfig: { count: 60 },
      settings: { workers: 1, processes: 1, resources },
    })
    const ops = scanOps(api)
    const runners = async () =>
      ok(await api.listScanWorkers(scan.id, { state: 'running' }), 'listScanWorkers').items.filter((worker) => worker.role === 'runner')
    const consumers = async () => (await scanQueue(scan.id))?.consumers ?? -1
    const applied = (list: Worker[], count: number, processes: number) =>
      list.length === count && list.every((worker) => worker.processes.applied === processes)

    const [first] = await waitFor('one runner with one process', runners, (list) => applied(list, 1, 1), { timeoutMs: 90_000 })
    await waitFor('one consumer', consumers, (count) => count === 1, { timeoutMs: 30_000 })

    // processes 1 → 2: applied in place with the new limits.
    ok(await ops.scale(scan.id, { processes: 2 }), 'scaleScan')
    const [resized] = await waitFor('two processes applied', runners, (list) => applied(list, 1, 2), { timeoutMs: 60_000 })
    expect(resized!.id).toBe(first!.id)
    expect(resized!.container?.id).toBe(first!.container?.id)
    const limits = await docker.inspect<{ HostConfig: { Memory: number; NanoCpus: number } }>(resized!.container!.id)
    expect(limits.HostConfig.Memory).toBe((2 * resources.memoryMiB + 256) * 1024 * 1024)
    expect(limits.HostConfig.NanoCpus).toBe(2 * resources.cpus * 1e9)
    await waitFor('two consumers', consumers, (count) => count === 2, { timeoutMs: 30_000 })

    // workers 1 → 2: a second runner container.
    ok(await ops.scale(scan.id, { workers: 2 }), 'scaleScan')
    await waitFor('two runners with two processes', runners, (list) => applied(list, 2, 2), { timeoutMs: 90_000 })
    await waitFor('four consumers', consumers, (count) => count === 4, { timeoutMs: 30_000 })

    // workers 2 → 1: one runner drains after its in-flight analyses and is removed.
    ok(await ops.scale(scan.id, { workers: 1 }), 'scaleScan')
    await waitFor('one runner left', runners, (list) => applied(list, 1, 2), { timeoutMs: 60_000 })
    await waitFor('two consumers again', consumers, (count) => count === 2, { timeoutMs: 60_000 })
    expect(await eventTypes(api, scan.id, 'scan.scaled')).toHaveLength(3)
    expect((await getScan(api, scan.id)).state).toBe('running')
  })

  test(
    'scaling beyond node capacity leaves the extra workers pending with insufficientCapacity',
    { tag: ['@SCAN-029'] },
    async ({ api, adminApi, shared, scans }) => {
      // Per-process resources at the static maximum, which no node of the default pool can hold: the scan needs node
      // capacity it never gets, so the test reserves nothing on the shared built-in node.
      const resources = { cpus: 64, memoryMiB: 65_536 }
      const nodes = ok(await adminApi.listNodes({ pool: 'shared', state: 'online' }), 'listNodes').items
      expect(nodes.length).toBeGreaterThan(0)
      for (const node of nodes) {
        const fits = node.info !== null && node.info.cpus >= resources.cpus && node.info.memoryBytes >= (resources.memoryMiB + 256) * 1024 * 1024
        expect(fits, `node ${node.name} holds a worker of ${JSON.stringify(resources)}`).toBe(false)
      }

      const { revision } = await shared.get('lifecycle')
      const scan = await scans.start({ revision: revision.ref, settings: { workers: 1, processes: 1, resources } })
      const ops = scanOps(api)
      const pendingCondition = async () =>
        ok(await ops.conditions(scan.id), 'listScanConditions').items.find((condition) => condition.type === 'workersPending') ?? null
      const pendingCount = (condition: Awaited<ReturnType<typeof pendingCondition>>) => (condition?.details as { count?: number } | undefined)?.count

      // The scheduler and the one runner cannot be placed.
      const before = await waitFor('two workers pending for capacity', pendingCondition, (condition) => pendingCount(condition) === 2, { timeoutMs: 60_000 })
      expect(before).toMatchObject({ severity: 'warning', reason: 'insufficientCapacity', details: { count: 2, reasons: { insufficientCapacity: 2 } } })

      // Scaling to two runners adds one more pending worker for the same reason.
      expect(ok(await ops.scale(scan.id, { workers: 2 }), 'scaleScan').settings.workers).toBe(2)
      const after = await waitFor('three workers pending for capacity', pendingCondition, (condition) => pendingCount(condition) === 3, { timeoutMs: 60_000 })
      expect(after).toMatchObject({
        reason: 'insufficientCapacity',
        message: expect.stringContaining('3 workers cannot be placed'),
        details: { count: 3, reasons: { insufficientCapacity: 3 } },
      })

      const workers = ok(await api.listScanWorkers(scan.id), 'listScanWorkers').items
      expect(workers.map((worker) => worker.role).sort()).toEqual(['runner', 'runner', 'scheduler'])
      for (const worker of workers) expect(worker).toMatchObject({ state: 'pending', nodeId: null, stateReason: { code: 'insufficientCapacity' } })
      expect((await getScan(api, scan.id)).workers).toMatchObject({ desired: 3, active: 0, pending: 3 })
      const pendingEvents = ok(await ops.events(scan.id, { type: 'worker.pending' }), 'listScanEvents').items
      expect(pendingEvents.map((event) => event.data)).toContainEqual({ reason: 'insufficientCapacity' })
    },
  )
})

test.describe('retry-failed', () => {
  test(
    'retry-failed reruns lost analyses that kept their config; a paused scan keeps its delayed retries',
    { tag: ['@SCAN-032', '@SCAN-023'] },
    async ({ api, shared, scans }) => {
      const { revision } = await shared.get('lifecycle')
      const ops = scanOps(api)
      const total = 3
      // Each attempt asks for a retry in an hour, so every analysis waits as a delayed message.
      const scan = await scans.start({
        revision: revision.ref,
        taskConfig: { mode: 'retry', retry_delay: 3600 },
        scanConfig: { count: total },
        settings: { ...SMALL_SETTINGS, maxAttempts: 3, backoff: { initialMs: 1000, factor: 2, maxMs: 7_200_000 } },
      })
      const everyRetrying = (round: number) =>
        waitFor(
          `every analysis retrying in round ${round}`,
          async () => ({ scan: await getScan(api, scan.id), analyses: await analysesOf(api, scan.id) }),
          ({ scan: current, analyses }) =>
            current.state === 'running' &&
            current.scheduling.state === 'done' &&
            analyses.length === total &&
            analyses.every((analysis) => analysis.status === 'retrying' && analysis.round === round),
          { timeoutMs: 90_000, intervalMs: 1000 },
        )
      await everyRetrying(1)

      // Paused, the scan keeps its queue with the delayed retries and its user.
      ok(await ops.pause(scan.id), 'pauseScan')
      await waitContainersGone(scan.id)
      await waitQueue(scan.id, 'the delayed retries in the paused scan queue', (queue) => queue.consumers === 0 && queue.messagesDelayed === total)
      expect(await scanUserExists(scan.id)).toBe(true)
      ok(await ops.resume(scan.id), 'resumeScan')

      // The delayed messages are purged, so stall detection records the retrying analyses as lost (they keep their
      // config).
      await purgeOwnScanQueue(scan.id)
      const stalled = await scans.wait(scan.id, { timeoutMs: 120_000 })
      expect(stalled).toMatchObject({ state: 'completed', stateReason: { code: 'stalled' } })
      expect(stalled.conditions.map((condition) => condition.type)).toContain('stalled')
      for (const analysis of await analysesOf(api, scan.id)) expect(analysis).toMatchObject({ status: 'lost', round: 1, config: { value: analysis.seq } })

      // Round 2 runs every lost analysis again; its attempts history spans both rounds.
      const retry = ok(await ops.retryFailed(scan.id), 'retryFailedAnalyses')
      expect(retry.scan).toMatchObject({ state: 'running', round: 2, completedAt: null, scheduling: { state: 'retrying' } })
      const second = await everyRetrying(2)
      for (const analysis of second.analyses) {
        expect(analysis).toMatchObject({ status: 'retrying', round: 2, config: { value: analysis.seq } })
        expect(rounds(analysis.attempts)).toEqual([1, 2])
      }
    },
  )

  test('cancelling during an active retry cancels its job and restores the scheduling state', { tag: ['@SCAN-031'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.get('lifecycle')
    const scan = await scans.start({ revision: revision.ref, taskConfig: { mode: 'fatal' }, scanConfig: { count: 3 } })
    await scans.wait(scan.id, { timeoutMs: 120_000 })
    expect(await scans.counts(scan.id)).toEqual({ failed: 3 })

    const retry = ok(await scanOps(api).retryFailed(scan.id), 'retryFailedAnalyses')
    expect(retry.scan.scheduling.state).toBe('retrying')
    const cancelled = ok(await api.cancelScan(scan.id), 'cancelScan')
    expect(cancelled).toMatchObject({ state: 'cancelled', scheduling: { state: 'done' } })
    const job = await waitForJob(api, retry.job.id, 60_000)
    expect(job.state).toBe('cancelled')
    expect((await getScan(api, scan.id)).scheduling.state).toBe('done')
  })

  test(
    'a retry round started right after the round before completes as soon as its last result is ingested',
    { tag: ['@SCAN-040', '@SCAN-032'] },
    async ({ api, shared, scans }) => {
      const { revision } = await shared.get('lifecycle')
      const scan = await scans.start({ revision: revision.ref, taskConfig: { mode: 'fatal' }, scanConfig: { count: 3 } })
      await scans.wait(scan.id, { timeoutMs: 120_000 })
      expect(await scans.counts(scan.id)).toEqual({ failed: 3 })

      // Round 2 starts at once, so its results usually arrive within 10 s of the ingestor's completion of round 1:
      // completing it must not wait for the reconciler's 60 s recount (docs/queue.md §6.9).
      ok(await scanOps(api).retryFailed(scan.id), 'retryFailedAnalyses')
      const done = await scans.wait(scan.id, { timeoutMs: 120_000 })
      expect(done).toMatchObject({ state: 'completed', round: 2 })
      const analyses = await allAnalyses(api, scan.id)
      expect(analyses.map((analysis) => [analysis.status, analysis.round])).toEqual([
        ['failed', 2],
        ['failed', 2],
        ['failed', 2],
      ])
      const lastIngested = Math.max(...analyses.map((analysis) => Date.parse(analysis.updatedAt)))
      expect(Date.parse(done.completedAt!) - lastIngested).toBeLessThan(10_000)
    },
  )

  test(
    'retry-failed of a cancelled scan records the never-run analyses as cancelled and reruns only the failed ones',
    { tag: ['@SCAN-032', '@SCAN-033'] },
    async ({ api, shared, scans }) => {
      const { revision } = await shared.get('lifecycle')
      const total = 8
      const scan = await scans.start({ revision: revision.ref, taskConfig: { mode: 'fatal', seconds: 2 }, scanConfig: { count: total } })

      await waitFor(
        'two failed analyses with scheduling done',
        async () => ({ scan: await getScan(api, scan.id), counts: await scans.counts(scan.id) }),
        ({ scan: current, counts }) => current.scheduling.state === 'done' && (counts.failed ?? 0) >= 2,
        { timeoutMs: 90_000 },
      )
      ok(await api.cancelScan(scan.id), 'cancelScan')
      await waitForBrokerCleanup(scan.id)

      const retry = await scanOps(api).retryFailed(scan.id)
      expect(retry.status).toBe(202)
      expect(retry.body.job).toMatchObject({ kind: 'scanRetryFailed' })
      expect(retry.body.scan).toMatchObject({ state: 'running', round: 2, completedAt: null, scheduling: { state: 'retrying' } })

      const done = await scans.wait(scan.id, { timeoutMs: 120_000 })
      expect(done).toMatchObject({ state: 'completed', round: 2 })
      expect((await waitForJob(api, retry.body.job.id, 30_000)).state).toBe('succeeded')

      const analyses = await analysesOf(api, scan.id)
      expect(analyses.map((analysis) => analysis.seq)).toEqual(Array.from({ length: total }, (_, seq) => seq))
      const failed = analyses.filter((analysis) => analysis.status === 'failed')
      const cancelledOnes = analyses.filter((analysis) => analysis.status === 'cancelled')
      expect(failed.length).toBeGreaterThanOrEqual(2)
      expect(cancelledOnes.length).toBeGreaterThanOrEqual(1)
      expect(failed.length + cancelledOnes.length).toBe(total)
      for (const analysis of failed) {
        expect(analysis.round).toBe(2)
        expect(rounds(analysis.attempts)).toEqual([1, 2])
      }
      for (const analysis of cancelledOnes) {
        expect(analysis.round).toBe(1)
        expect(rounds(analysis.attempts)).not.toContain(2)
      }
      expect(await scans.counts(scan.id)).toEqual({ failed: failed.length, cancelled: cancelledOnes.length })
    },
  )
})

test.describe('progress', () => {
  test(
    'progress follows the expected total, with percent and ETA while running, also in scans watch; a custom schedule has none until it is done',
    { tag: ['@SCAN-011', '@SCAN-016'] },
    async ({ api, user, shared, scans }) => {
      const [sleepTask, lifecycle] = await Promise.all([shared.get('sleep'), shared.get('lifecycle')])
      const total = 5
      // Both scans run at once: the template scan (repeat) and a custom schedule that yields one analysis per second.
      const scan = await scans.start({ revision: sleepTask.revision.ref, taskConfig: { seconds: 2 }, scanConfig: { times: total } })
      const custom = await scans.start({ revision: lifecycle.revision.ref, scanConfig: { count: 4, item_delay: 1 } })
      const watch = scantor(['scans', 'watch', scan.id, '-o', 'json', '--interval', '1s'], { token: user.apiKey, timeoutMs: 150_000 })
      const sampleUntilCompleted = async (scanId: string) => {
        const samples: Scan[] = []
        await waitFor(
          `scan ${scanId} completed`,
          async () => {
            const current = await getScan(api, scanId)
            samples.push(current)
            return current
          },
          (current) => current.state === 'completed',
          { timeoutMs: 120_000, intervalMs: 500 },
        )
        return samples
      }
      const [samples, customSamples] = await Promise.all([sampleUntilCompleted(scan.id), sampleUntilCompleted(custom.id)])

      const done = samples.at(-1)!
      for (const sample of samples) {
        expect(sample.stats.expectedTotal).toBe(total)
        expect(sample.progress.total).toBe(total)
      }
      const percents = samples.map((sample) => sample.progress.percent ?? 0)
      expect(percents).toEqual([...percents].sort((a, b) => a - b))
      const live = samples.filter((sample) => sample.state === 'running' && sample.stats.ratePerMin > 0 && sample.progress.terminal < total)
      expect(live.length, JSON.stringify(samples.map((sample) => sample.progress))).toBeGreaterThan(0)
      for (const sample of live) {
        expect(sample.progress.percent).toBeGreaterThanOrEqual(0)
        expect(sample.progress.percent).toBeLessThan(100)
        expect(sample.progress.etaSeconds).toEqual(expect.any(Number))
      }
      for (const sample of samples.filter((sample) => sample.state !== 'running' || sample.stats.ratePerMin === 0))
        expect(sample.progress.etaSeconds).toBeNull()
      expect(done.progress).toEqual({ scheduled: total, terminal: total, total, percent: 100, etaSeconds: null })

      const watched = await watch
      expect(watched.exitCode, watched.stderr).toBe(0)
      const lines = (Array.isArray(watched.json) ? watched.json : [watched.json]) as Scan[]
      expect(lines.length).toBeGreaterThan(1)
      const watchedPercents = lines.map((line) => line.progress.percent ?? 0)
      expect(watchedPercents).toEqual([...watchedPercents].sort((a, b) => a - b))
      expect(new Set(watchedPercents).size).toBeGreaterThan(1)
      expect(lines.some((line) => line.state === 'running' && typeof line.progress.etaSeconds === 'number')).toBe(true)
      expect(lines.at(-1)).toMatchObject({ state: 'completed', progress: { percent: 100, terminal: total, total } })

      // The custom schedule: no total while it schedules, then the confirmed count.
      const customDone = customSamples.at(-1)!
      const scheduling = customSamples.filter((sample) => sample.scheduling.state === 'pending' || sample.scheduling.state === 'running')
      expect(scheduling.length).toBeGreaterThan(0)
      for (const sample of scheduling) expect(sample.progress).toMatchObject({ total: null, percent: null, etaSeconds: null })
      expect(customDone.stats.expectedTotal).toBeNull()
      expect(customDone.progress).toEqual({ scheduled: 4, terminal: 4, total: 4, percent: 100, etaSeconds: null })
    },
  )
})

test.describe('broker topology and completion', () => {
  test(
    'a scan gets its queue and RabbitMQ user before it runs and loses them, user first, when it completes',
    { tag: ['@ING-002', '@ING-003', '@SCAN-040'] },
    async ({ api, shared, scans }) => {
      const { revision } = await shared.get('lifecycle')
      const scan = await scans.start({ revision: revision.ref, taskConfig: { seconds: 4 }, scanConfig: { count: 2 } })
      expect(scan).toMatchObject({ state: 'creating', startedAt: null })
      const limits = scanLimits()

      const running = await waitFor(
        'the scan running',
        () => getScan(api, scan.id),
        (current) => current.state !== 'creating',
        { timeoutMs: 60_000, intervalMs: 100 },
      )
      expect(running.state).toBe('running')
      expect(running.startedAt).not.toBeNull()
      const [queue, bindings, userExists, permissions, topic] = await Promise.all([
        scanQueue(scan.id),
        scanQueueBindings(scan.id),
        scanUserExists(scan.id),
        scanUserPermissions(scan.id),
        scanUserTopicPermissions(scan.id),
      ])
      expect(queue).toMatchObject({ type: 'quorum' })
      expect(queue!.arguments).toMatchObject({
        'x-queue-type': 'quorum',
        'x-delivery-limit': limits.deliveryLimit,
        'x-dead-letter-exchange': 'scantor.dead',
        'x-dead-letter-strategy': 'at-least-once',
        'x-overflow': 'reject-publish',
        'x-max-length': limits.scanQueueMaxReady,
      })
      expect(bindings).toEqual([{ source: 'scantor.analyses', routingKey: scan.id }])
      expect(userExists).toBe(true)
      expect(permissions).toEqual([
        expect.objectContaining({ vhost: 'scantor', configure: '^$', write: '^scantor\\.(analyses|results)$', read: `^scantor\\.scan\\.${scan.id}$` }),
      ])
      expect(topic.map((entry) => entry.exchange).sort()).toEqual(['scantor.analyses', 'scantor.results'])
      for (const entry of topic) expect(entry).toMatchObject({ write: `^${scan.id}$`, read: '^$' })

      // Completion: exact stats, then the user and the queue are removed (user first) and the workers go.
      const done = await scans.wait(scan.id, { timeoutMs: 120_000 })
      expectUserRemovedFirst(await waitForBrokerCleanup(scan.id))
      expect(done).toMatchObject({ state: 'completed', stateReason: { code: 'completed' }, completedAt: expect.any(String) })
      expect(done.scheduling).toMatchObject({ state: 'done', error: null, confirmed: 2 })
      expect(done.stats).toMatchObject({ succeeded: 2, failed: 0, lost: 0, cancelled: 0, pending: 0, retrying: 0 })
      expect(await scans.counts(scan.id)).toEqual({ succeeded: 2 })
      await waitContainersGone(scan.id)
    },
  )

  test(
    'a scan whose schedule fails ends failed with schedulingFailed once its published analyses are final',
    { tag: ['@SCAN-040', '@SCAN-018'] },
    async ({ api, shared, scans }) => {
      const { revision } = await shared.get('lifecycle')
      // Two analyses are published, then the schedule raises scantor.Fatal (no scheduler restarts).
      const scan = await scans.start({ revision: revision.ref, taskConfig: { seconds: 1 }, scanConfig: { count: 2, fail: 'fatal' } })
      const failed = await scans.wait(scan.id, { state: 'failed', timeoutMs: 120_000 })
      expect(failed).toMatchObject({ stateReason: { code: 'schedulingFailed' }, completedAt: expect.any(String) })
      expect(failed.scheduling).toMatchObject({ state: 'failed', confirmed: 2, error: { message: expect.stringContaining('failed on purpose') } })
      expect(failed.stats).toMatchObject({ succeeded: 2, failed: 0, pending: 0, retrying: 0 })
      expect(await scans.counts(scan.id)).toEqual({ succeeded: 2 })
      const conditions = ok(await scanOps(api).conditions(scan.id), 'listScanConditions').items
      expect(conditions.find((condition) => condition.type === 'schedulingFailed')).toMatchObject({ severity: 'error' })
      expectUserRemovedFirst(await waitForBrokerCleanup(scan.id))
    },
  )

  test('orphan scan users and queues are removed within a reconciler tick', { tag: ['@ING-003'] }, async () => {
    const orphan = randomUUID()
    await createOrphanScanObjects(orphan, randomBytes(16).toString('hex'))
    expect(await scanBrokerObjects(orphan)).toEqual({ queue: true, user: true })
    await waitFor(
      'the orphan user and queue removed',
      () => scanBrokerObjects(orphan),
      (observed) => !observed.queue && !observed.user,
      { timeoutMs: 45_000 },
    )
  })
})
