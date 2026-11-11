import type Docker from 'dockerode'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeHelper, setHelperRuntimeForTesting } from '../../../server/services/helpers/executor'
import { KeyedRwLock, KeyedSemaphore, Semaphore } from '../../../server/services/helpers/concurrency'
import { runHelperContainer } from '../../../server/services/helpers/runner'
import { parseConfig } from '../../../server/utils/config'
import { useLogger } from '../../../server/utils/logger'

// The root `prepare` helper (docs/editor.md §9.4): it gives the volume roots to the helper user once per process,
// before the first `init` or `purge`, which then run as 1000:1000; concurrent first callers share one run, and a
// failed run is repeated by the next caller.

vi.mock('../../../server/services/helpers/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/helpers/runner')>()
  return { ...actual, runHelperContainer: vi.fn() }
})

const ALICE = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const BOB = '1b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c12'
const run = vi.mocked(runHelperContainer)
const ops: string[] = []
let prepareExit = 0

beforeEach(() => {
  ops.length = 0
  prepareExit = 0
  setHelperRuntimeForTesting({
    docker: {} as Docker,
    config: parseConfig({}).config,
    log: useLogger('helpers'),
    slots: new Semaphore(4),
    userSlots: new KeyedSemaphore(4),
    userLocks: new KeyedRwLock(),
    initialized: new Set(),
    initializing: new Map(),
  })
  run.mockImplementation(async (options) => {
    const op = (options.spec.Labels as Record<string, string>)['scantor.op']!
    ops.push(`${op}:${options.spec.User}`)
    if (op === 'prepare') {
      const volumes = [
        { volume: 'workspaces', shared: false },
        { volume: 'editor-home', shared: false },
      ]
      return { exitCode: prepareExit, stdout: Buffer.from(prepareExit === 0 ? JSON.stringify({ volumes }) : ''), stderr: '' }
    }
    return { exitCode: 0, stdout: Buffer.from('{"created":[],"removed":[]}'), stderr: '' }
  })
})

afterEach(() => {
  setHelperRuntimeForTesting(null)
})

describe('prepare', () => {
  it('runs once, as root, before the first init or purge of the process', async () => {
    await Promise.all([executeHelper('init', { userId: ALICE }), executeHelper('init', { userId: BOB })])
    await executeHelper('purge', { userId: ALICE, args: ['--user', ALICE] })
    expect(ops.filter((op) => op.startsWith('prepare'))).toEqual(['prepare:0:0'])
    expect(ops.filter((op) => !op.startsWith('prepare')).sort()).toEqual(['init:1000:1000', 'init:1000:1000', 'purge:1000:1000'])
    expect(ops[0]).toBe('prepare:0:0')
  })

  it('fails the init when prepare fails and repeats prepare on the next call', async () => {
    prepareExit = 2
    await expect(executeHelper('init', { userId: ALICE })).rejects.toMatchObject({ code: 'internal' })
    expect(ops).toEqual(['prepare:0:0'])
    prepareExit = 0
    await executeHelper('init', { userId: ALICE })
    expect(ops).toEqual(['prepare:0:0', 'prepare:0:0', 'init:1000:1000'])
  })
})
