import type { Scan } from '#shared/types/scans'
import type { Worker } from '#shared/types/workers'
import { ok, type ApiClient } from '../helpers/api-client'
import {
  allAnalyses,
  backoff,
  connectorProcesses,
  containerProcesses,
  findCondition,
  getScan,
  pollScan,
  pollUntil,
  scanEvents,
  scanQueue,
  scanWorkers,
  settings,
  workerContainers,
} from '../helpers/e2e-runtime'
import { extendRuntime } from '../helpers/e2e-runtime-fixtures'
import { TERMINAL_STATES } from '../helpers/scans'
import { expect, test as base } from '../fixtures'

// The scheduler end to end (docs/runtime.md §11; docs/templates.md §2–§3; docs/architecture.md §11.2): unwrapped
// templates run natively without a connector process, custom schedules in exactly one; scheduling ends `done` and
// the scheduler is drained and removed; a pause during backpressure resumes from the checkpoint with epoch + 1 and
// exact results; retryable schedule errors restart the scheduler up to SCANTOR_SCHEDULER_MAX_RESTARTS, Fatal fails
// scheduling at once. The tasks are published once per run (helpers/e2e-runtime-fixtures.ts): the `probe` passes the
// template repeat unwrapped and sleeps as its task config says, `wrap` is a custom schedule around the range template.

const test = extendRuntime(base)

test.describe.configure({ timeout: 180_000 })

test.beforeAll(async ({ shared }) => {
  // Publishing builds images; the stack builds at most SCANTOR_BUILD_CONCURRENCY of them at a time for every user.
  test.setTimeout(300_000)
  await Promise.all([shared.generated('probe'), shared.generated('wrap'), shared.example('throws')])
})

/** The scheduler worker of the scan's current epoch once its container runs (the runtime bootstrapped). */
async function runningScheduler(api: ApiClient, scanId: string): Promise<{ worker: Worker; container: string }> {
  const found = await pollUntil(
    'a running scheduler worker with a container',
    async () => {
      const scheduler = (await scanWorkers(api, scanId)).find((w) => w.role === 'scheduler' && w.state === 'running')
      if (!scheduler) return null
      const [container] = await workerContainers(scanId, { workerId: scheduler.id })
      return container ? { worker: scheduler, container } : null
    },
    (value) => value !== null,
    { timeoutMs: 90_000, intervalMs: 500 },
  )
  return found!
}

test.describe('native and connector schedules', () => {
  test('an unwrapped template runs in the scheduler without a connector process', { tag: ['@SCHED-001'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.generated('probe')
    expect(revision.description?.schedule).toEqual({ kind: 'template', template: 'repeat' })
    // 900 analyses of 1 s on one process: the queue limit (500) keeps the scheduler alive while it waits for room.
    const scan = await scans.start({ revision: revision.ref, scanConfig: { times: 900 }, taskConfig: { mode: 'sleep', seconds: 1 } })
    const { container } = await runningScheduler(api, scan.id)
    await pollScan(api, scan.id, (s) => s.scheduling.confirmed > 0, { what: 'items published', intervalMs: 500 })
    const processes = await containerProcesses(container)
    expect(
      processes.some((p) => p.cmdline.includes('scantor runtime worker')),
      JSON.stringify(processes),
    ).toBe(true)
    expect(
      processes.filter((p) => p.cmdline.includes('scantor.serve')),
      JSON.stringify(processes),
    ).toEqual([])
    expect((await getScan(api, scan.id)).scheduling.state).toBe('running')
  })

  test('a custom schedule runs in exactly one connector process that streams the items', { tag: ['@SCHED-001'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.generated('wrap')
    expect(revision.description?.schedule).toEqual({ kind: 'custom' })
    // 200 items, 0.5 s apart: the schedule streams for well over a minute.
    const scan = await scans.start({ revision: revision.ref, scanConfig: { end: 200, item_delay: 0.5 } })
    const { container } = await runningScheduler(api, scan.id)
    const streaming = await pollScan(api, scan.id, (s) => s.scheduling.confirmed >= 3, { what: 'items streaming', intervalMs: 500 })
    expect(streaming.scheduling.state).toBe('running')
    expect(await connectorProcesses(container)).toHaveLength(1)
    // Items keep arriving from that one process.
    await pollScan(api, scan.id, (s) => s.scheduling.confirmed >= streaming.scheduling.confirmed + 3, { what: 'more items', intervalMs: 500 })
    expect(await connectorProcesses(container)).toHaveLength(1)
  })
})

test.describe('end of scheduling', () => {
  test(
    'when every item is confirmed, scheduling is done and the scheduler is drained and removed',
    { tag: ['@SCHED-006', '@NODE-028'] },
    async ({ api, shared, scans }) => {
      const { revision } = await shared.generated('probe')
      // The runner is still busy (5 s per analysis) when scheduling is done, so the scan keeps running.
      const scan = await scans.start({ revision: revision.ref, scanConfig: { times: 3 }, taskConfig: { mode: 'sleep', seconds: 5 } })
      const done = await pollScan(api, scan.id, (s) => s.scheduling.state === 'done', { what: 'scheduling done', timeoutMs: 90_000, intervalMs: 500 })
      expect(done.scheduling).toMatchObject({ state: 'done', confirmed: 3, error: null })
      expect(done.scheduling.doneAt).not.toBeNull()
      expect(done.state).toBe('running')

      const scheduler = await pollUntil(
        'the scheduler worker stopped',
        async () => (await scanWorkers(api, scan.id)).find((w) => w.role === 'scheduler'),
        (worker) => worker?.state === 'stopped',
        { timeoutMs: 90_000, intervalMs: 500 },
      )
      expect(scheduler!.stoppedAt).not.toBeNull()
      // Its container is gone, not merely stopped.
      expect(await workerContainers(scan.id, { workerId: scheduler!.id, all: true })).toEqual([])
      const types = (await scanEvents(api, scan.id)).filter((e) => e.workerId === scheduler!.id || e.type === 'scan.schedulingDone').map((e) => e.type)
      expect(types).toEqual(expect.arrayContaining(['scan.schedulingDone', 'worker.placed', 'worker.stopped']))
      // The runner keeps working and the scan completes with all three analyses.
      await scans.wait(scan.id, { timeoutMs: 120_000 })
      expect(await scans.counts(scan.id)).toEqual({ succeeded: 3 })
    },
  )
})

test.describe('checkpoint and resume', () => {
  test(
    'a scan paused during backpressure resumes from its checkpoint with epoch + 1 and exact results',
    { tag: ['@SCHED-003', '@SCHED-005'] },
    async ({ api, shared, scans }) => {
      const { revision } = await shared.generated('probe')
      // 700 analyses of 50 ms on one process: the scheduler reaches the queue limit (500) at once and stays in
      // backpressure while the runner works through the queue, so it is still publishing when the scan is paused.
      const scan = await scans.start({
        revision: revision.ref,
        scanConfig: { times: 700 },
        taskConfig: { mode: 'sleep', seconds: 0.05 },
        settings: settings({ resources: { cpus: 0.1, memoryMiB: 128 } }),
      })
      await pollUntil(
        'a full scan queue',
        () => scanQueue(scan.id),
        (queue) => queue !== null && queue.messages_ready + queue.messages_unacknowledged >= 480,
        { timeoutMs: 120_000, intervalMs: 250 },
      )
      const full = await getScan(api, scan.id)
      expect(full.scheduling.state).toBe('running')
      expect(full.scheduling.confirmed).toBeLessThan(700)
      ok(await api.call<Scan>('pauseScan', { path: { scanId: scan.id } }), 'pauseScan')

      // The scheduler drains with a final checkpoint and stops; the runner drains too.
      await pollUntil(
        'every worker stopped',
        () => scanWorkers(api, scan.id),
        (workers) => workers.length > 0 && workers.every((w) => w.state === 'stopped'),
        { timeoutMs: 90_000, intervalMs: 500 },
      )
      const paused = await getScan(api, scan.id)
      expect(paused.state).toBe('paused')
      expect(paused.scheduling.state).toBe('running')
      expect(paused.scheduling.confirmed).toBeLessThan(700)
      expect(paused.scheduling.tailHash).toMatch(/^sha256:[0-9a-f]{64}$/)

      // Two runners with two processes each finish the rest quickly after the resume.
      ok(await api.call<Scan>('scaleScan', { path: { scanId: scan.id }, body: { workers: 2, processes: 2 } }), 'scaleScan')
      ok(await api.call<Scan>('resumeScan', { path: { scanId: scan.id } }), 'resumeScan')
      const resumed = await pollScan(api, scan.id, (s) => s.scheduling.confirmed > paused.scheduling.confirmed, {
        what: 'publishing resumed',
        timeoutMs: 120_000,
        intervalMs: 500,
      })
      expect(resumed.scheduling.epoch).toBe(paused.scheduling.epoch + 1)
      const completed = await scans.wait(scan.id, { timeoutMs: 150_000 })
      expect(completed.scheduling).toMatchObject({ state: 'done', confirmed: 700, epoch: paused.scheduling.epoch + 1, restarts: 0 })
      expect(await scans.counts(scan.id)).toEqual({ succeeded: 700 })
      const analyses = await allAnalyses(api, scan.id, ['config'])
      expect(analyses.map((a) => a.seq)).toEqual(Array.from({ length: 700 }, (_, i) => i))
      expect(analyses.every((a) => (a.config as { iteration: number }).iteration === a.seq)).toBe(true)
      const schedulers = (await scanWorkers(api, scan.id)).filter((w) => w.role === 'scheduler').map((w) => w.epoch)
      expect(schedulers.sort()).toEqual([paused.scheduling.epoch, paused.scheduling.epoch + 1])
    },
  )
})

test.describe('schedule errors', () => {
  test(
    'a retryable schedule error restarts the scheduler until SCANTOR_SCHEDULER_MAX_RESTARTS, then scheduling fails',
    { tag: ['@SCHED-008'] },
    async ({ api, shared, scans }) => {
      const { revision } = await shared.example('throws')
      const scan = await scans.start({ revision: revision.ref, taskConfig: { mode: 'ok', fail_in_schedule: true }, scanConfig: { start: 0, end: 5 } })
      // Restarts are counted while the scheduler retries in place.
      const restarting = await pollScan(api, scan.id, (s) => s.scheduling.restarts >= 1, { what: 'a restart', intervalMs: 250 })
      expect(restarting.scheduling.state).toBe('running')

      const failed = await scans.wait(scan.id, { state: 'failed', timeoutMs: 120_000 })
      expect(failed.scheduling).toMatchObject({ state: 'failed', restarts: 4, confirmed: 0 })
      expect(failed.scheduling.error).toMatchObject({ phase: 'schedule', retryable: false, type: 'taskError' })
      expect(failed.scheduling.error?.message).toMatch(/^scheduling failed after 4 restarts \(SCANTOR_SCHEDULER_MAX_RESTARTS=3\): /)
      expect(failed.scheduling.error?.message).toContain('demo exception in schedule')
      expect(failed.stateReason).toMatchObject({ code: 'schedulingFailed' })
      expect(failed.conditions.map((c) => c.type)).toEqual(expect.arrayContaining(['schedulingFailed', 'workerErrors']))
      expect(findCondition(failed, 'schedulerRestarting')).toBeUndefined()
      expect(await scans.counts(scan.id)).toEqual({})
      const errors = await scanEvents(api, scan.id, 'worker.error')
      expect(errors.length).toBeGreaterThanOrEqual(4)
      // The restarts are paced by the scan's backoff, min(maxMs, initialMs × factor^(restarts − 1)) (docs/runtime.md
      // §11.9; throws: initial 1 s, factor 2): 1 s, 2 s and 4 s between the four failed schedule runs. Each gap also
      // holds the start of a new connector process and the schedule run up to its error, which takes seconds on a
      // loaded host; the lower bounds alone already rule out a constant delay.
      const times = errors.map((e) => Date.parse(e.at)).sort((a, b) => a - b)
      for (const [index, expected] of [1000, 2000, 4000].entries()) {
        const gap = times[index + 1]! - times[index]!
        expect(gap, JSON.stringify(times)).toBeGreaterThanOrEqual(expected - 250)
        expect(gap, JSON.stringify(times)).toBeLessThan(expected + 5000)
      }
    },
  )

  test('the condition schedulerRestarting is raised while the scheduler restarts', { tag: ['@SCHED-008'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.example('throws')
    const scan = await scans.start({
      revision: revision.ref,
      taskConfig: { mode: 'ok', fail_in_schedule: true },
      scanConfig: { start: 0, end: 5 },
      // 3 s, 6 s and 12 s between the restarts. The worker stays running; the error report raises the condition and only
      // a state poll during a schedule run clears it, so it is up for seconds at a time.
      settings: settings({ backoff: backoff(3000, 2) }),
    })
    const seen = await pollScan(api, scan.id, (s) => findCondition(s, 'schedulerRestarting') !== undefined || TERMINAL_STATES.includes(s.state), {
      what: 'schedulerRestarting',
      intervalMs: 250,
      timeoutMs: 90_000,
    })
    expect(findCondition(seen, 'schedulerRestarting'), JSON.stringify(seen.conditions)).toMatchObject({
      type: 'schedulerRestarting',
      severity: 'warning',
      details: { restarts: expect.any(Number), error: { type: 'taskError', phase: 'schedule' } },
    })
    expect((findCondition(seen, 'schedulerRestarting')!.details as { restarts: number }).restarts).toBeGreaterThanOrEqual(1)
    expect(seen.scheduling.restarts).toBeGreaterThanOrEqual(1)
  })

  test('Fatal in schedule fails scheduling at once; analyses published before it still run', { tag: ['@SCHED-009'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.generated('wrap')
    const scan = await scans.start({ revision: revision.ref, scanConfig: { end: 10, fail_after: 3, fail_with: 'fatal' } })
    const failed = await scans.wait(scan.id, { state: 'failed', timeoutMs: 120_000 })
    expect(failed.scheduling).toMatchObject({ state: 'failed', restarts: 0, confirmed: 3 })
    expect(failed.scheduling.error).toMatchObject({ type: 'fatal', retryable: false, phase: 'schedule', message: 'generated fatal error after 3 items' })
    expect(failed.stateReason).toMatchObject({ code: 'schedulingFailed' })
    expect(findCondition(failed, 'schedulingFailed')).toBeDefined()
    expect(findCondition(failed, 'schedulerRestarting')).toBeUndefined()
    expect(await scans.counts(scan.id)).toEqual({ succeeded: 3 })
    const analyses = await allAnalyses(api, scan.id, ['config', 'status'])
    expect(analyses.map((a) => (a.config as { value: number }).value)).toEqual([0, 1, 2])
    expect((await scanEvents(api, scan.id, 'scan.schedulingFailed')).length).toBe(1)
  })
})
