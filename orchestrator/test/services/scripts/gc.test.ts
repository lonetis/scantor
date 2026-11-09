import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobDoc, ScriptDoc, ScriptRunDoc, ScriptRunLogChunkDoc } from '../../../server/types/documents'
import type { Config } from '../../../server/utils/config'
import { FakeCollection } from '../../helpers/fake-collection'

// Garbage collection of script runs (docs/scripts.md §6.8): a run is stale when its job is not active and ended (or,
// without a job, the run was created) more than 5 minutes ago, whatever the run itself still writes; a pending cancel
// whose job does not run ends cancelled after its grace; containers of runs that are still stopping stay; the retention
// keeps the original of an active resumed run.

const store = {
  scripts: new FakeCollection<ScriptDoc>('scripts'),
  scriptRuns: new FakeCollection<ScriptRunDoc>('scriptRuns'),
  scriptRunLogs: new FakeCollection<ScriptRunLogChunkDoc>('scriptRunLogs'),
  jobs: new FakeCollection<JobDoc>('jobs'),
  locks: new FakeCollection('locks'),
}
const removedContainers: string[] = []
const abortedOutputs: string[] = []
const deletedPrefixes: string[] = []
let containers: { Id: string; Names: string[]; Labels: Record<string, string>; Created: number }[] = []

const fakeDocker = {
  listContainers: async () => containers,
  listImages: async () => [],
  getContainer: (id: string) => ({
    remove: async () => {
      removedContainers.push(id)
    },
  }),
  getImage: () => ({ remove: async () => {} }),
}

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => Object.fromEntries(Object.entries(store).map(([name, collection]) => [name, collection.asCollection()])),
}))
vi.mock('../../../server/utils/docker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/utils/docker')>()),
  useDocker: () => fakeDocker,
}))
vi.mock('../../../server/utils/s3', () => ({
  getObjectStream: async () => {
    throw new Error('not used')
  },
  deletePrefix: async (prefix: string) => {
    deletedPrefixes.push(prefix)
  },
}))
vi.mock('../../../server/utils/config', () => ({ useConfig: () => ({ scriptRunRetentionDays: 30 }) }))
vi.mock('../../../server/services/pipeline/binary', () => ({ pipelineEnv: () => ({}), runtimeBinary: () => '/dev/null' }))
vi.mock('../../../server/services/pipeline/slots', () => ({ useBuildSlots: () => ({ acquire: async () => () => {} }) }))
vi.mock('../../../server/services/script-runtime/state', () => ({ flushScriptRunState: async () => {} }))
vi.mock('../../../server/services/script-runtime/outputs', () => ({
  abortPendingOutputs: async (run: { _id: string }) => {
    abortedOutputs.push(run._id)
  },
}))
vi.mock('../../../server/services/scans/events', () => ({ writeEvent: async () => {} }))

const { ScriptsGc } = await import('../../../server/services/scripts/gc')

const NOW = Date.parse('2026-11-08T20:00:00Z')
const MINUTE = 60_000
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => quiet }
const config = { scriptRunTimeoutMs: 3_600_000, scriptRunRetentionDays: 30, draftImageRetentionMs: 86_400_000 } as unknown as Config

function gc() {
  return new ScriptsGc(config, quiet as never, fakeDocker as never)
}

function at(offsetMs: number): Date {
  return new Date(NOW + offsetMs)
}

function seedRun(id: string, extra: Partial<ScriptRunDoc> = {}): void {
  store.scriptRuns.docs.push({
    _id: id,
    userId: 'u1',
    scriptId: 's1',
    state: 'running',
    input: { config: {}, settings: { timeoutMs: null, resources: { cpus: null, memoryMiB: null }, limit: null } },
    container: { id: `cid-${id}`, name: `scantor-s-${id}`, createdAt: at(-60 * MINUTE) },
    errors: [],
    error: null,
    exitCode: null,
    outputs: [],
    restartedFrom: null,
    jobId: `job-${id}`,
    createdAt: at(-60 * MINUTE),
    startedAt: at(-59 * MINUTE),
    finishedAt: null,
    updatedAt: at(-30 * 1000),
    expiresAt: null,
    ...extra,
  } as unknown as ScriptRunDoc)
}

function seedJob(id: string, extra: Partial<JobDoc>): void {
  store.jobs.docs.push({
    _id: `job-${id}`,
    kind: 'scriptRun',
    subject: { kind: 'scriptRun', id },
    finishedAt: null,
    updatedAt: at(-MINUTE),
    ...extra,
  } as unknown as JobDoc)
}

function run(id: string): ScriptRunDoc {
  return store.scriptRuns.docs.find((doc) => doc._id === id) as unknown as ScriptRunDoc
}

beforeEach(() => {
  for (const collection of Object.values(store)) collection.docs.length = 0
  removedContainers.length = 0
  abortedOutputs.length = 0
  deletedPrefixes.length = 0
  containers = []
})

describe('stale runs', () => {
  it('fails a run whose job ended long ago although the run keeps writing progress', async () => {
    seedRun('progressing', { updatedAt: at(-1000) })
    seedJob('progressing', { state: 'failed', active: false, finishedAt: at(-10 * MINUTE) })
    seedRun('active')
    seedJob('active', { state: 'running', active: true })
    seedRun('recent')
    seedJob('recent', { state: 'failed', active: false, finishedAt: at(-MINUTE) })
    seedRun('new', { jobId: '', createdAt: at(-MINUTE) })
    seedRun('orphan', { jobId: '', createdAt: at(-10 * MINUTE) })
    await gc().failStaleRuns(NOW)
    expect(run('progressing')).toMatchObject({ state: 'failed', error: { type: 'platform', message: 'the script run was interrupted; restart it' } })
    expect(run('orphan')).toMatchObject({ state: 'failed' })
    for (const id of ['active', 'recent', 'new']) expect(run(id).state).toBe('running')
    expect(removedContainers.sort()).toEqual(['cid-orphan', 'cid-progressing'])
  })

  it('ends a pending cancel whose job does not run, after its grace', async () => {
    seedRun('stopping', { cancelRequest: { at: at(-10 * MINUTE), reason: null } })
    seedJob('stopping', { state: 'running', active: true })
    seedRun('waiting', { cancelRequest: { at: at(-3 * MINUTE), reason: 'the script was deleted' } })
    seedJob('waiting', { state: 'queued', active: true })
    seedRun('just-cancelled', { cancelRequest: { at: at(-30 * 1000), reason: null } })
    seedJob('just-cancelled', { state: 'queued', active: true })
    await gc().failStaleRuns(NOW)
    expect(run('waiting')).toMatchObject({ state: 'cancelled', error: { type: 'platform', message: 'the script was deleted' } })
    expect(store.jobs.docs.find((job) => job._id === 'job-waiting')).toMatchObject({ state: 'cancelled', active: false })
    expect(removedContainers).toEqual(['cid-waiting'])
    expect(abortedOutputs).toEqual(['waiting'])
    expect(run('stopping').state).toBe('running')
    expect(run('just-cancelled').state).toBe('running')
  })
})

describe('orphan containers', () => {
  it('keeps the container of a run whose cancel is still stopping it', async () => {
    seedRun('stopping', { cancelRequest: { at: at(-MINUTE), reason: null } })
    seedRun('done', { state: 'cancelled' })
    const labels = (id: string) => ({ 'scantor.managed': 'true', 'scantor.kind': 'scriptRun', 'scantor.script-run': id })
    containers = [
      { Id: 'cid-stopping', Names: ['/scantor-s-stopping'], Labels: labels('stopping'), Created: 0 },
      { Id: 'cid-done', Names: ['/scantor-s-done'], Labels: labels('done'), Created: 0 },
    ]
    await gc().removeOrphanContainers()
    expect(removedContainers).toEqual(['cid-done'])
  })
})

describe('expired runs', () => {
  it('keeps the original of an active resumed run', async () => {
    seedRun('original', { state: 'cancelled', finishedAt: at(-31 * 86_400_000), expiresAt: at(-86_400_000) })
    seedRun('other', { state: 'completed', finishedAt: at(-31 * 86_400_000), expiresAt: at(-86_400_000) })
    seedRun('resumed', { restartedFrom: { id: 'original', resume: true } })
    await gc().deleteExpiredRuns(NOW)
    expect(deletedPrefixes).toEqual(['script-runs/other/'])
    expect(store.scriptRuns.docs.map((doc) => doc._id).sort()).toEqual(['original', 'resumed'])
    store.scriptRuns.docs.find((doc) => doc._id === 'resumed')!.state = 'completed'
    await gc().deleteExpiredRuns(NOW)
    expect(store.scriptRuns.docs.map((doc) => doc._id)).toEqual(['resumed'])
  })

  it("moves the script's latestRun off a deleted run to the newest remaining one, or to null", async () => {
    const expired = { finishedAt: at(-31 * 86_400_000), expiresAt: at(-86_400_000) }
    const pointer = (id: string, createdAt: Date) => ({ id, state: 'completed', createdAt, finishedAt: expired.finishedAt })
    store.scripts.docs.push(
      { _id: 's1', latestRun: pointer('only', at(-40 * 86_400_000)) } as unknown as ScriptDoc,
      { _id: 's2', latestRun: pointer('newest', at(-40 * 86_400_000)) } as unknown as ScriptDoc,
      { _id: 's3', latestRun: pointer('kept', at(-MINUTE)) } as unknown as ScriptDoc,
    )
    seedRun('only', { scriptId: 's1', state: 'completed', createdAt: at(-40 * 86_400_000), ...expired })
    seedRun('older', { scriptId: 's2', state: 'failed', createdAt: at(-50 * 86_400_000), finishedAt: at(-50 * 86_400_000), expiresAt: at(86_400_000) })
    seedRun('newest', { scriptId: 's2', state: 'completed', createdAt: at(-40 * 86_400_000), ...expired })
    seedRun('kept', { scriptId: 's3', state: 'completed', createdAt: at(-MINUTE), finishedAt: at(-MINUTE), expiresAt: at(86_400_000) })
    seedRun('stale', { scriptId: 's3', state: 'completed', createdAt: at(-40 * 86_400_000), ...expired })
    await gc().deleteExpiredRuns(NOW)
    const latest = (id: string) => (store.scripts.docs.find((doc) => doc._id === id) as unknown as ScriptDoc).latestRun
    expect(latest('s1')).toBeNull()
    expect(latest('s2')).toEqual({ id: 'older', state: 'failed', createdAt: at(-50 * 86_400_000), finishedAt: at(-50 * 86_400_000) })
    // A pointer at a run that was not deleted stays.
    expect(latest('s3')).toMatchObject({ id: 'kept' })
  })
})
