import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobDoc, RevisionDoc, TaskDoc, TestRunDoc } from '../../../server/types/documents'
import { FakeCollection } from '../../helpers/fake-collection'

// testTask creation (docs/tasks.md §11.1 step 1) and cancelTestRun (docs/data-model.md §6.5).

const store = {
  testRuns: new FakeCollection<TestRunDoc>('testRuns'),
  revisions: new FakeCollection<RevisionDoc>('revisions'),
  jobs: new FakeCollection<JobDoc>('jobs', [{ keys: ['kind', 'subject.id'], partialFilter: { active: true } }]),
}

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => ({ testRuns: store.testRuns.asCollection(), revisions: store.revisions.asCollection(), jobs: store.jobs.asCollection() }),
}))
vi.mock('../../../server/utils/keys', async (original) => {
  const actual = await original<typeof import('../../../server/utils/keys')>()
  const keyring = actual.createKeyring('test-secret-for-test-runs')
  return { ...actual, useKeys: () => keyring }
})

const { createTestRun, openRequest, validatedSecretsUpdate } = await import('../../../server/services/test-runs/create')
const { cancelTestRun } = await import('../../../server/services/test-runs')
const { toApiTestRun } = await import('../../../server/services/test-runs/mappers')
const { newTaskDoc } = await import('../../../server/services/tasks/store')
const { ApiError } = await import('../../../server/utils/errors')

const config = { maxScanConfigBytes: 1024, testRunRetentionDays: 7 }
let task: TaskDoc

beforeEach(() => {
  for (const collection of Object.values(store)) collection.docs.length = 0
  task = newTaskDoc({ userId: 'u1', name: 'echo', language: 'python', source: { kind: 'scaffold', template: 'single' } })
})

describe('createTestRun', () => {
  it('inserts a queued test run with its job and keeps the requested configs sealed', async () => {
    const doc = await createTestRun(task, { taskConfig: { apiToken: 'secret-value' }, limit: 3, maxAttempts: 2 }, config)
    expect(doc).toMatchObject({ state: 'queued', taskId: task._id, taskName: 'echo', userId: 'u1', input: { limit: 3, maxAttempts: 2, timeoutMs: 300_000 } })
    expect(doc.buildLogKey).toBe(`test-runs/${doc._id}/build.ndjson`)
    expect(doc.logKey).toBe(`test-runs/${doc._id}/log.ndjson`)
    expect(doc.expiresAt.getTime() - doc.createdAt.getTime()).toBe(7 * 86_400_000)
    expect(JSON.stringify(doc)).not.toContain('secret-value')
    expect(JSON.stringify(toApiTestRun(doc))).not.toContain('secrets')
    expect(openRequest(doc)).toEqual({ taskConfig: { apiToken: 'secret-value' } })
    expect(store.jobs.docs[0]).toMatchObject({ kind: 'testRun', subject: { kind: 'testRun', id: doc._id }, params: { testRunId: doc._id } })
  })

  it('takes the provisional timeout from the latest revision and caps config sizes', async () => {
    await store.revisions.insertOne({ _id: 'r1', settingsDefaults: { timeoutMs: 120_000 } } as unknown as RevisionDoc)
    task.latestRevision = { id: 'r1', number: 1, state: 'ready', packSha256: 'a', createdAt: new Date() }
    expect((await createTestRun(task, { limit: 5, maxAttempts: 1 }, config)).input.timeoutMs).toBe(120_000)
    expect((await createTestRun(task, { limit: 5, maxAttempts: 1, timeoutMs: 9000 }, config)).input.timeoutMs).toBe(9000)
    await expect(createTestRun(task, { scanConfig: { big: 'x'.repeat(2000) }, limit: 5, maxAttempts: 1 }, config)).rejects.toMatchObject({ code: 'payloadTooLarge' })
  })
})

describe('validated secrets', () => {
  it('are stored next to the sealed request, so a restarted attempt still finds the requested configs', async () => {
    const requested = { taskConfig: { apiToken: 'secret-value', greeting: 'hi' }, analysisConfig: { target: 'a' }, limit: 1, maxAttempts: 1, timeoutMs: 9000 }
    const doc = await createTestRun(task, requested, config)
    const first = validatedSecretsUpdate({ taskConfig: { '/apiToken': 'enc:v1:a' }, scanConfig: {}, analysisConfig: {} })
    await store.testRuns.updateOne({ _id: doc._id }, { $set: first.set, $unset: first.unset })
    let stored = (await store.testRuns.findOne({ _id: doc._id }))!
    expect(stored.secrets).toMatchObject({ taskConfig: { '/apiToken': 'enc:v1:a' }, scanConfig: {}, analysisConfig: {} })
    expect(openRequest(stored)).toEqual({ taskConfig: { apiToken: 'secret-value', greeting: 'hi' }, analysisConfig: { target: 'a' }, timeoutMs: 9000 })

    // A later attempt without per-analysis secrets drops the earlier ones and keeps the request.
    const second = validatedSecretsUpdate({ taskConfig: { '/apiToken': 'enc:v1:b' }, scanConfig: {} })
    await store.testRuns.updateOne({ _id: doc._id }, { $set: second.set, $unset: second.unset })
    stored = (await store.testRuns.findOne({ _id: doc._id }))!
    expect(stored.secrets?.analysisConfig).toBeUndefined()
    expect(stored.secrets?.taskConfig).toEqual({ '/apiToken': 'enc:v1:b' })
    expect(openRequest(stored)?.taskConfig).toEqual({ apiToken: 'secret-value', greeting: 'hi' })
  })
})

describe('cancelTestRun', () => {
  it('cancels active runs and their job, is idempotent, and refuses finished runs', async () => {
    const doc = await createTestRun(task, { limit: 1, maxAttempts: 1 }, config)
    const cancelled = await cancelTestRun(doc)
    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.secrets?.request).toBeUndefined()
    expect(store.jobs.docs[0]).toMatchObject({ state: 'cancelled', active: false })
    expect((await cancelTestRun(doc)).state).toBe('cancelled')

    const finished = await createTestRun(task, { limit: 1, maxAttempts: 1 }, config)
    await store.testRuns.updateOne({ _id: finished._id }, { $set: { state: 'completed' } })
    try {
      await cancelTestRun(finished)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect((error as InstanceType<typeof ApiError>).details).toEqual({ state: 'completed', allowed: ['queued', 'building', 'running'] })
    }
  })
})
