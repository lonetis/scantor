import { randomBytes } from 'node:crypto'
import type { Scan } from '#shared/types/scans'
import type { Worker } from '#shared/types/workers'
import { ok, type ApiClient } from '../helpers/api-client'
import {
  allAnalyses,
  analysisBySeq,
  connectorProcesses,
  findCondition,
  getScan,
  pollScan,
  pollUntil,
  scanEvents,
  scanQueue,
  scanWorkers,
  settings,
  sleep,
  withTimeline,
  workerContainers,
} from '../helpers/e2e-runtime'
import { extendRuntime, type SharedTasks } from '../helpers/e2e-runtime-fixtures'
import { inPool, type FakeNode } from '../helpers/e2e-runtime-nodes'
import { remoteNode, takeManifest } from '../helpers/e2e-runtime-registry'
import type { ProbeConfig } from '../helpers/e2e-runtime-tasks'
import { expect, test as base, type ScansFixture } from '../fixtures'

// Worker containers end to end (docs/nodes.md §6.5–§6.6, §7; docs/runtime.md §6.2, §7.3, §14): crash loops restart
// in place with backoff and raise crashLoop while a clean exit restarts without counting a crash (SIGTERM to the
// scan's own runner container makes its runtime drain and exit 0), connector processes are OOM-killed before the
// worker, drained workers finish their in-flight analyses and are removed, cancelled scans record nothing for their
// in-flight runs, each
// process slot is one consumer with prefetch 1, connector processes are recycled, and a failed image pull raises
// imagePullFailed until a pull succeeds. Every scan runs real workers on the built-in node, except the pull failure
// (on the remote node) and the clearing of imagePullFailed in both orders of node report and runtime bootstrap (on a
// fake node whose status reports the test writes, helpers/e2e-runtime-nodes.ts).

const test = extendRuntime(base)

test.describe.configure({ timeout: 180_000 })

// The run publishes the file's tasks once, all at the same time (helpers/e2e-runtime-fixtures.ts).
test.beforeAll(async ({ shared }) => {
  // Publishing builds images; the stack builds at most SCANTOR_BUILD_CONCURRENCY of them at a time for every user.
  test.setTimeout(300_000)
  await Promise.all([shared.generated('probe'), shared.generated('crashloop'), shared.fixture('crashy')])
})

interface Inflight {
  items: { analysisId: string; seq: number; attempt: number; workerId: string; nodeId: string }[]
}

function inflight(api: ApiClient, scanId: string): Promise<Inflight> {
  return api.call<Inflight>('listInflightAnalyses', { path: { scanId } }).then((response) => ok(response, 'listInflightAnalyses'))
}

const runners = (workers: Worker[]) => workers.filter((w) => w.role === 'runner')

test.describe('crash loops and memory', () => {
  test(
    'a worker container that keeps exiting restarts in place with a growing backoff and raises crashLoop',
    { tag: ['@NODE-026'] },
    async ({ api, shared, scans }) => {
      // The task's module exits when it is imported in a worker, so no connector process gets ready and the runtime
      // gives up with exit code 1 after its spawn retries.
      const { revision } = await shared.generated('crashloop')
      const scan = await scans.start({ revision: revision.ref })

      const looping = await pollScan(api, scan.id, (s) => findCondition(s, 'crashLoop') !== undefined, {
        timeoutMs: 90_000,
        what: 'crashLoop',
        intervalMs: 500,
      })
      const condition = findCondition(looping, 'crashLoop')!
      expect(condition).toMatchObject({ severity: 'error', reason: 'exitCode' })
      expect(condition.details).toMatchObject({
        exitCode: 1,
        oomKilled: false,
        workerId: expect.any(String),
        nodeId: expect.any(String),
        restarts: expect.any(Number),
      })
      expect(String(condition.details!.logTail)).toContain('crashloop: refusing to start in a worker')

      // The runner restarts the same container (same id) with growing delays: 5 s, then 10 s (± 10 %).
      const crashed = (await scanWorkers(api, scan.id)).find((w) => w.id === condition.details!.workerId)!
      expect(crashed.role).toBe('runner')
      const observations: { restarts: number; delayMs: number; containerId: string }[] = []
      await pollUntil(
        'two restarts of the crashing runner observed in backoff',
        async () => {
          const worker = (await scanWorkers(api, scan.id)).find((w) => w.id === crashed.id)!
          const container = worker.container
          if (worker.state === 'backoff' && container?.lastExit && container.nextRestartAt && !observations.some((o) => o.restarts === container.restarts)) {
            expect(container.lastExit).toMatchObject({ exitCode: 1, oomKilled: false })
            expect(container.lastExit.logTail).toContain('crashloop: refusing to start in a worker')
            expect(worker.stateReason).not.toBeNull()
            observations.push({
              restarts: container.restarts,
              delayMs: Date.parse(container.nextRestartAt) - Date.parse(container.lastExit.at),
              containerId: container.id,
            })
          }
          return observations
        },
        (seen) => seen.length >= 2,
        { timeoutMs: 150_000, intervalMs: 500 },
      )
      expect(new Set(observations.map((o) => o.containerId)).size, JSON.stringify(observations)).toBe(1)
      const [first, second] = observations
      expect(second!.restarts).toBeGreaterThan(first!.restarts)
      expect(second!.delayMs, JSON.stringify(observations)).toBeGreaterThan(first!.delayMs)
      for (const observation of observations) {
        const crashes = observation.restarts + 1
        const nominal = Math.min(5000 * 2 ** (crashes - 1), 300_000)
        expect(observation.delayMs, JSON.stringify(observations)).toBeGreaterThanOrEqual(nominal * 0.9 - 1000)
        expect(observation.delayMs, JSON.stringify(observations)).toBeLessThanOrEqual(nominal * 1.1 + 1000)
      }

      const events = await scanEvents(api, scan.id, 'worker.crashed')
      expect(events.length).toBeGreaterThanOrEqual(2)
      expect(events[0]).toMatchObject({ level: 'error', workerId: crashed.id, data: { exitCode: 1, oomKilled: false, restarts: expect.any(Number) } })
    },
  )

  test(
    'a worker container that exits 0 restarts in place after 10 s without counting a crash',
    { tag: ['@NODE-026'] },
    async ({ api, docker, shared, scans }) => {
      const { revision } = await shared.generated('probe')
      // Five analyses of 3 s on one runner; SIGTERM makes its runtime drain (finish the analysis in flight) and exit 0. The
      // worker is restarted only while the scan still has work, and the in-flight view lags by up to one state poll (5 s),
      // so the runner may be two analyses further than it shows: killing it while seq 0 or 1 shows leaves at least one
      // analysis for the restarted worker. Seqs 0 and 1 run for 6 s, so some state poll always reports one of them.
      const total = 5
      const scan = await scans.start({ revision: revision.ref, taskConfig: { mode: 'sleep', seconds: 3 }, scanConfig: { times: total } })
      const busy = await pollUntil(
        'seq 0 or 1 in flight',
        () => inflight(api, scan.id),
        (state) => state.items.length === 1 && state.items[0]!.seq <= 1,
        { timeoutMs: 90_000, intervalMs: 500 },
      )
      const workerId = busy.items[0]!.workerId
      const [container] = await workerContainers(scan.id, { workerId })
      expect(container).toBeDefined()
      await docker.kill(container!, 'TERM')

      // The node keeps the worker (it is still desired): backoff after the clean exit, restart 10 s later.
      const backoff = await withTimeline(api, scan.id, () =>
        pollUntil(
          'the runner in backoff after its clean exit',
          async () => (await scanWorkers(api, scan.id)).find((w) => w.id === workerId)!,
          (worker) => worker.state === 'backoff' && worker.container?.lastExit !== null && worker.container?.nextRestartAt !== null,
          { timeoutMs: 60_000, intervalMs: 250 },
        ),
      )
      const exit = backoff.container!.lastExit!
      expect(exit).toMatchObject({ exitCode: 0, oomKilled: false })
      const delayMs = Date.parse(backoff.container!.nextRestartAt!) - Date.parse(exit.at)
      expect(delayMs).toBeGreaterThanOrEqual(9000)
      expect(delayMs).toBeLessThanOrEqual(12_000)
      // The analysis in flight finished during the drain.
      expect(await analysisBySeq(api, scan.id, busy.items[0]!.seq)).toMatchObject({ status: 'succeeded', attempt: 1 })

      const restarted = await pollUntil(
        'the same container running again',
        async () => (await scanWorkers(api, scan.id)).find((w) => w.id === workerId)!,
        (worker) => worker.state === 'running' && (worker.container?.restarts ?? 0) >= 1,
        { timeoutMs: 60_000, intervalMs: 500 },
      )
      expect(restarted.container!.id).toBe(backoff.container!.id)
      expect(await workerContainers(scan.id, { workerId, all: true })).toEqual([container])

      await scans.wait(scan.id, { timeoutMs: 120_000 })
      expect(await scans.counts(scan.id)).toEqual({ succeeded: total })
      // A clean exit is never a crash.
      expect(await scanEvents(api, scan.id, 'worker.crashed')).toEqual([])
      expect(findCondition(await getScan(api, scan.id), 'crashLoop')).toBeUndefined()
    },
  )

  test(
    'a connector process over the container memory is killed first and the run fails as an OOM crash',
    { tag: ['@NODE-027'] },
    async ({ api, shared, scans }) => {
      const { revision } = await shared.fixture('crashy')
      // 128 MiB per process: the container may use 384 MiB; the connector allocates 1 GiB.
      const scan = await scans.start({
        revision: revision.ref,
        taskConfig: { mode: 'memory', memory_mib: 1024 },
        settings: settings({ maxAttempts: 1, resources: { cpus: 0.25, memoryMiB: 128 } }),
      })
      const done = await scans.wait(scan.id, { timeoutMs: 120_000 })
      const [analysis] = await allAnalyses(api, scan.id)
      expect(analysis).toMatchObject({
        status: 'failed',
        attempt: 1,
        error: { type: 'crash', retryable: true, phase: 'run', details: { oomKilled: true, signal: 'SIGKILL' } },
      })
      // Only the connector process died: the worker never exited.
      expect(findCondition(done, 'crashLoop')).toBeUndefined()
      expect(await scanEvents(api, scan.id, 'worker.crashed')).toEqual([])
      const runner = runners(await scanWorkers(api, scan.id))[0]!
      expect(runner.container?.restarts ?? 0).toBe(0)
      expect(runner.container?.lastExit?.oomKilled ?? false).toBe(false)
    },
  )
})

test.describe('drain and stop', () => {
  test(
    'a drained worker finishes its in-flight analysis, stops and is removed with its container',
    { tag: ['@NODE-028', '@RT-024', '@NODE-026'] },
    async ({ api, shared, scans }) => {
      const { revision } = await shared.generated('probe')
      // Four analyses of 8 s on two runners: both are busy when the scan is scaled in.
      const scan = await scans.start({
        revision: revision.ref,
        taskConfig: { mode: 'sleep', seconds: 8 },
        scanConfig: { times: 4 },
        settings: settings({ workers: 2 }),
      })
      const busy = await pollUntil(
        'both runners busy',
        () => inflight(api, scan.id),
        (state) => new Set(state.items.map((i) => i.workerId)).size === 2,
        {
          timeoutMs: 120_000,
          intervalMs: 500,
        },
      )
      ok(await api.call<Scan>('scaleScan', { path: { scanId: scan.id }, body: { workers: 1 } }), 'scaleScan')

      const victim = await pollUntil(
        'one runner draining',
        async () => runners(await scanWorkers(api, scan.id)).find((w) => w.state === 'draining' || w.state === 'stopped'),
        (worker) => worker !== undefined,
        { timeoutMs: 60_000, intervalMs: 500 },
      )
      const drainedSeqs = busy.items.filter((i) => i.workerId === victim!.id).map((i) => i.seq)
      expect(drainedSeqs).toHaveLength(1)

      // The drained runner stops after its in-flight analysis and its container is removed.
      const stopped = await pollUntil(
        'the drained runner stopped',
        async () => (await scanWorkers(api, scan.id)).find((w) => w.id === victim!.id)!,
        (worker) => worker.state === 'stopped',
        { timeoutMs: 120_000 },
      )
      expect(stopped.stoppedAt).not.toBeNull()
      await pollUntil(
        'its container removed',
        () => workerContainers(scan.id, { workerId: victim!.id, all: true }),
        (ids) => ids.length === 0,
        { timeoutMs: 60_000 },
      )
      const finished = await analysisBySeq(api, scan.id, drainedSeqs[0]!)
      expect(finished).toMatchObject({ status: 'succeeded', attempt: 1, workerId: victim!.id })
      expect(finished!.attempts).toHaveLength(1)

      await scans.wait(scan.id, { timeoutMs: 120_000 })
      expect(await scans.counts(scan.id)).toEqual({ succeeded: 4 })
      // Draining exits 0: no crash was ever counted, and every container of the scan is gone.
      expect(await scanEvents(api, scan.id, 'worker.crashed')).toEqual([])
      expect(findCondition(await getScan(api, scan.id), 'crashLoop')).toBeUndefined()
      // The scan's end drains the last runner too: draining → stopped once its node reports the container removed.
      await pollUntil(
        'no container of the scan left',
        () => workerContainers(scan.id, { all: true }),
        (ids) => ids.length === 0,
        { timeoutMs: 120_000 },
      )
      await pollUntil(
        'every worker stopped',
        () => scanWorkers(api, scan.id),
        (workers) => workers.every((w) => w.state === 'stopped'),
        { timeoutMs: 60_000 },
      )
    },
  )

  test('cancelling a scan stops its in-flight runs without recording anything for them', { tag: ['@RT-024'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.generated('probe')
    const scan = await scans.start({
      revision: revision.ref,
      taskConfig: { mode: 'sleep', seconds: 300 },
      scanConfig: { times: 2 },
      settings: settings({ processes: 2 }),
    })
    const busy = await pollUntil(
      'two analyses in flight',
      () => inflight(api, scan.id),
      (state) => state.items.length === 2,
      { timeoutMs: 120_000, intervalMs: 500 },
    )
    const [runnerContainer] = await workerContainers(scan.id, { workerId: busy.items[0]!.workerId })
    expect(runnerContainer).toBeDefined()

    const cancelledAt = Date.now()
    ok(await api.cancelScan(scan.id), 'cancelScan')
    await pollUntil(
      'the runner container gone',
      () => workerContainers(scan.id, { workerId: busy.items[0]!.workerId, all: true }),
      (ids) => ids.length === 0,
      {
        timeoutMs: 60_000,
        intervalMs: 500,
      },
    )
    // Well inside the node's stop timeout (drain grace + 5 s = 35 s): the runtime stopped on its own.
    expect(Date.now() - cancelledAt).toBeLessThan(30_000)
    for (const { seq } of busy.items) expect(await analysisBySeq(api, scan.id, seq), `seq ${seq}`).toBeNull()
    expect(await scans.counts(scan.id)).toEqual({})
    const cancelled = await getScan(api, scan.id)
    expect(cancelled.state).toBe('cancelled')
  })
})

test.describe('process slots', () => {
  test('every runner process consumes with prefetch 1: 3 workers × 4 processes are 12 consumers', { tag: ['@RT-007'] }, async ({ shared, scans }) => {
    const { revision } = await shared.generated('probe')
    const scan = await scans.start({
      revision: revision.ref,
      taskConfig: { mode: 'sleep', seconds: 300 },
      scanConfig: { times: 30 },
      settings: settings({ workers: 3, processes: 4, resources: { cpus: 0.1, memoryMiB: 64 } }),
    })
    const queue = await pollUntil(
      '12 consumers holding one message each',
      () => scanQueue(scan.id),
      (q) => q !== null && q.consumers === 12 && q.messages_unacknowledged === 12,
      { timeoutMs: 120_000, intervalMs: 500 },
    )
    expect(queue).toMatchObject({ consumers: 12, messages_unacknowledged: 12, messages_ready: 18 })
  })

  test('a connector process is recycled after maxAnalysesPerProcess analyses and after a crash', { tag: ['@RT-009'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.generated('probe')
    // One process works through the queue in seq order.
    const [counted, crashing] = await Promise.all([
      scans.start({ revision: revision.ref, taskConfig: { mode: 'ok' }, scanConfig: { times: 6 }, settings: settings({ maxAnalysesPerProcess: 2 }) }),
      scans.start({
        revision: revision.ref,
        taskConfig: { mode: 'exit', iterations: [1, 3], others: 'ok' },
        scanConfig: { times: 5 },
        settings: settings({ maxAttempts: 1 }),
      }),
    ])
    await scans.wait(counted.id, { timeoutMs: 120_000 })
    const pids = (await allAnalyses(api, counted.id)).map((a) => (a.result as { pid: number }).pid)
    expect(pids[0]).toBe(pids[1])
    expect(pids[2]).toBe(pids[3])
    expect(pids[4]).toBe(pids[5])
    expect(new Set(pids).size, JSON.stringify(pids)).toBe(3)

    await scans.wait(crashing.id, { timeoutMs: 120_000 })
    const runs = await allAnalyses(api, crashing.id)
    const pidOf = (seq: number) => Number(/probe pid=(\d+)/.exec(runs[seq]!.logTail ?? '')?.[1] ?? NaN)
    expect(runs.map((a) => a.status)).toEqual(['succeeded', 'failed', 'succeeded', 'failed', 'succeeded'])
    // seq 1 and 3 crash their process; the next analysis gets a new one.
    expect(pidOf(1)).toBe(pidOf(0))
    expect(pidOf(2)).not.toBe(pidOf(1))
    expect(pidOf(3)).toBe(pidOf(2))
    expect(pidOf(4)).not.toBe(pidOf(3))
  })

  test(
    'after repeated timeouts every process slot still has exactly one connector process',
    { tag: ['@RT-009', '@RT-011'] },
    async ({ api, shared, scans }) => {
      const { revision } = await shared.generated('probe')
      // Iterations 0–3 hang into the 2 s timeout on the two slots; the 30 analyses of 1.2 s after them keep both slots
      // busy for about 18 s, inside the timeout.
      const taskConfig: ProbeConfig = { mode: 'hang', iterations: [0, 1, 2, 3], others: 'sleep', seconds: 1.2 }
      const scan = await scans.start({
        revision: revision.ref,
        taskConfig: { ...taskConfig },
        scanConfig: { times: 34 },
        settings: settings({ processes: 2, timeoutMs: 2000, maxAttempts: 1 }),
      })
      const timedOut = await withTimeline(api, scan.id, () =>
        pollUntil(
          'four timeouts recorded',
          () => allAnalyses(api, scan.id, ['status', 'error']),
          (analyses) => analyses.filter((a) => a.error?.type === 'timeout').length === 4,
          { timeoutMs: 120_000, intervalMs: 500 },
        ),
      )
      expect(
        timedOut
          .filter((a) => a.error?.type === 'timeout')
          .map((a) => a.seq)
          .sort((a, b) => a - b),
      ).toEqual([0, 1, 2, 3])
      const runner = runners(await scanWorkers(api, scan.id)).find((w) => w.state === 'running')!
      const [container] = await workerContainers(scan.id, { workerId: runner.id })
      // Sampled while the later analyses run: the killed processes were replaced one for one.
      for (let sample = 0; sample < 3; sample++) {
        expect(await connectorProcesses(container!), `sample ${sample}`).toHaveLength(2)
        await sleep(1000)
      }
      await scans.wait(scan.id, { timeoutMs: 120_000 })
      expect(await scans.counts(scan.id)).toEqual({ failed: 4, succeeded: 30 })
    },
  )
})

test.describe('image pulls', () => {
  test(
    'a failed image pull leaves the worker pulling with imagePullFailed and raises the condition; the scan runs once the image is back',
    { tag: ['@NODE-033'] },
    async ({ api, shared, scans }) => {
      // Builds a probe copy of its own: the remote node must never have pulled its image, and no other test uses it.
      test.setTimeout(300_000)
      const { revision } = await shared.generated('probe', 'pull')
      const remote = remoteNode()
      const manifest = await takeManifest(revision.image!.repository, revision.image!.digest)
      let scanId: string
      try {
        // Only the remote node runs this scan.
        const scan = await scans.start({
          revision: revision.ref,
          scanConfig: { times: 1 },
          settings: settings({ nodeSelector: { pool: remote.pool, labels: {} } }),
        })
        scanId = scan.id
        const failing = await pollScan(api, scan.id, (s) => findCondition(s, 'imagePullFailed') !== undefined, { timeoutMs: 90_000, what: 'imagePullFailed' })
        expect(findCondition(failing, 'imagePullFailed')).toMatchObject({
          severity: 'error',
          details: { nodeId: remote.id, message: expect.stringContaining('not found') },
        })
        const failed = (await scanWorkers(api, scan.id)).filter((w) => w.stateReason?.code === 'imagePullFailed')
        expect(failed.length).toBeGreaterThanOrEqual(1)
        expect(failed.every((w) => w.nodeId === remote.id && (w.state === 'assigned' || w.state === 'pulling'))).toBe(true)
      } finally {
        await manifest.restore()
      }
      // The node retries the pull with backoff; the image arrives and the scan runs to its end. Whether the condition
      // clears depends on the order of the node's report and the runtime's bootstrap: the fake-node tests below fix it.
      await withTimeline(api, scanId!, () => scans.wait(scanId!, { timeoutMs: 120_000 }))
      expect(await scans.counts(scanId!)).toEqual({ succeeded: 1 })
    },
  )

  /** A scan of the probe whose scheduler and runner are assigned to a fake node; the node reports their pulls failing. */
  async function failedPulls(api: ApiClient, scans: ScansFixture, shared: SharedTasks, node: FakeNode) {
    const { revision } = await shared.generated('probe')
    const scan = await scans.start({ revision: revision.ref, scanConfig: { times: 1 }, settings: inPool(node.pool) })
    const assigned = await pollUntil(
      'the scheduler and the runner assigned to the fake node',
      async () => (await node.assignments()).filter((a) => a.scanId === scan.id),
      (workers) => workers.length === 2,
      { timeoutMs: 90_000, intervalMs: 500 },
    )
    const message = `pull ${revision.image!.repository}@${revision.image!.digest}: manifest unknown`
    await node.setWorkers(assigned.map((w) => ({ workerId: w.workerId, state: 'error', error: { code: 'imagePullFailed', message } })))
    const failing = await pollScan(api, scan.id, (s) => findCondition(s, 'imagePullFailed') !== undefined, {
      timeoutMs: 30_000,
      what: 'imagePullFailed',
      intervalMs: 500,
    })
    expect(findCondition(failing, 'imagePullFailed')).toMatchObject({ severity: 'error', details: { nodeId: node.id, message } })
    expect((await scanWorkers(api, scan.id)).map((w) => w.stateReason?.code)).toEqual(['imagePullFailed', 'imagePullFailed'])
    return { scan, assigned }
  }

  const containerId = () => randomBytes(32).toString('hex')

  test('imagePullFailed clears when the node reports the containers of the pulled image', { tag: ['@NODE-033'] }, async ({ api, shared, scans, fakeNodes }) => {
    const node = await fakeNodes.start()
    const { scan, assigned } = await failedPulls(api, scans, shared, node)
    // A later pull succeeds: the node reports the containers it created.
    await node.setWorkers(assigned.map((w) => ({ workerId: w.workerId, state: 'starting', containerId: containerId() })))
    await expect.poll(async () => findCondition(await getScan(api, scan.id), 'imagePullFailed'), { timeout: 15_000 }).toBeUndefined()
    const cleared = await scanEvents(api, scan.id, 'scan.conditionCleared')
    expect(cleared.some((e) => (e.data as { type?: string } | undefined)?.type === 'imagePullFailed')).toBe(true)
  })

  test(
    'imagePullFailed clears when the runtime bootstraps before the node reports the containers',
    { tag: ['@NODE-033'] },
    async ({ api, shared, scans, fakeNodes }) => {
      const node = await fakeNodes.start()
      const { scan, assigned } = await failedPulls(api, scans, shared, node)
      // A later pull succeeds and the runtimes in the new containers bootstrap before the node's next report.
      for (const worker of assigned) {
        const bootstrap = await node.runtimeCall<{ action: string }>('runtimeBootstrap', worker.env.SCANTOR_WORKER_TOKEN!)
        expect(ok(bootstrap, 'runtimeBootstrap').action).toBe('run')
      }
      expect((await scanWorkers(api, scan.id)).map((w) => w.state)).toEqual(['running', 'running'])
      await node.setWorkers(assigned.map((w) => ({ workerId: w.workerId, state: 'running', containerId: containerId() })))
      await expect.poll(async () => findCondition(await getScan(api, scan.id), 'imagePullFailed'), { timeout: 15_000 }).toBeUndefined()
    },
  )
})
