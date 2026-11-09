import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobDoc, ScriptDoc, ScriptRunDoc, ScriptRunLogChunkDoc } from '../../../server/types/documents'
import { FakeCollection } from '../../helpers/fake-collection'

// Cleanup of script runs for the deletion cascades (docs/scripts.md): cancelling the active runs of a script, a user
// or a scan (a queued or building run at once with its queued job; a running run by a cancel request its job ends, so
// the token keeps working through the stop and the job stays active), ending a pending cancel, counting the runs still
// winding down, and deleting the data of finished runs only.

const store = {
  scripts: new FakeCollection<ScriptDoc>('scripts'),
  scriptRuns: new FakeCollection<ScriptRunDoc>('scriptRuns'),
  scriptRunLogs: new FakeCollection<ScriptRunLogChunkDoc>('scriptRunLogs'),
  jobs: new FakeCollection<JobDoc>('jobs'),
}
const deletedPrefixes: string[] = []

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => Object.fromEntries(Object.entries(store).map(([name, collection]) => [name, collection.asCollection()])),
}))
vi.mock('../../../server/utils/s3', () => ({ deletePrefix: async (prefix: string) => deletedPrefixes.push(prefix) }))
vi.mock('../../../server/utils/config', () => ({ useConfig: () => ({ scriptRunRetentionDays: 30 }) }))
vi.mock('../../../server/utils/docker', () => ({ useDocker: () => ({}) }))

const { cancelActiveScriptRuns, cancelScriptRunState, countActiveScriptRunJobs, deleteScriptRunsData, settleCancelRequest } =
  await import('../../../server/services/script-runs/cleanup')
const { isScriptRunSettled, toApiScriptRun } = await import('../../../server/services/script-runs/mappers')
const { setLatestRunPointer } = await import('../../../server/services/script-runs/pointer')

const SCRIPT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const USER = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const SCAN = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

function run(id: string, state: string, extra: Record<string, unknown> = {}) {
  return { _id: id, scriptId: SCRIPT, userId: USER, scanIds: [SCAN], state, finishedAt: null, expiresAt: null, error: null, createdAt: new Date(), ...extra }
}

beforeEach(() => {
  for (const collection of Object.values(store)) collection.docs.length = 0
  deletedPrefixes.length = 0
  store.scripts.docs.push({ _id: SCRIPT, latestRun: { id: 'r2', state: 'running', createdAt: new Date(), finishedAt: null } })
  store.scriptRuns.docs.push(run('r1', 'completed'), run('r2', 'running'), run('r3', 'queued', { scanIds: ['other'] }))
  store.jobs.docs.push(
    { _id: 'j2', kind: 'scriptRun', subject: { kind: 'scriptRun', id: 'r2' }, active: true, state: 'running' },
    { _id: 'j3', kind: 'scriptRun', subject: { kind: 'scriptRun', id: 'r3' }, active: true, state: 'queued' },
  )
})

describe('cancelActiveScriptRuns', () => {
  it('requests the cancel of a running run with the reason and leaves its job running', async () => {
    expect(await cancelActiveScriptRuns({ scanId: SCAN }, 'a scan of the run was deleted')).toBe(1)
    const r2 = store.scriptRuns.docs.find((doc) => doc._id === 'r2')! as unknown as ScriptRunDoc
    // The token checks `running`: the script can still store its .partial outputs and checkpoint during the stop.
    expect(r2).toMatchObject({ state: 'running', error: null, cancelRequest: { reason: 'a scan of the run was deleted' } })
    expect(r2.cancelRequest!.at).toBeInstanceOf(Date)
    expect(r2.finishedAt).toBeInstanceOf(Date)
    expect(r2.expiresAt!.getTime() - r2.finishedAt!.getTime()).toBe(30 * 86_400_000)
    // Clients already see the cancel.
    const representation = toApiScriptRun({
      ...r2,
      scanIds: [],
      input: { config: {}, settings: { timeoutMs: null, resources: { cpus: null, memoryMiB: null }, limit: null } },
      source: { key: 'k', packSha256: 'f'.repeat(64), packBytes: 1, fileCount: 1 },
      outputs: [],
      errors: [],
      log: { lines: 0, bytes: 0, firstLine: 1, droppedLines: 0, nextChunk: 0, cursor: null },
      updatedAt: new Date(),
    })
    expect(representation).toMatchObject({
      state: 'cancelled',
      error: { type: 'platform', message: 'a scan of the run was deleted' },
    })
    // A wait still holds: the run settles once its job stopped the container and wrote the state.
    expect(isScriptRunSettled(r2)).toBe(false)
    expect(isScriptRunSettled({ ...r2, state: 'cancelled' })).toBe(true)
    expect(store.jobs.docs.find((job) => job._id === 'j2')).toMatchObject({ state: 'running', active: true })
    expect(store.jobs.docs.find((job) => job._id === 'j3')).toMatchObject({ active: true })
    expect(store.scripts.docs[0]!.latestRun).toMatchObject({ id: 'r2', state: 'cancelled' })
    // A second cancel finds it pending.
    expect(await cancelScriptRunState('r2', null, 30)).toBeNull()
  })

  it('cancels queued runs at once with their queued job and counts the runs still winding down', async () => {
    expect(await countActiveScriptRunJobs({ scriptId: SCRIPT })).toBe(2)
    expect(await cancelActiveScriptRuns({ scriptId: SCRIPT }, null)).toBe(2)
    expect(store.scriptRuns.docs.find((doc) => doc._id === 'r3')).toMatchObject({ state: 'cancelled', error: null })
    expect(store.jobs.docs.find((job) => job._id === 'j3')).toMatchObject({ state: 'cancelled', active: false })
    // r2 still stops its container.
    expect(await countActiveScriptRunJobs({ scriptId: SCRIPT })).toBe(1)
    expect(await cancelActiveScriptRuns({ userId: USER }, null)).toBe(0)

    // The job ends the cancel (the script reported its own error meanwhile) and is still active until it returns.
    await store.scriptRuns.updateOne({ _id: 'r2' }, { $set: { error: { type: 'scriptError', message: 'cancelled: received SIGTERM' } } })
    expect(await settleCancelRequest('r2', { exitCode: 143 })).toMatchObject({ state: 'cancelled', error: null, exitCode: 143 })
    expect(await settleCancelRequest('r2')).toBeNull()
    expect(await countActiveScriptRunJobs({ scriptId: SCRIPT })).toBe(1)
    await store.jobs.updateOne({ _id: 'j2' }, { $set: { state: 'succeeded', active: false } })
    expect(await countActiveScriptRunJobs({ scriptId: SCRIPT })).toBe(0)
  })

  it('moves a queued job of a running run up so it stops the container at once', async () => {
    store.jobs.docs.splice(0, 1, {
      _id: 'j2',
      kind: 'scriptRun',
      subject: { kind: 'scriptRun', id: 'r2' },
      active: true,
      state: 'queued',
      notBefore: new Date(Date.now() + 30_000),
    })
    const before = Date.now()
    await cancelScriptRunState('r2', 'the script was deleted', 30)
    const job = store.jobs.docs.find((candidate) => candidate._id === 'j2')!
    expect(job).toMatchObject({ state: 'queued', active: true })
    expect((job.notBefore as Date).getTime()).toBeLessThanOrEqual(Date.now())
    expect((job.notBefore as Date).getTime()).toBeGreaterThanOrEqual(before)
  })
})

describe('deleteScriptRunsData', () => {
  it('deletes the S3 prefix, log chunks and document of finished runs only', async () => {
    store.scriptRunLogs.docs.push({ _id: 'r1-0', scriptRunId: 'r1' }, { _id: 'r2-0', scriptRunId: 'r2' })
    expect(await deleteScriptRunsData({ scriptId: SCRIPT })).toBe(1)
    expect(deletedPrefixes).toEqual(['script-runs/r1/'])
    expect(store.scriptRuns.docs.map((doc) => doc._id)).toEqual(['r2', 'r3'])
    expect(store.scriptRunLogs.docs.map((doc) => doc._id)).toEqual(['r2-0'])
  })
})

describe('latestRun pointer', () => {
  it('keeps the run created last when two starts write their pointers out of order', async () => {
    const newer = { _id: 'r5', scriptId: SCRIPT, state: 'queued' as const, createdAt: new Date(Date.UTC(2026, 10, 8, 20, 0, 1)), finishedAt: null }
    const older = { _id: 'r4', scriptId: SCRIPT, state: 'queued' as const, createdAt: new Date(Date.UTC(2026, 10, 8, 20, 0, 0)), finishedAt: null }
    store.scripts.docs[0]!.latestRun = null
    await setLatestRunPointer(newer)
    await setLatestRunPointer(older)
    expect(store.scripts.docs[0]!.latestRun).toMatchObject({ id: 'r5' })
  })
})
