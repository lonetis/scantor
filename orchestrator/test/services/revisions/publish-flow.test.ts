import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobDoc, RevisionDoc, TaskDoc } from '../../../server/types/documents'
import { FakeCollection } from '../../helpers/fake-collection'

// publishRevision (docs/tasks.md §10, docs/architecture.md §11.1 step 6): the snapshot is stored before the revision
// exists, identical content of a queued/building/ready revision de-duplicates, numbers are allocated atomically and
// never reused, and every revision gets its revisionBuild job.

const store = {
  tasks: new FakeCollection<TaskDoc>('tasks'),
  revisions: new FakeCollection<RevisionDoc>('revisions'),
  jobs: new FakeCollection<JobDoc>('jobs', [{ keys: ['kind', 'subject.id'], partialFilter: { active: true } }]),
}
let nextHash = 'aaa'
const discarded: string[] = []
const promoted: string[] = []

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => ({ tasks: store.tasks.asCollection(), revisions: store.revisions.asCollection(), jobs: store.jobs.asCollection() }),
}))
vi.mock('../../../server/services/pipeline/snapshot', () => ({
  snapshotToTmp: async () => ({ tmpKey: `tmp/snapshots/${nextHash}.tar.gz`, packSha256: nextHash, packBytes: 100, fileCount: 3, bytes: 300 }),
  promoteSnapshot: async (snapshot: { tmpKey: string; packSha256: string }, taskId: string) => {
    promoted.push(snapshot.packSha256)
    return `snapshots/${taskId}/${snapshot.packSha256}.tar.gz`
  },
  discardTmpSnapshot: async (snapshot: { tmpKey: string }) => {
    discarded.push(snapshot.tmpKey)
  },
}))

const { publishRevision } = await import('../../../server/services/revisions/publish')
const { newTaskDoc } = await import('../../../server/services/tasks/store')

let task: TaskDoc

beforeEach(async () => {
  for (const collection of Object.values(store)) collection.docs.length = 0
  discarded.length = 0
  promoted.length = 0
  task = newTaskDoc({ userId: 'u1', name: 'echo', language: 'python', source: { kind: 'scaffold', template: 'single' } })
  await store.tasks.insertOne(task)
})

describe('publishRevision', () => {
  it('stores the snapshot, numbers the revision and creates its build job', async () => {
    nextHash = 'aaa'
    const { revision, created } = await publishRevision(task, { message: 'first' })
    expect(created).toBe(true)
    expect(revision).toMatchObject({
      number: 1,
      state: 'queued',
      message: 'first',
      taskName: 'echo',
      userId: 'u1',
      source: { kind: 'workspace', packSha256: 'aaa', packBytes: 100, fileCount: 3 },
      snapshotKey: `snapshots/${task._id}/aaa.tar.gz`,
      buildLogKey: `build-logs/${revision._id}.ndjson`,
    })
    expect(promoted).toEqual(['aaa'])
    const job = store.jobs.docs[0] as unknown as JobDoc
    expect(job).toMatchObject({ kind: 'revisionBuild', subject: { kind: 'revision', id: revision._id }, params: { revisionId: revision._id }, state: 'queued', userId: 'u1' })
    expect(revision.jobId).toBe(job._id)
    const stored = (await store.tasks.findOne({ _id: task._id }))!
    expect(stored.revisionSeq).toBe(1)
    expect(stored.latestRevision).toMatchObject({ id: revision._id, number: 1, state: 'queued', packSha256: 'aaa' })
    expect(stored.workspace.packSha256).toBe('aaa')
  })

  it('returns the existing revision for identical content and does not consume a number', async () => {
    nextHash = 'aaa'
    const first = await publishRevision(task)
    const second = await publishRevision(task)
    expect(second.created).toBe(false)
    expect(second.revision._id).toBe(first.revision._id)
    expect(discarded).toEqual(['tmp/snapshots/aaa.tar.gz'])
    expect((await store.tasks.findOne({ _id: task._id }))!.revisionSeq).toBe(1)
  })

  it('does not de-duplicate against failed revisions; failed builds consume numbers', async () => {
    nextHash = 'aaa'
    const first = await publishRevision(task)
    await store.revisions.updateOne({ _id: first.revision._id }, { $set: { state: 'failed' } })
    const second = await publishRevision(task)
    expect(second.created).toBe(true)
    expect(second.revision.number).toBe(2)
    nextHash = 'bbb'
    expect((await publishRevision(task)).revision.number).toBe(3)
  })

  it('records upload provenance for uploadTask', async () => {
    nextHash = 'ccc'
    expect((await publishRevision(task, { viaUpload: true })).revision.source.kind).toBe('upload')
  })
})
