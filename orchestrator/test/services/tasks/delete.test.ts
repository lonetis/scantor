import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobDoc, RevisionDoc, TaskDoc, TestRunDoc } from '../../../server/types/documents'
import type { Config } from '../../../server/utils/config'
import type { JobContext } from '../../../server/utils/jobs'
import { useLogger } from '../../../server/utils/logger'
import { FakeCollection } from '../../helpers/fake-collection'

// The taskDelete job (docs/data-model.md §4.12, docs/api.md §4.6): resumable phases that stop builds and test runs,
// delete test runs, images, snapshots and build logs, revisions, the workspace folder and the task.

const store = {
  tasks: new FakeCollection<TaskDoc>('tasks'),
  revisions: new FakeCollection<RevisionDoc>('revisions'),
  testRuns: new FakeCollection<TestRunDoc>('testRuns'),
  testRunAnalyses: new FakeCollection('testRunAnalyses'),
  jobs: new FakeCollection<JobDoc>('jobs', [{ keys: ['kind', 'subject.id'], partialFilter: { active: true } }]),
  events: new FakeCollection('events'),
}
const effects: string[] = []

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => Object.fromEntries(Object.entries(store).map(([name, collection]) => [name, collection.asCollection()])),
}))
vi.mock('../../../server/utils/s3', () => ({
  deletePrefix: async (prefix: string) => {
    effects.push(`s3:${prefix}`)
    return 0
  },
  deleteObject: async (key: string) => {
    effects.push(`s3:${key}`)
  },
}))
vi.mock('../../../server/services/helpers/ops', () => ({
  deleteTaskFolder: async (userId: string, task: string) => {
    effects.push(`workspace:${userId}/${task}`)
  },
}))
vi.mock('../../../server/services/revisions/images', () => ({
  deleteTaskManifests: async (taskId: string, digests: string[]) => {
    effects.push(`manifests:${taskId}:${digests.join(',')}`)
    return digests.length
  },
  removeLocalTaskImages: async (taskId: string) => {
    effects.push(`images:${taskId}`)
    return 0
  },
}))

const { taskDeleteJobKind, TASK_DELETE_PHASES } = await import('../../../server/services/tasks/delete')
const { newTaskDoc } = await import('../../../server/services/tasks/store')

function context(job: JobDoc) {
  const cursors: string[] = []
  const ctx: JobContext = {
    job,
    log: useLogger('test'),
    config: {} as Config,
    signal: new AbortController().signal,
    saveCursor: async (cursor) => {
      cursors.push(String(cursor.phase))
    },
    setProgress: async () => {},
  }
  return { ctx, cursors }
}

let task: TaskDoc

beforeEach(async () => {
  for (const collection of Object.values(store)) collection.docs.length = 0
  effects.length = 0
  task = { ...newTaskDoc({ userId: 'u1', name: 'echo', language: 'python', source: { kind: 'scaffold', template: 'single' } }), deletingAt: new Date() }
  await store.tasks.insertOne(task)
  const revision = (number: number, state: RevisionDoc['state'], digest?: string) =>
    ({ _id: `rev-${number}`, taskId: task._id, userId: 'u1', taskName: 'echo', number, state, buildLogKey: `build-logs/rev-${number}.ndjson`, errors: [], ...(digest ? { image: { digest } } : {}), createdAt: new Date(), updatedAt: new Date() }) as unknown as RevisionDoc
  await store.revisions.insertOne(revision(1, 'ready', 'sha256:one'))
  await store.revisions.insertOne(revision(2, 'queued'))
  await store.testRuns.insertOne({ _id: 'tr-1', taskId: task._id, userId: 'u1', state: 'queued' } as unknown as TestRunDoc)
  await store.testRunAnalyses.insertOne({ _id: 'tr-1-0', testRunId: 'tr-1' })
  await store.jobs.insertOne({ _id: 'job-build-2', kind: 'revisionBuild', subject: { kind: 'revision', id: 'rev-2' }, state: 'queued', active: true } as unknown as JobDoc)
})

describe('taskDelete job', () => {
  it('runs every phase in order and removes all data of the task', async () => {
    const job = { _id: 'j', kind: 'taskDelete', subject: { kind: 'task', id: task._id }, cursor: {} } as unknown as JobDoc
    const { ctx, cursors } = context(job)
    await taskDeleteJobKind.handler(job, ctx)
    expect(cursors).toEqual([...TASK_DELETE_PHASES])
    expect(effects).toEqual([
      's3:test-runs/tr-1/',
      `manifests:${task._id}:sha256:one`,
      `images:${task._id}`,
      `s3:snapshots/${task._id}/`,
      's3:build-logs/rev-1.ndjson',
      's3:build-logs/rev-2.ndjson',
      'workspace:u1/echo',
    ])
    expect(store.revisions.docs).toHaveLength(0)
    expect(store.testRuns.docs).toHaveLength(0)
    expect(store.testRunAnalyses.docs).toHaveLength(0)
    expect(store.tasks.docs).toHaveLength(0)
    expect(store.jobs.docs.find((doc) => doc._id === 'job-build-2')).toMatchObject({ state: 'cancelled', active: false })
  })

  it('fails unfinished revisions and cancels active test runs in the stop phase', async () => {
    const job = { _id: 'j', kind: 'taskDelete', subject: { kind: 'task', id: task._id }, cursor: {} } as unknown as JobDoc
    const { ctx } = context(job)
    const failed: string[] = []
    const updateOne = store.revisions.updateOne.bind(store.revisions)
    vi.spyOn(store.revisions, 'findOneAndUpdate').mockImplementation(async (filter, update) => {
      failed.push(String((filter as { _id: string })._id))
      await updateOne(filter, update as never)
      return null
    })
    await taskDeleteJobKind.handler(job, ctx)
    expect(failed).toEqual(['rev-2'])
  })

  it('does not contact the registry when the task never pushed an image', async () => {
    store.revisions.docs.splice(0, 1)
    const job = { _id: 'j', kind: 'taskDelete', subject: { kind: 'task', id: task._id }, cursor: {} } as unknown as JobDoc
    const { ctx } = context(job)
    await taskDeleteJobKind.handler(job, ctx)
    expect(effects.some((effect) => effect.startsWith('manifests:'))).toBe(false)
    expect(effects).toContain(`images:${task._id}`)
  })

  it('resumes at the phase of its cursor', async () => {
    const job = { _id: 'j', kind: 'taskDelete', subject: { kind: 'task', id: task._id }, cursor: { phase: 'workspace' } } as unknown as JobDoc
    const { ctx, cursors } = context(job)
    await taskDeleteJobKind.handler(job, ctx)
    expect(cursors).toEqual(['workspace', 'task'])
    expect(effects).toEqual(['workspace:u1/echo'])
  })

  it('finishes quietly when the task is already gone', async () => {
    store.tasks.docs.length = 0
    const job = { _id: 'j', kind: 'taskDelete', subject: { kind: 'task', id: task._id }, cursor: {} } as unknown as JobDoc
    const { ctx, cursors } = context(job)
    await taskDeleteJobKind.handler(job, ctx)
    expect(cursors).toEqual([])
  })
})
