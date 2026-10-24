import { randomUUID } from 'node:crypto'
import type { Analysis, Attempt } from '#shared/types/analyses'
import { connectAsScan, EXCHANGES, publish } from '../helpers/amqp'
import {
  allAnalyses,
  analysisBySeq,
  backoff,
  connectorProcesses,
  containerProcesses,
  pollUntil,
  scanQueue,
  settings,
  utf8Bytes,
  waitForAnalysis,
  workerContainers,
} from '../helpers/e2e-runtime'
import { extendRuntime } from '../helpers/e2e-runtime-fixtures'
import type { ProbeConfig } from '../helpers/e2e-runtime-tasks'
import { expect, test as base } from '../fixtures'

// Attempts, retries and outcomes of runs end to end (docs/runtime.md §8.5–§8.6, §9, §10, §13.1; docs/queue.md §5.4,
// §6.5; docs/guide/errors-and-retries.md): every outcome of a run is classified and recorded with its attempt
// history, retries wait as delayed messages with the documented backoff, and errors and log tails are bounded. The
// runs come from the generated `probe` task (a run that ends as its task config says) and the `throws` example,
// published once per run (helpers/e2e-runtime-fixtures.ts).

const test = extendRuntime(base)

test.describe.configure({ timeout: 180_000 })

test.beforeAll(async ({ shared }) => {
  // Publishing builds images; the stack builds at most SCANTOR_BUILD_CONCURRENCY of them at a time for every user.
  test.setTimeout(300_000)
  const common = Promise.all([shared.generated('probe'), shared.example('throws')])
  // The JavaScript and Go tasks of one test build while the other tests run; that test awaits them (and publishes
  // again when this early publish failed, so its error is reported there).
  for (const kind of ['outcomes-js', 'outcomes-go'] as const) {
    shared.generated(kind).catch((error: unknown) => console.warn(`publishing ${kind} early failed; its test publishes again:`, error))
  }
  await common
})

const ms = (iso: string | null | undefined) => Date.parse(iso ?? '')

/** The gaps between the end of each attempt and the start of the next one, in ms. */
function gaps(attempts: Attempt[]): number[] {
  return attempts.slice(1).map((attempt, i) => ms(attempt.startedAt) - ms(attempts[i]!.finishedAt))
}

/** The only analysis of a one-analysis scan, once it is final. */
async function finalAnalysis(api: Parameters<typeof allAnalyses>[0], scanId: string): Promise<Analysis> {
  const analyses = await allAnalyses(api, scanId)
  expect(analyses).toHaveLength(1)
  return analyses[0]!
}

test.describe('retry policy', () => {
  test(
    'a retryable failure shows the analysis retrying while the retry waits as a delayed message',
    { tag: ['@RT-018', '@ING-011'] },
    async ({ api, shared, scans }) => {
      const { revision } = await shared.generated('probe')
      // Every attempt logs 6000 bytes to stdout and fails; the retry is due 15 s after the first failure.
      const taskConfig: ProbeConfig = { mode: 'logs', count: 6000, fail: true }
      const scan = await scans.start({
        revision: revision.ref,
        taskConfig: { ...taskConfig },
        scanConfig: { times: 1 },
        settings: settings({ maxAttempts: 2, backoff: backoff(15_000) }),
      })

      const retrying = await waitForAnalysis(api, scan.id, 0, (a) => a.status === 'retrying', { timeoutMs: 120_000, what: 'status retrying' })
      expect(retrying).toMatchObject({ status: 'retrying', attempt: 1, round: 1, error: { type: 'taskError', retryable: true, phase: 'run', attempt: 1 } })
      expect(retrying.error?.message).toContain('probe failure in attempt 1')
      expect(retrying.attempts).toHaveLength(1)
      const [first] = retrying.attempts
      expect(first).toMatchObject({ attempt: 1, round: 1, error: { type: 'taskError', attempt: 1 } })
      // The attempt's log tail keeps the end of the captured output within 4 KiB.
      expect(utf8Bytes(first!.logTail)).toBeLessThanOrEqual(4096)
      expect(first!.logTail).toMatch(/^…\[\d+ bytes truncated\]\n/)
      expect(first!.logTail).toContain('[warning] probe log key=value n=7')

      // The retry waits in the queue as a delayed message, invisible to the runners until it is due.
      const queue = await pollUntil(
        'one delayed message and nothing ready',
        () => scanQueue(scan.id),
        (q) => q !== null && q.messages_ready === 0 && q.messages_unacknowledged === 0 && (q.messages_delayed ?? 0) === 1,
        { timeoutMs: 10_000, intervalMs: 500 },
      )
      expect(queue).toMatchObject({ messages_ready: 0, messages_delayed: 1 })
      expect((await analysisBySeq(api, scan.id, 0))?.status).toBe('retrying')

      // Attempts are used up: the analysis fails with the second attempt, keeping the type's retryable value.
      await scans.wait(scan.id, { timeoutMs: 120_000 })
      const failed = await finalAnalysis(api, scan.id)
      expect(failed).toMatchObject({ status: 'failed', attempt: 2, error: { type: 'taskError', retryable: true, attempt: 2 } })
      expect(failed.attempts.map((a) => a.attempt)).toEqual([1, 2])
    },
  )

  test(
    'without jitter, attempts start 2 s, 4 s and 8 s apart; exhausted attempts fail keeping retryable',
    { tag: ['@RT-019', '@RT-020'] },
    async ({ api, shared, scans }) => {
      const { revision } = await shared.generated('probe')
      const scan = await scans.start({
        revision: revision.ref,
        taskConfig: { mode: 'flaky' },
        scanConfig: { times: 1 },
        settings: settings({ maxAttempts: 4, backoff: backoff(2000, 2) }),
      })
      await scans.wait(scan.id, { timeoutMs: 120_000 })
      const analysis = await finalAnalysis(api, scan.id)
      expect(analysis).toMatchObject({ status: 'failed', attempt: 4, error: { type: 'taskError', retryable: true, attempt: 4, phase: 'run' } })
      expect(analysis.attempts.map((a) => a.attempt)).toEqual([1, 2, 3, 4])
      const measured = gaps(analysis.attempts)
      // Each retry is delivered when due (never early) and taken at once by the idle runner.
      for (const [index, expected] of [2000, 4000, 8000].entries()) {
        expect(measured[index], `gap before attempt ${index + 2}: ${JSON.stringify(measured)}`).toBeGreaterThanOrEqual(expected - 250)
        expect(measured[index], `gap before attempt ${index + 2}: ${JSON.stringify(measured)}`).toBeLessThan(expected + 3000)
      }
    },
  )

  test('Retry waits exactly its delay, clamped to at least 1 s and at most backoff.maxMs', { tag: ['@RT-019', '@RT-013'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.example('throws')
    // The scan backoff differs from every expected gap, so each gap comes from the Retry delay alone.
    const cases = [
      { delay: 3, backoff: backoff(20_000), expected: 3000 },
      { delay: 0.2, backoff: backoff(20_000), expected: 1000 },
      { delay: 30, backoff: backoff(1000, 1, 4000), expected: 4000 },
    ]
    const started = await Promise.all(
      cases.map((c) =>
        scans.start({
          revision: revision.ref,
          taskConfig: { mode: 'retry', retry_delay: c.delay },
          scanConfig: { start: 0, end: 1 },
          settings: settings({ maxAttempts: 2, backoff: c.backoff }),
        }),
      ),
    )
    for (const [index, scan] of started.entries()) {
      const { expected } = cases[index]!
      await scans.wait(scan.id, { timeoutMs: 120_000 })
      const analysis = await finalAnalysis(api, scan.id)
      // Retry is a retryable type: the second attempt fails again and keeps retryable true.
      expect(analysis).toMatchObject({ status: 'failed', attempt: 2, error: { type: 'retry', retryable: true, attempt: 2, message: 'demo retry' } })
      const [gap] = gaps(analysis.attempts)
      expect(gap, `Retry(delay=${cases[index]!.delay})`).toBeGreaterThanOrEqual(expected - 250)
      expect(gap, `Retry(delay=${cases[index]!.delay})`).toBeLessThan(expected + 3000)
    }
  })
})

test.describe('outcomes', () => {
  test('a run past timeoutMs is killed with its child processes and fails as a retryable timeout', { tag: ['@RT-011'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.generated('probe')
    // Iteration 0 starts two `sleep 3600` children and hangs; iteration 1 keeps the worker busy afterwards, so its
    // container can be inspected once the timeout has struck.
    const taskConfig: ProbeConfig = { mode: 'hang_children', iterations: [0], others: 'sleep', seconds: 300 }
    const scan = await scans.start({
      revision: revision.ref,
      taskConfig: { ...taskConfig },
      scanConfig: { times: 2 },
      settings: settings({ timeoutMs: 3000, maxAttempts: 1 }),
    })
    const timedOut = await waitForAnalysis(api, scan.id, 0, (a) => a.status === 'failed', { timeoutMs: 120_000, what: 'status failed' })
    expect(timedOut).toMatchObject({ attempt: 1, error: { type: 'timeout', retryable: true, phase: 'run', attempt: 1, message: 'run exceeded 3000 ms' } })
    const children = /children started pids=([\d,]+)/.exec(timedOut.logTail ?? '')
    expect(children, timedOut.logTail).not.toBeNull()

    // The next analysis runs on a fresh connector process of the same slot; the killed group left no child behind.
    const runner = await pollUntil(
      'a runner container with a connector process',
      async () => {
        for (const id of await workerContainers(scan.id)) {
          const processes = await containerProcesses(id).catch(() => [])
          if (processes.some((p) => p.cmdline.includes('scantor.serve'))) return { id, processes }
        }
        return null
      },
      (found) => found !== null,
      { timeoutMs: 60_000 },
    )
    expect(
      runner!.processes.filter((p) => p.cmdline.startsWith('sleep 3600')),
      JSON.stringify(runner!.processes),
    ).toEqual([])
    expect(await connectorProcesses(runner!.id)).toHaveLength(1)
  })

  test('a connector process that ends during a run is a retryable crash with its exit status', { tag: ['@RT-012'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.generated('probe')
    const scan = await scans.start({
      revision: revision.ref,
      taskConfig: { mode: 'exit' },
      scanConfig: { times: 1 },
      settings: settings({ maxAttempts: 2, backoff: backoff(1000) }),
    })
    await scans.wait(scan.id, { timeoutMs: 120_000 })
    const analysis = await finalAnalysis(api, scan.id)
    const crash = {
      type: 'crash',
      retryable: true,
      phase: 'run',
      message: 'connector process ended during the run (exit code 3)',
      details: { exitCode: 3, signal: null, oomKilled: false },
    }
    expect(analysis).toMatchObject({ status: 'failed', attempt: 2, error: { ...crash, attempt: 2 } })
    // The first crash was retried: a crash is an attempt like any other retryable error.
    expect(analysis.attempts.map((a) => a.error)).toEqual([
      expect.objectContaining({ ...crash, attempt: 1 }),
      expect.objectContaining({ ...crash, attempt: 2 }),
    ])
    // Each attempt ran on its own (replaced) connector process.
    const pids = analysis.attempts.map((a) => /probe pid=(\d+)/.exec(a.logTail)?.[1])
    expect(new Set(pids).size, JSON.stringify(pids)).toBe(2)
  })

  test('Fatal, exceptions and rejected results are classified per type', { tag: ['@RT-013'] }, async ({ api, shared, scans }) => {
    const [throws, probe] = await Promise.all([shared.example('throws'), shared.generated('probe')])
    const retried = settings({ maxAttempts: 3, backoff: backoff(1000) })
    const [fatal, error, invalid] = await Promise.all([
      scans.start({ revision: throws.revision.ref, taskConfig: { mode: 'fatal' }, scanConfig: { start: 0, end: 1 }, settings: retried }),
      scans.start({ revision: throws.revision.ref, taskConfig: { mode: 'error' }, scanConfig: { start: 0, end: 1 }, settings: retried }),
      scans.start({ revision: probe.revision.ref, taskConfig: { mode: 'invalid_result', issues: 3 }, scanConfig: { times: 1 }, settings: retried }),
    ])

    // Fatal: one attempt, not retryable.
    await scans.wait(fatal.id, { timeoutMs: 120_000 })
    const fatalAnalysis = await finalAnalysis(api, fatal.id)
    expect(fatalAnalysis).toMatchObject({ status: 'failed', attempt: 1, error: { type: 'fatal', retryable: false, phase: 'run', message: 'demo fatal error' } })
    expect(fatalAnalysis.attempts).toHaveLength(1)

    // Any other exception: a retryable taskError with the traceback, retried until attempts are used up.
    await scans.wait(error.id, { timeoutMs: 120_000 })
    const errorAnalysis = await finalAnalysis(api, error.id)
    expect(errorAnalysis).toMatchObject({
      status: 'failed',
      attempt: 3,
      error: { type: 'taskError', retryable: true, phase: 'run', message: expect.stringContaining('demo exception in run') },
    })
    expect(errorAnalysis.error?.stack).toContain('Traceback (most recent call last)')
    expect(errorAnalysis.error?.stack).toContain('RuntimeError: demo exception in run')
    expect(errorAnalysis.attempts).toHaveLength(3)

    // A result the task's own model rejects: a non-retryable validation error in phase validate with the issues.
    await scans.wait(invalid.id, { timeoutMs: 120_000 })
    const invalidAnalysis = await finalAnalysis(api, invalid.id)
    expect(invalidAnalysis).toMatchObject({ status: 'failed', attempt: 1, error: { type: 'validation', retryable: false, phase: 'validate' } })
    const issues = (invalidAnalysis.error?.details as { issues?: { path: string }[] } | undefined)?.issues ?? []
    expect(issues.length, JSON.stringify(invalidAnalysis.error)).toBeGreaterThanOrEqual(3)
    expect(issues.map((issue) => issue.path).join(' ')).toContain('files')
    expect(invalidAnalysis.attempts).toHaveLength(1)
  })

  test('JavaScript and Go classify Fatal, Retry, errors, panics and rejected results the same way', { tag: ['@RT-013'] }, async ({ api, shared, scans }) => {
    // Builds a JavaScript and a Go task image on first use.
    test.setTimeout(300_000)
    const [js, go] = await Promise.all([shared.generated('outcomes-js'), shared.generated('outcomes-go')])
    expect([js.revision.language, go.revision.language]).toEqual(['javascript', 'go'])
    const retried = settings({ maxAttempts: 2, backoff: backoff(1000) })
    const started = await Promise.all([js, go].map((task) => scans.start({ revision: task.revision.ref, scanConfig: { times: 5 }, settings: retried })))
    for (const [index, language] of ['javascript', 'go'].entries()) {
      const scanId = started[index]!.id
      await scans.wait(scanId, { timeoutMs: 120_000 })
      const [fatal, retry, error, invalid, last] = await allAnalyses(api, scanId)
      expect(fatal, language).toMatchObject({
        status: 'failed',
        attempt: 1,
        error: { type: 'fatal', retryable: false, phase: 'run', message: 'generated fatal error' },
      })
      expect(retry, language).toMatchObject({
        status: 'failed',
        attempt: 2,
        error: { type: 'retry', retryable: true, phase: 'run', message: 'generated retry' },
      })
      const [retryGap] = gaps(retry!.attempts)
      expect(retryGap, language).toBeGreaterThanOrEqual(750)
      expect(error, language).toMatchObject({ status: 'failed', attempt: 2, error: { type: 'taskError', retryable: true, phase: 'run' } })
      expect(error!.error!.message, language).toContain('generated exception')
      expect(invalid, language).toMatchObject({ status: 'failed', attempt: 1, error: { type: 'validation', retryable: false, phase: 'validate' } })
      const issues = (invalid!.error!.details as { issues?: { path: string }[] } | undefined)?.issues ?? []
      expect(
        issues.map((issue) => issue.path),
        language,
      ).toContain('/iteration')
      if (language === 'javascript') {
        expect(error!.error!.stack, language).toContain('generated exception')
        expect(last, language).toMatchObject({ status: 'succeeded', result: { iteration: 4 } })
      } else {
        // A panic is an ordinary retryable error that keeps its stack.
        expect(last, language).toMatchObject({ status: 'failed', attempt: 2, error: { type: 'taskError', retryable: true, phase: 'run' } })
        expect(last!.error!.message, language).toContain('generated panic')
        expect(last!.error!.stack ?? '', language).toContain('main.run')
      }
    }
  })

  test('error messages, stacks and details are bounded', { tag: ['@RT-023'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.generated('probe')
    const once = settings({ maxAttempts: 1 })
    const [bigError, bigDetails] = await Promise.all([
      // A message of 20 000 two-byte characters: the message and the traceback (which repeats it) exceed their bounds.
      scans.start({ revision: revision.ref, taskConfig: { mode: 'big_error', count: 20_000 }, scanConfig: { times: 1 }, settings: once }),
      // 40 rejected codes, each issue message 300 characters long: the validation issues exceed 4 KiB of details.
      scans.start({ revision: revision.ref, taskConfig: { mode: 'invalid_codes', issues: 40 }, scanConfig: { times: 1 }, settings: once }),
    ])
    await scans.wait(bigError.id, { timeoutMs: 120_000 })
    const { error } = await finalAnalysis(api, bigError.id)
    expect(error).toMatchObject({ type: 'taskError' })
    // The message keeps its start within 4 KiB and ends with an ellipsis.
    expect(utf8Bytes(error!.message)).toBeLessThanOrEqual(4096)
    expect(utf8Bytes(error!.message)).toBeGreaterThan(4000)
    expect(error!.message).toMatch(/^RuntimeError: é+…$/)
    // The stack keeps its first and last parts within 16 KiB, joined by the truncation marker.
    const stack = error!.stack ?? ''
    expect(utf8Bytes(stack)).toBeLessThanOrEqual(16_384)
    expect(utf8Bytes(stack)).toBeGreaterThan(16_000)
    expect(stack).toMatch(/\n…\[\d+ bytes truncated\]…\n/)

    await scans.wait(bigDetails.id, { timeoutMs: 120_000 })
    const rejected = await finalAnalysis(api, bigDetails.id)
    expect(rejected.error).toMatchObject({ type: 'validation', phase: 'validate' })
    expect(rejected.error!.details).toEqual({ truncated: true })
  })

  test(
    'log tails keep stdout, stderr and ctx.log lines: 32 KiB for the result, 4 KiB per earlier attempt',
    { tag: ['@RT-021'] },
    async ({ api, shared, scans }) => {
      const { revision } = await shared.generated('probe')
      // 40 000 bytes of stdout per attempt; the first attempt fails, the second succeeds.
      const taskConfig: ProbeConfig = { mode: 'logs', count: 40_000, fail: true, fail_attempts: 1 }
      const scan = await scans.start({
        revision: revision.ref,
        taskConfig: { ...taskConfig, mode: 'logs' },
        scanConfig: { times: 1 },
        settings: settings({ maxAttempts: 2, backoff: backoff(1000) }),
      })
      await scans.wait(scan.id, { timeoutMs: 120_000 })
      const analysis = await finalAnalysis(api, scan.id)
      expect(analysis).toMatchObject({ status: 'succeeded', attempt: 2 })
      const tail = analysis.logTail ?? ''
      expect(utf8Bytes(tail)).toBeLessThanOrEqual(32_768)
      const truncated = /^…\[(\d+) bytes truncated\]\n/.exec(tail)
      expect(truncated, tail.slice(0, 100)).not.toBeNull()
      // Everything captured that the tail does not hold is counted in the marker.
      expect(Number(truncated![1]) + utf8Bytes(tail) - utf8Bytes(truncated![0])).toBeGreaterThan(40_000)
      expect(tail).toContain('o'.repeat(1000))
      expect(tail).toContain('stderr line\n')
      expect(tail).toContain('[warning] probe log key=value n=7')

      const [first] = analysis.attempts
      expect(first).toMatchObject({ attempt: 1, error: { type: 'taskError' } })
      expect(utf8Bytes(first!.logTail)).toBeLessThanOrEqual(4096)
      expect(first!.logTail).toMatch(/^…\[\d+ bytes truncated\]\n/)
    },
  )
})

test.describe('attempt history', () => {
  test('a flaky analysis succeeds on a later attempt and keeps only its last 10 attempts', { tag: ['@RT-020', '@ING-011'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.generated('probe')
    const scan = await scans.start({
      revision: revision.ref,
      taskConfig: { mode: 'flaky', fail_attempts: 11 },
      scanConfig: { times: 1 },
      settings: settings({ maxAttempts: 12, backoff: backoff(1000) }),
    })
    await scans.wait(scan.id, { timeoutMs: 150_000 })
    const analysis = await finalAnalysis(api, scan.id)
    expect(analysis).toMatchObject({ status: 'succeeded', attempt: 12, result: { attempt: 12 } })
    expect(analysis.error).toBeUndefined()
    expect(analysis.attempts.map((a) => a.attempt)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(analysis.attempts.slice(0, 9).every((a) => a.error?.type === 'taskError')).toBe(true)
    expect(analysis.attempts[9]!.error).toBeNull()
  })

  test('attempt events are ignored once the analysis is final or a later attempt is recorded', { tag: ['@ING-011'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.generated('probe')
    // Iteration 0 succeeds; iteration 1 fails and waits 120 s for its retry, so the scan stays running.
    const taskConfig: ProbeConfig = { mode: 'flaky', iterations: [1], others: 'ok' }
    const scan = await scans.start({
      revision: revision.ref,
      taskConfig: { ...taskConfig },
      scanConfig: { times: 2 },
      settings: settings({ maxAttempts: 3, backoff: backoff(120_000) }),
    })
    const done = await waitForAnalysis(api, scan.id, 0, (a) => a.status === 'succeeded', { timeoutMs: 120_000, what: 'status succeeded' })
    const retrying = await waitForAnalysis(api, scan.id, 1, (a) => a.status === 'retrying', { timeoutMs: 120_000, what: 'status retrying' })

    /** An attempt event as a runner of this scan publishes it (docs/queue.md §5.4). */
    const attemptEvent = (analysis: Analysis, attempt: number) => {
      const now = Date.now()
      return {
        v: 1,
        kind: 'attempt',
        analysisId: analysis.id,
        scanId: scan.id,
        seq: analysis.seq,
        round: 1,
        attempt,
        executionId: randomUUID(),
        workerId: retrying.workerId ?? randomUUID(),
        nodeId: retrying.nodeId ?? randomUUID(),
        config: analysis.config ?? {},
        error: { type: 'taskError', message: `injected attempt ${attempt}`, retryable: true, phase: 'run', attempt, at: now },
        logTail: 'injected\n',
        timings: { scheduledAt: now - 1000, startedAt: now - 500, finishedAt: now, durationMs: 500 },
      }
    }
    const session = await connectAsScan(scan.id)
    try {
      // A final analysis ignores attempt events; a retrying one ignores attempts up to the one it recorded.
      await publish(session, EXCHANGES.results, scan.id, attemptEvent(done, 1), { type: 'attempt', messageId: randomUUID() })
      await publish(session, EXCHANGES.results, scan.id, attemptEvent(retrying, 1), { type: 'attempt', messageId: randomUUID() })
      // A newer attempt applies; it proves the earlier events were ingested (one ordered queue) and ignored.
      await publish(session, EXCHANGES.results, scan.id, attemptEvent(retrying, 2), { type: 'attempt', messageId: randomUUID() })
    } finally {
      await session.close()
    }
    const advanced = await waitForAnalysis(api, scan.id, 1, (a) => a.attempt === 2, { timeoutMs: 60_000, what: 'attempt 2 recorded' })
    expect(advanced).toMatchObject({ status: 'retrying', attempt: 2, error: { message: 'injected attempt 2' } })
    expect(advanced.attempts.map((a) => [a.attempt, a.error?.message])).toEqual([
      [1, retrying.attempts[0]!.error!.message],
      [2, 'injected attempt 2'],
    ])
    const unchanged = await analysisBySeq(api, scan.id, 0)
    expect(unchanged).toMatchObject({ status: 'succeeded', attempt: 1, result: done.result })
    expect(unchanged!.attempts).toEqual(done.attempts)
  })
})
