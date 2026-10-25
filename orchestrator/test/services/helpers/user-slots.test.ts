import type Docker from 'dockerode'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeHelper, setHelperRuntimeForTesting } from '../../../server/services/helpers/executor'
import { KeyedRwLock, KeyedSemaphore, Semaphore } from '../../../server/services/helpers/concurrency'
import { runHelperContainer } from '../../../server/services/helpers/runner'
import { parseConfig } from '../../../server/utils/config'
import { useLogger } from '../../../server/utils/logger'

// The per-user helper cap (docs/editor.md §9.8, security.md RES-8): one user holds at most
// SCANTOR_HELPER_CONCURRENCY_PER_USER helper slots, so slow uploads or git clones of one user leave the global slots
// to everyone else; the user over the cap waits up to 30 s and then gets 429 tooManyRequests.

vi.mock('../../../server/services/helpers/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/helpers/runner')>()
  return { ...actual, runHelperContainer: vi.fn() }
})

const ALICE = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const BOB = '1b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c12'
const run = vi.mocked(runHelperContainer)
const finishers: (() => void)[] = []
const started: string[] = []

beforeEach(() => {
  vi.useFakeTimers()
  finishers.length = 0
  started.length = 0
  const config = parseConfig({}).config
  setHelperRuntimeForTesting({
    docker: {} as Docker,
    config: { ...config, helperConcurrency: 4, helperConcurrencyPerUser: 2 },
    log: useLogger('helpers'),
    slots: new Semaphore(4),
    userSlots: new KeyedSemaphore(2),
    userLocks: new KeyedRwLock(),
    initialized: new Set([ALICE, BOB]),
    initializing: new Map(),
  })
  run.mockImplementation(async (options) => {
    started.push(String((options.spec.Labels as Record<string, string>)['scantor.user']))
    await new Promise<void>((resolve) => finishers.push(resolve))
    return { exitCode: 0, stdout: Buffer.from('{}'), stderr: '' }
  })
})

afterEach(() => {
  vi.useRealTimers()
  setHelperRuntimeForTesting(null)
})

function list(userId: string) {
  return executeHelper('list', { userId, args: ['--archive'] })
}

describe('per-user helper slots', () => {
  it('lets one user hold at most its cap while other users still get slots, then answers 429', async () => {
    const alice = [list(ALICE), list(ALICE)]
    const third = list(ALICE)
    const thirdOutcome = third.then(
      () => null,
      (error: unknown) => error,
    )
    const bob = list(BOB)
    await vi.advanceTimersByTimeAsync(0)
    expect(started.sort()).toEqual([ALICE, ALICE, BOB].sort())

    await vi.advanceTimersByTimeAsync(30_000)
    expect(await thirdOutcome).toMatchObject({ code: 'tooManyRequests', statusCode: 429, details: { limit: 2 } })
    for (const finish of finishers) finish()
    await Promise.all([...alice, bob])
  })

  it('runs a waiting helper as soon as one of the user’s slots frees up', async () => {
    const first = list(ALICE)
    const second = list(ALICE)
    const third = list(ALICE)
    await vi.advanceTimersByTimeAsync(0)
    expect(started).toHaveLength(2)
    finishers[0]!()
    await first
    await vi.advanceTimersByTimeAsync(0)
    expect(started).toHaveLength(3)
    for (const finish of finishers.slice(1)) finish()
    await Promise.all([second, third])
  })
})
