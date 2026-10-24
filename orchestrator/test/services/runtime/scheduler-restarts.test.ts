import { beforeEach, describe, expect, it, vi } from 'vitest'
import { schedulerRestartingCondition, SchedulerSupervisor } from '../../../server/services/reconciler/scheduler'
import { countSchedulerRestart } from '../../../server/services/runtime/scheduler'
import { MIN_RESTART_BACKOFF_MS, schedulerRunsAgain } from '../../../server/services/runtime/state'
import type { ConditionDoc, ScanDoc, ScantorErrorDoc, WorkerDoc } from '../../../server/types/documents'
import type { Logger } from '../../../server/utils/logger'
import { FakeCollection } from '../../helpers/fake-collection'
import { scanDoc, workerDoc } from '../scans/fixtures'

// The condition schedulerRestarting (docs/data-model.md §4.5.4, docs/runtime.md §11.9): a retryable schedule error
// restarts the schedule in process, so the scheduler worker stays `running`. The error report raises the condition,
// a state poll that shows the restarted schedule running clears it, and the reconciler raises it only while a
// restarted scheduler is not running. The MongoDB side is covered by runtime-api.integration.test.ts and
// broker.integration.test.ts.

const store = {
  scans: new FakeCollection<ScanDoc>('scans'),
  workers: new FakeCollection<WorkerDoc>('workers'),
}

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => Object.fromEntries(Object.entries(store).map(([name, collection]) => [name, collection.asCollection()])),
}))

const conditions = vi.hoisted(() => ({ raiseScanCondition: vi.fn(async () => true), clearScanCondition: vi.fn(async () => true) }))
vi.mock('../../../server/services/runtime/conditions', () => conditions)

const scanConditions = vi.hoisted(() => ({ setCondition: vi.fn(async () => true), clearCondition: vi.fn(async () => true) }))
vi.mock('../../../server/services/scans/conditions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/scans/conditions')>()),
  ...scanConditions,
}))
vi.mock('../../../server/services/nodes/events', () => ({ recordEvent: vi.fn(async () => undefined) }))
vi.mock('../../../server/services/scans/events', () => ({ writeEvent: vi.fn(async () => undefined) }))
vi.mock('../../../server/services/scans/completion', () => ({ tryCompleteScan: vi.fn(async () => false) }))

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger
const NOW = new Date('2026-10-21T10:00:00.000Z')
const error: ScantorErrorDoc = { type: 'taskError', phase: 'schedule', message: 'demo exception in schedule', retryable: true, attempt: 1, at: NOW }

function restarting(updatedAt: Date): ConditionDoc {
  return { ...schedulerRestartingCondition(1, error), severity: 'warning', since: updatedAt, updatedAt }
}

beforeEach(async () => {
  vi.clearAllMocks()
  await store.scans.deleteMany({})
  await store.workers.deleteMany({})
})

describe('schedulerRestartingCondition', () => {
  it('carries the restart count and the latest error', () => {
    expect(schedulerRestartingCondition(1, error)).toEqual({
      type: 'schedulerRestarting',
      reason: 'restarting',
      message: 'the scheduler restarted 1 time',
      details: { restarts: 1, error: { type: 'taskError', phase: 'schedule', message: 'demo exception in schedule' } },
    })
    expect(schedulerRestartingCondition(3, null)).toMatchObject({ message: 'the scheduler restarted 3 times', details: { restarts: 3, error: null } })
  })
})

describe('countSchedulerRestart', () => {
  it('raises schedulerRestarting for an in-process restart below the limit', async () => {
    const scan = scanDoc({ scheduling: { state: 'running', epoch: 2, restarts: 0, confirmed: 0 } })
    await store.scans.insertOne(scan)
    expect(await countSchedulerRestart(scan._id, 2, error, 3, log)).toBe(1)
    expect(conditions.raiseScanCondition).toHaveBeenCalledWith(
      scan._id,
      {
        type: 'schedulerRestarting',
        severity: 'warning',
        reason: 'restarting',
        message: 'the scheduler restarted 1 time',
        details: { restarts: 1, error: { type: 'taskError', phase: 'schedule', message: 'demo exception in schedule' } },
      },
      scan.userId,
      expect.any(Date),
    )
    expect(conditions.clearScanCondition).not.toHaveBeenCalled()
  })

  it('fails scheduling above the limit and clears schedulerRestarting', async () => {
    const scan = scanDoc({ scheduling: { state: 'running', epoch: 2, restarts: 3, confirmed: 0 } })
    await store.scans.insertOne(scan)
    expect(await countSchedulerRestart(scan._id, 2, error, 3, log)).toBe(4)
    expect(conditions.raiseScanCondition).toHaveBeenCalledTimes(1)
    expect(conditions.raiseScanCondition).toHaveBeenCalledWith(scan._id, expect.objectContaining({ type: 'schedulingFailed' }), scan.userId, expect.any(Date))
    expect(conditions.clearScanCondition).toHaveBeenCalledWith(scan._id, 'schedulerRestarting', scan.userId, {}, expect.any(Date))
    expect((await store.scans.findOne({ _id: scan._id }))!.scheduling).toMatchObject({ state: 'failed', restarts: 4 })
  })

  it('counts nothing for a stale epoch', async () => {
    const scan = scanDoc({ scheduling: { state: 'running', epoch: 2, restarts: 0, confirmed: 0 } })
    await store.scans.insertOne(scan)
    expect(await countSchedulerRestart(scan._id, 1, error, 3, log)).toBeNull()
    expect(conditions.raiseScanCondition).not.toHaveBeenCalled()
  })
})

describe('schedulerRunsAgain', () => {
  const scheduler = { role: 'scheduler', epoch: 2 } as const
  const running = { processes: { running: 1, busy: 1 } }
  const old = new Date(NOW.getTime() - MIN_RESTART_BACKOFF_MS)

  function scanWith(condition: ConditionDoc | null): Pick<ScanDoc, 'scheduling' | 'conditions'> {
    return {
      scheduling: scanDoc({ scheduling: { state: 'running', epoch: 2, restarts: 1, confirmed: 0 } }).scheduling,
      conditions: condition ? [condition] : [],
    }
  }

  it('is true once the current scheduler reports a schedule run after the restart', () => {
    expect(schedulerRunsAgain(scanWith(restarting(old)), scheduler, running, NOW)).toBe(true)
  })

  it('is false while the scheduler waits for its restart or has nothing to clear', () => {
    expect(schedulerRunsAgain(scanWith(restarting(old)), scheduler, { processes: { running: 1, busy: 0 } }, NOW)).toBe(false)
    expect(schedulerRunsAgain(scanWith(null), scheduler, running, NOW)).toBe(false)
  })

  it('ignores a poll that was built before the restart (less than the shortest backoff after the report)', () => {
    expect(schedulerRunsAgain(scanWith(restarting(new Date(NOW.getTime() - MIN_RESTART_BACKOFF_MS + 1))), scheduler, running, NOW)).toBe(false)
  })

  it('ignores runners and schedulers of an older epoch', () => {
    expect(schedulerRunsAgain(scanWith(restarting(old)), { role: 'runner', epoch: 0 }, running, NOW)).toBe(false)
    expect(schedulerRunsAgain(scanWith(restarting(old)), { role: 'scheduler', epoch: 1 }, running, NOW)).toBe(false)
  })
})

describe('SchedulerSupervisor and schedulerRestarting', () => {
  function supervisor(): SchedulerSupervisor {
    return new SchedulerSupervisor({
      scans: store.scans.asCollection(),
      workers: store.workers.asCollection(),
      config: { schedulerMaxRestarts: 3 },
      log,
      now: () => NOW,
    })
  }

  async function insert(state: WorkerDoc['state'], condition: ConditionDoc | null) {
    const scan = scanDoc({ scheduling: { state: 'running', epoch: 2, restarts: 1, confirmed: 0 }, conditions: condition ? [condition] : [] })
    await store.scans.insertOne(scan)
    await store.workers.insertOne(
      workerDoc(scan._id, {
        role: 'scheduler',
        epoch: 2,
        state,
        runtime: { version: null, protocolVersion: null, bootstrappedAt: null, lastSeenAt: null, lastError: error },
      }),
    )
    return scan
  }

  it('raises it while a restarted scheduler is not running', async () => {
    const scan = await insert('backoff', null)
    await supervisor().run()
    expect(scanConditions.setCondition).toHaveBeenCalledWith(
      expect.objectContaining({ _id: scan._id }),
      schedulerRestartingCondition(1, error),
      NOW,
      expect.anything(),
    )
  })

  it('leaves the condition of a running scheduler to its state poll', async () => {
    await insert('running', restarting(NOW))
    await supervisor().run()
    expect(scanConditions.setCondition).not.toHaveBeenCalled()
    expect(scanConditions.clearCondition).not.toHaveBeenCalled()
  })
})
