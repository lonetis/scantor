import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobDoc, RevisionDoc, TaskDoc } from '../../../server/types/documents'
import type { Config } from '../../../server/utils/config'
import { useLogger } from '../../../server/utils/logger'
import { FakeCollection } from '../../helpers/fake-collection'

// A revision whose build job goes back to `queued` without finishing (the orchestrator stops, a runner dies, a
// retryable failure) is `queued` again until the next attempt claims the job (docs/data-model.md §6.4 building →
// queued), in the revision and in the task's latestRevision mirror.

const store = {
  tasks: new FakeCollection<TaskDoc>('tasks'),
  revisions: new FakeCollection<RevisionDoc>('revisions'),
  jobs: new FakeCollection<JobDoc>('jobs', [{ keys: ['kind', 'subject.id'], partialFilter: { active: true } }]),
}

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => ({ tasks: store.tasks.asCollection(), revisions: store.revisions.asCollection(), jobs: store.jobs.asCollection() }),
}))

const { requeueRevision, revisionBuildJobKind } = await import('../../../server/services/revisions/build')
const { JobsRunner } = await import('../../../server/services/jobs/runner')
const { createJob } = await import('../../../server/utils/jobs')

const log = useLogger('test').child({})
const TASK_ID = '7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c'
const REVISION_ID = 'c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
let runners: InstanceType<typeof JobsRunner>[]

function revisionDoc(state: RevisionDoc['state']): RevisionDoc {
  return {
    _id: REVISION_ID,
    userId: 'u1',
    taskId: TASK_ID,
    taskName: 'echo',
    number: 3,
    state,
    message: null,
    source: { kind: 'workspace', packSha256: 'aaa', packBytes: 10, fileCount: 2 },
    snapshotKey: `snapshots/${TASK_ID}/aaa.tar.gz`,
    privileged: false,
    buildLogKey: `build-logs/${REVISION_ID}.ndjson`,
    errors: [],
    jobId: 'j',
    createdAt: new Date('2026-10-21T09:01:00Z'),
    updatedAt: new Date('2026-10-21T09:01:00Z'),
  }
}

async function seed(state: RevisionDoc['state']): Promise<void> {
  await store.revisions.insertOne(revisionDoc(state))
  await store.tasks.insertOne({ _id: TASK_ID, name: 'echo', latestRevision: { id: REVISION_ID, number: 3, state } } as unknown as TaskDoc)
}

const revision = () => store.revisions.docs.find((doc) => doc._id === REVISION_ID) as unknown as RevisionDoc
const mirrored = () => (store.tasks.docs.find((doc) => doc._id === TASK_ID) as unknown as TaskDoc).latestRevision?.state
const job = (id: string) => store.jobs.docs.find((doc) => doc._id === id) as unknown as JobDoc

beforeEach(() => {
  for (const collection of Object.values(store)) collection.docs.length = 0
  runners = []
})

afterEach(async () => {
  for (const runner of runners) await runner.stop(100)
})

describe('requeueRevision', () => {
  it('puts a building revision and its task mirror back to queued', async () => {
    await seed('building')
    await requeueRevision(REVISION_ID, log)
    expect(revision().state).toBe('queued')
    expect(mirrored()).toBe('queued')
  })

  it('leaves finished and queued revisions alone', async () => {
    for (const state of ['ready', 'failed', 'queued'] as const) {
      for (const collection of Object.values(store)) collection.docs.length = 0
      await seed(state)
      await requeueRevision(REVISION_ID, log)
      expect(revision().state).toBe(state)
      expect(mirrored()).toBe(state)
    }
  })
})

describe('the revisionBuild job kind', () => {
  it('puts the revision back to queued when a stopping runner requeues its job', async () => {
    await seed('queued')
    const runner = new JobsRunner({
      component: 'api',
      jobs: store.jobs.asCollection(),
      kinds: [
        [
          'revisionBuild',
          {
            ...revisionBuildJobKind,
            concurrency: 1,
            // The build: the revision is building until the orchestrator stops.
            async handler(_claimed, ctx) {
              await store.revisions.updateOne({ _id: REVISION_ID }, { $set: { state: 'building' } })
              await store.tasks.updateOne({ _id: TASK_ID }, { $set: { 'latestRevision.state': 'building' } })
              await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()))
            },
          },
        ],
      ],
      config: {} as Config,
      log,
      owner: 'runner-1',
      pollMs: 5,
      renewMs: 20,
    })
    runners.push(runner)
    const { job: created } = await createJob(
      { kind: 'revisionBuild', userId: 'u1', subject: { kind: 'revision', id: REVISION_ID }, params: { revisionId: REVISION_ID } },
      store.jobs.asCollection(),
    )
    runner.start()
    await vi.waitFor(() => expect(revision().state).toBe('building'))
    await runner.stop(100)
    expect(job(created._id)).toMatchObject({ state: 'queued', lease: null, active: true })
    expect(revision().state).toBe('queued')
    expect(mirrored()).toBe('queued')
  })
})
