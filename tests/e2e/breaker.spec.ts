import type { Scan } from '#shared/types/scans'
import { ok } from '../helpers/api-client'
import { scantor } from '../helpers/cli'
import { stackEnv } from '../helpers/docker'
import { findCondition, metricValue, pollScan, pollUntil, scanEvents, scanWorkers } from '../helpers/e2e-runtime'
import { extendRuntime } from '../helpers/e2e-runtime-fixtures'
import { expect, test as base } from '../fixtures'

// The circuit breaker end to end (docs/queue.md §6.10; docs/guide/errors-and-retries.md "Circuit breaker"): a scan
// whose attempts fail at SCANTOR_BREAKER_RATIO over at least SCANTOR_BREAKER_MIN_ATTEMPTS attempts (the test stack:
// 0.95 over 20 within 5 minutes) is paused with `failureRate`; resuming clears the condition and starts a fresh
// window. The failures come from the `throws` example in mode `fatal` (one failed attempt per analysis), published once
// per run (helpers/e2e-runtime-fixtures.ts).

const test = extendRuntime(base)

test.describe.configure({ timeout: 180_000 })

test.beforeAll(async ({ shared }) => {
  // Publishing builds images; the stack builds at most SCANTOR_BUILD_CONCURRENCY of them at a time for every user.
  test.setTimeout(300_000)
  await Promise.all([shared.example('throws')])
})

const MIN_ATTEMPTS = 20
const WINDOW_MS = 5 * 60_000

test.describe('circuit breaker', () => {
  test(
    'a scan whose attempts all fail is paused with failureRate and breakerTripped; scans start --wait exits 1',
    { tag: ['@SCAN-038'] },
    async ({ api, adminApi, user, shared, scans }) => {
      expect(stackEnv()).toMatchObject({ SCANTOR_BREAKER_MIN_ATTEMPTS: String(MIN_ATTEMPTS), SCANTOR_BREAKER_RATIO: '0.95', SCANTOR_BREAKER_WINDOW: '5m' })
      const { revision } = await shared.example('throws')
      const tripsBefore = await metricValue(adminApi, 'scantor_breaker_trips_total')

      // 200 analyses that each fail with Fatal after 0.1 s; the CLI waits for the scan.
      const settings = JSON.stringify({ resources: { cpus: 0.25, memoryMiB: 256 } })
      const started = await scantor(
        [
          'scans',
          'start',
          revision.ref,
          '--task-config',
          '{"mode":"fatal","work_seconds":0.1}',
          '--scan-config',
          '{"start":0,"end":200}',
          '--settings',
          settings,
          '--workers',
          '1',
          '--processes',
          '1',
          '--wait',
          '-o',
          'json',
        ],
        { token: user.apiKey, timeoutMs: 120_000 },
      )
      const printed = started.json as Scan | undefined
      if (printed?.id) scans.track(printed.id)
      expect(started.exitCode, started.stdout + started.stderr).toBe(1)
      expect(printed?.state).toBe('paused')

      const scan = ok(await api.getScan(printed!.id), 'getScan')
      expect(scan.state).toBe('paused')
      expect(scan.stateReason).toMatchObject({ code: 'failureRate', message: expect.stringMatching(/^100% of the last \d+ attempts failed$/) })
      const attempts = Number(/of the last (\d+) attempts/.exec(scan.stateReason!.message)![1])
      expect(attempts).toBeGreaterThanOrEqual(MIN_ATTEMPTS)
      expect(scan.breaker).toMatchObject({ ratio: 1, attempts, windowMs: WINDOW_MS, trippedAt: expect.any(String) })
      expect(findCondition(scan, 'breakerTripped')).toMatchObject({ severity: 'error', details: { ratio: 1, attempts, windowMs: WINDOW_MS } })
      const changes = await scanEvents(api, scan.id, 'scan.stateChanged')
      expect(
        changes.some((e) => (e.data as { to?: string; reason?: string }).to === 'paused' && (e.data as { reason?: string }).reason === 'failureRate'),
      ).toBe(true)
      expect(await metricValue(adminApi, 'scantor_breaker_trips_total')).toBeGreaterThanOrEqual(tripsBefore + 1)

      // The workers drain exactly as on a user pause; the scan does not go on failing.
      await pollUntil(
        'every worker stopped',
        () => scanWorkers(api, scan.id),
        (workers) => workers.length > 0 && workers.every((w) => w.state === 'stopped'),
        {
          timeoutMs: 90_000,
          intervalMs: 500,
        },
      )
      const failed = (await scans.counts(scan.id)).failed ?? 0
      expect(failed).toBeGreaterThanOrEqual(attempts)
      expect(failed).toBeLessThan(200)
    },
  )

  test('resuming a breaker-paused scan clears breakerTripped and starts a fresh failure window', { tag: ['@SCAN-039'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.example('throws')
    // 0.5 s per failing analysis on one process: about two failures a second.
    const scan = await scans.start({ revision: revision.ref, taskConfig: { mode: 'fatal', work_seconds: 0.5 }, scanConfig: { start: 0, end: 300 } })
    const tripped = await pollScan(api, scan.id, (s) => s.state === 'paused', { what: 'the breaker tripped', timeoutMs: 90_000, intervalMs: 500 })
    expect(tripped.stateReason?.code).toBe('failureRate')
    await pollUntil(
      'every worker stopped',
      () => scanWorkers(api, scan.id),
      (workers) => workers.length > 0 && workers.every((w) => w.state === 'stopped'),
      {
        timeoutMs: 90_000,
        intervalMs: 500,
      },
    )
    const failedAtPause = (await scans.counts(scan.id)).failed ?? 0

    ok(await api.call<Scan>('resumeScan', { path: { scanId: scan.id } }), 'resumeScan')
    await pollScan(api, scan.id, (s) => s.state === 'running' && findCondition(s, 'breakerTripped') === undefined, { what: 'resumed without breakerTripped' })
    const cleared = await scanEvents(api, scan.id, 'scan.conditionCleared')
    expect(cleared.some((e) => (e.data as { type?: string }).type === 'breakerTripped')).toBe(true)

    // The old failures do not count: the breaker trips again only after another full window of new attempts.
    const again = await pollScan(api, scan.id, (s) => s.state === 'paused', { what: 'the breaker tripped again', timeoutMs: 90_000, intervalMs: 500 })
    expect(again.stateReason?.code).toBe('failureRate')
    expect(again.breaker!.attempts).toBeGreaterThanOrEqual(MIN_ATTEMPTS)
    expect(Date.parse(again.breaker!.trippedAt)).toBeGreaterThan(Date.parse(tripped.breaker!.trippedAt))
    const failedAtSecondTrip = (await scans.counts(scan.id)).failed ?? 0
    expect(failedAtSecondTrip - failedAtPause).toBeGreaterThanOrEqual(MIN_ATTEMPTS)
  })
})
