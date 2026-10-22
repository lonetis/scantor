import type Docker from 'dockerode'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeHelper, setHelperRuntimeForTesting } from '../../../server/services/helpers/executor'
import { KeyedRwLock, Semaphore } from '../../../server/services/helpers/concurrency'
import { HelperTimeoutError, runHelperContainer } from '../../../server/services/helpers/runner'
import { helpersRunning, metricsRegistry } from '../../../server/services/metrics/catalogue'
import { parseConfig } from '../../../server/utils/config'
import { useLogger } from '../../../server/utils/logger'

// Workspace helper metrics (docs/deployment.md §13.1): scantor_helpers_running follows the slots in use and every
// run is observed in scantor_helper_duration_seconds with its outcome.

vi.mock('../../../server/services/helpers/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/helpers/runner')>()
  return { ...actual, runHelperContainer: vi.fn() }
})

const USER = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const run = vi.mocked(runHelperContainer)

/** The sample count of one (op, outcome) series of the duration histogram. */
function runsOf(op: string, outcome: string): number {
  const line = metricsRegistry
    .render()
    .split('\n')
    .find((entry) => entry.startsWith(`scantor_helper_duration_seconds_count{op="${op}",outcome="${outcome}"} `))
  return line ? Number(line.split(' ').at(-1)) : 0
}

beforeEach(() => {
  const config = parseConfig({}).config
  setHelperRuntimeForTesting({
    docker: {} as Docker,
    config: { ...config, helperTimeoutMs: 1000 },
    log: useLogger('helpers'),
    slots: new Semaphore(2),
    userLocks: new KeyedRwLock(),
    initialized: new Set([USER]),
    initializing: new Map(),
  })
})

afterEach(() => {
  setHelperRuntimeForTesting(null)
})

describe('helper metrics', () => {
  it('reports the helpers in flight and observes successful runs', async () => {
    const before = runsOf('list', 'ok')
    let runningDuringRun = -1
    run.mockImplementation(async () => {
      runningDuringRun = helpersRunning.get()
      return { exitCode: 0, stdout: Buffer.from('{}'), stderr: '' }
    })
    await executeHelper('list', { userId: USER, args: ['--archive'] })
    expect(runningDuringRun).toBe(1)
    expect(helpersRunning.get()).toBe(0)
    expect(runsOf('list', 'ok')).toBe(before + 1)
  })

  it('observes helper errors and timeouts', async () => {
    const errors = runsOf('read', 'error')
    const timeouts = runsOf('read', 'timeout')
    run.mockResolvedValueOnce({ exitCode: 1, stdout: Buffer.from('{"error":{}}'), stderr: '' })
    await executeHelper('read', { userId: USER, args: ['--archive'] })
    run.mockRejectedValueOnce(new HelperTimeoutError(1000))
    await expect(executeHelper('read', { userId: USER, args: ['--archive'] })).rejects.toMatchObject({ statusCode: 500 })
    expect(runsOf('read', 'error')).toBe(errors + 1)
    expect(runsOf('read', 'timeout')).toBe(timeouts + 1)
    expect(helpersRunning.get()).toBe(0)
  })
})
