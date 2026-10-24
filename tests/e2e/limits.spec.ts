import { stackEnv } from '../helpers/docker'
import { allAnalyses, findCondition, settings } from '../helpers/e2e-runtime'
import { extendRuntime } from '../helpers/e2e-runtime-fixtures'
import { expect, test as base } from '../fixtures'

// Instance limits enforced by the runtime end to end (docs/runtime.md §8.7, §11.6, §17): results above
// SCANTOR_MAX_RESULT_BYTES fail as non-retryable validation errors without disturbing other scans, and analysis
// configs above SCANTOR_MAX_ANALYSIS_CONFIG_BYTES fail scheduling while the items published before still run.

const test = extendRuntime(base)

test.describe.configure({ timeout: 180_000 })

test.beforeAll(async ({ shared }) => {
  // Publishing builds images; the stack builds at most SCANTOR_BUILD_CONCURRENCY of them at a time for every user.
  test.setTimeout(300_000)
  await Promise.all([shared.fixture('big-result'), shared.generated('wrap')])
})

const MAX_RESULT_BYTES = 1024 * 1024
const MAX_ANALYSIS_CONFIG_BYTES = 64 * 1024

test.describe('result size', () => {
  test(
    'a result above SCANTOR_MAX_RESULT_BYTES fails as validation without retry while other scans keep ingesting',
    { tag: ['@RT-014'] },
    async ({ api, shared, scans }) => {
      expect(stackEnv().SCANTOR_MAX_RESULT_BYTES).toBe('1MiB')
      const [big, wrap] = await Promise.all([shared.fixture('big-result'), shared.generated('wrap')])
      const [oversized, normal] = await Promise.all([
        scans.start({ revision: big.revision.ref, taskConfig: { size_bytes: 2 * 1024 * 1024 }, settings: settings({ maxAttempts: 3 }) }),
        scans.start({ revision: wrap.revision.ref, scanConfig: { end: 3 } }),
      ])
      await Promise.all([scans.wait(oversized.id, { timeoutMs: 120_000 }), scans.wait(normal.id, { timeoutMs: 120_000 })])

      const [analysis] = await allAnalyses(api, oversized.id)
      expect(analysis).toMatchObject({ status: 'failed', attempt: 1, error: { type: 'validation', retryable: false, phase: 'validate' } })
      expect(analysis!.result).toBeUndefined()
      expect(analysis!.attempts).toHaveLength(1)
      const size = Number(/^result is (\d+) bytes; the maximum is (\d+); store large data with ctx\.files\.put$/.exec(analysis!.error!.message)?.[1])
      expect(analysis!.error!.message).toBe(`result is ${size} bytes; the maximum is ${MAX_RESULT_BYTES}; store large data with ctx.files.put`)
      expect(size).toBeGreaterThan(2 * 1024 * 1024)

      expect((await allAnalyses(api, normal.id, ['status', 'result'])).map((a) => [a.status, a.result])).toEqual(
        [0, 1, 2].map((value) => ['succeeded', { value, domain: '', note: '' }]),
      )
    },
  )
})

test.describe('analysis config size', () => {
  test(
    'an analysis config above SCANTOR_MAX_ANALYSIS_CONFIG_BYTES fails scheduling; earlier items still run',
    { tag: ['@SCHED-007'] },
    async ({ api, shared, scans }) => {
      expect(stackEnv().SCANTOR_MAX_ANALYSIS_CONFIG_BYTES).toBe('64KiB')
      const { revision } = await shared.generated('wrap')
      // Item 3 carries a 70 000-character note.
      const scan = await scans.start({ revision: revision.ref, scanConfig: { end: 10, fail_after: 3, fail_with: 'big_config', config_bytes: 70_000 } })
      const failed = await scans.wait(scan.id, { state: 'failed', timeoutMs: 120_000 })
      expect(failed.scheduling).toMatchObject({ state: 'failed', confirmed: 3, restarts: 0 })
      expect(failed.scheduling.error).toMatchObject({ type: 'validation', retryable: false, phase: 'schedule' })
      const size = Number(/^analysis config 3 is (\d+) bytes; the maximum is (\d+)$/.exec(failed.scheduling.error!.message)?.[1])
      expect(failed.scheduling.error!.message).toBe(`analysis config 3 is ${size} bytes; the maximum is ${MAX_ANALYSIS_CONFIG_BYTES}`)
      expect(size).toBeGreaterThan(70_000)
      expect(findCondition(failed, 'schedulingFailed')).toBeDefined()
      expect(await scans.counts(scan.id)).toEqual({ succeeded: 3 })
      expect((await allAnalyses(api, scan.id, ['config'])).map((a) => (a.config as { value: number }).value)).toEqual([0, 1, 2])
    },
  )
})
