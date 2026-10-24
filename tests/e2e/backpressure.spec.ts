import type { Analysis } from '#shared/types/analyses'
import type { Scan } from '#shared/types/scans'
import { stackEnv } from '../helpers/docker'
import { allAnalyses, backoff, findCondition, pollScan, scanQueue, schedulerNacks, settings, sleep, type ScanQueue } from '../helpers/e2e-runtime'
import { extendRuntime } from '../helpers/e2e-runtime-fixtures'
import { TERMINAL_STATES } from '../helpers/scans'
import type { ProbeConfig } from '../helpers/e2e-runtime-tasks'
import { expect, test as base } from '../fixtures'

// Scheduler backpressure end to end (docs/runtime.md §8.11, §11.4; docs/queue.md §3.3, §10): the scan queue holds at
// most SCANTOR_SCAN_QUEUE_MAX_READY messages (500 on the test stack, reject-publish); the scheduler's refused
// publishes are retried until the runners make room, so a scan far larger than the limit still ends with exact
// counts, and a full queue never loses or fails a retry (a refused retry is held by its runner). The tasks are
// published once per run (helpers/e2e-runtime-fixtures.ts).

const test = extendRuntime(base)

test.describe.configure({ timeout: 180_000 })

test.beforeAll(async ({ shared }) => {
  // Publishing builds images; the stack builds at most SCANTOR_BUILD_CONCURRENCY of them at a time for every user.
  test.setTimeout(300_000)
  await Promise.all([shared.generated('wrap'), shared.generated('probe')])
})

const MAX_READY = 500

/** Samples the scan's queue and the publishes the broker refused its scheduler, every second until `done` resolves. */
function observeQueue(scanId: string, done: Promise<unknown>) {
  const samples: { at: number; queue: ScanQueue | null; nacks: number | null }[] = []
  let finished = false
  void done.finally(() => {
    finished = true
  })
  const sampling = (async () => {
    while (!finished) {
      const [queue, nacks] = await Promise.all([scanQueue(scanId), schedulerNacks(scanId)])
      samples.push({ at: Date.now(), queue, nacks })
      await sleep(1000)
    }
  })()
  return { samples, sampling }
}

/** The workerErrors condition of a scan whose runners could not publish (for example a refused retry). */
const workerErrors = (scan: Scan) => findCondition(scan, 'workerErrors')

test.describe('backpressure', () => {
  test(
    'a 20 000-analysis scan completes through a queue of at most 500 ready messages with exact counts',
    { tag: ['@SCHED-005'] },
    async ({ api, shared, scans }) => {
      // The documented case: 20 000 analyses through a queue of 500 take a minute or two.
      test.setTimeout(360_000)
      expect(stackEnv().SCANTOR_SCAN_QUEUE_MAX_READY).toBe(String(MAX_READY))
      // wrap: a custom schedule that wraps the range template, like the power example; 4 process slots work through
      // the analyses.
      const { revision } = await shared.generated('wrap')
      const scan = await scans.start({
        revision: revision.ref,
        scanConfig: { start: 0, end: 20_000 },
        settings: settings({ workers: 2, processes: 2, resources: { cpus: 0.5, memoryMiB: 128 } }),
      })
      const completed = scans.wait(scan.id, { timeoutMs: 330_000 })
      const { samples, sampling } = observeQueue(scan.id, completed)
      const final = await completed
      await sampling
      await test.info().attach('queue samples [at, ready, nacks]', {
        body: JSON.stringify(samples.map((s) => [s.at, s.queue?.messages_ready ?? null, s.nacks])),
        contentType: 'application/json',
      })

      // The queue is declared with the limit and reject-publish, and the scheduler ran into it.
      const declared = samples.find((s) => s.queue !== null)?.queue
      expect(declared?.arguments).toMatchObject({ 'x-max-length': MAX_READY, 'x-overflow': 'reject-publish', 'x-queue-type': 'quorum' })
      // The runners empty the queue while the scheduler waits after a refusal, so the sampled ready count (the broker
      // refreshes it every 5 s) need not show the limit; the refused publishes do. Quorum queues may accept the
      // publishes already in flight to the leader: at most one scheduler window above the limit.
      const ready = samples.map((s) => s.queue?.messages_ready ?? 0)
      expect(Math.max(...ready)).toBeLessThanOrEqual(MAX_READY + 512)
      const nacks = Math.max(0, ...samples.map((s) => s.nacks ?? 0))
      expect(nacks, 'publishes of the scheduler refused by the full queue').toBeGreaterThan(0)

      expect(final.scheduling).toMatchObject({ state: 'done', confirmed: 20_000, restarts: 0 })
      expect(await scans.counts(scan.id)).toEqual({ succeeded: 20_000 })
      const analyses = await allAnalyses(api, scan.id, ['config', 'result'])
      expect(analyses).toHaveLength(20_000)
      expect(analyses.every((a, i) => a.seq === i && (a.config as { value: number }).value === i)).toBe(true)
      expect(analyses.every((a) => (a.result as { value: number }).value === a.seq)).toBe(true)
    },
  )

  test('retries are neither lost nor failed while the queue is full', { tag: ['@SCHED-005', '@RT-018'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.generated('probe')
    // 1000 analyses of 50 ms: the scheduler fills the queue at once. Every 100th analysis fails its first attempt and
    // is republished with a 1 s delay while the queue is full.
    const failing = Array.from({ length: 10 }, (_, i) => i * 100)
    const taskConfig: ProbeConfig = { mode: 'flaky', fail_attempts: 1, iterations: failing, others: 'sleep', seconds: 0.05 }
    const scan = await scans.start({
      revision: revision.ref,
      taskConfig: { ...taskConfig },
      scanConfig: { times: 1000 },
      settings: settings({ processes: 2, maxAttempts: 2, backoff: backoff(1000) }),
    })
    const completed = pollScan(api, scan.id, (s) => TERMINAL_STATES.includes(s.state) || workerErrors(s) !== undefined, {
      what: 'the scan completed or a runner reported errors',
      timeoutMs: 150_000,
      intervalMs: 1000,
    })
    const { samples, sampling } = observeQueue(scan.id, completed)
    const settled = await completed
    await sampling
    // A full queue refuses future-dated publishes too; a refused retry is backpressure, not a worker error.
    expect(workerErrors(settled), JSON.stringify(workerErrors(settled))).toBeUndefined()
    expect(settled.state).toBe('completed')
    expect(Math.max(...samples.map((s) => s.queue?.messages_ready ?? 0)), 'the queue filled up').toBeGreaterThanOrEqual(MAX_READY - 50)

    expect(await scans.counts(scan.id)).toEqual({ succeeded: 1000 })
    const retried: Analysis[] = (await allAnalyses(api, scan.id, ['attempt', 'attempts', 'status'])).filter((a) => a.attempt > 1)
    expect(retried.map((a) => a.seq)).toEqual(failing)
    expect(retried.every((a) => a.attempts.length === 2 && a.attempts[0]!.error?.type === 'taskError')).toBe(true)
    expect(settled.scheduling.confirmed).toBe(1000)
  })
})
