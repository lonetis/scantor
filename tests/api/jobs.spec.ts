import { randomUUID } from 'node:crypto'
import type { JobAccepted, Page } from '#shared/types/common'
import type { Job } from '#shared/types/jobs'
import type { TestRun } from '#shared/types/test-runs'
import { ok, type ApiClient } from '../helpers/api-client'
import { callLong, testRunJob, uploadResultsetWorkspace, waitUntilAnalysisRuns } from '../helpers/api-results'
import { createUser } from '../helpers/users'
import { expect, test as fixturesTest } from '../fixtures'
import { apiResultsTest } from '../helpers/api-results-fixtures'

const test = apiResultsTest(fixturesTest)

// Background jobs (docs/api.md §4.16, docs/data-model.md §4.12): users see their own jobs, admins every job, including
// jobs without a user. The jobs of a worker's tenant used here are the succeeded revisionBuild job of the worker's
// resultset task and the testRun job of a sleeping test run, which stays unsettled until the test cancels the run.
// No test waits for a scanDelete or userPurge job: both run few at a time for the whole suite.

async function allJobs(api: ApiClient, query: Record<string, string>): Promise<Job[]> {
  const jobs: Job[] = []
  let cursor: string | undefined
  do {
    const page = ok(await api.call<Page<Job>>('listJobs', { query: { ...query, limit: 200, cursor } }), 'listJobs')
    jobs.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return jobs
}

test.describe('jobs of the tenant', () => {
  test(
    'listJobs shows a user their own jobs; admins see all and filter by userId',
    { tag: ['@JOB-001'] },
    async ({ api, otherApi, adminApi, user, otherUser, tasks, resultset }) => {
      // A second job of the tenant, newer than the build: the taskDelete job of a workspace-only task (not awaited).
      const task = await uploadResultsetWorkspace(api, tasks)
      const deletion = ok(await api.deleteTask(task.name), 'deleteTask').job
      const deletions = await allJobs(api, { kind: 'taskDelete' })
      expect(deletions.find((job) => job.id === deletion.id)).toMatchObject({ kind: 'taskDelete', subject: { kind: 'task', id: task.id } })
      expect(deletions.every((job) => job.kind === 'taskDelete')).toBe(true)

      // The build of the worker's resultset task is the tenant's job.
      const builds = await allJobs(api, { kind: 'revisionBuild', state: 'succeeded' })
      const build = builds.find((job) => job.subject.id === resultset.revision.id)
      expect(Object.keys(build ?? {}).sort()).toEqual([
        'attempts',
        'createdAt',
        'error',
        'finishedAt',
        'id',
        'kind',
        'progress',
        'startedAt',
        'state',
        'subject',
      ])
      expect(build).toMatchObject({
        kind: 'revisionBuild',
        subject: { kind: 'revision', id: resultset.revision.id },
        state: 'succeeded',
        progress: { done: expect.any(Number) },
        attempts: expect.any(Number),
        error: null,
        createdAt: expect.any(String),
        startedAt: expect.any(String),
        finishedAt: expect.any(String),
      })
      expect(ok(await api.call<Job>('getJob', { path: { jobId: build!.id } }), 'getJob')).toEqual(build)
      // The filters combine.
      expect(builds.every((job) => job.kind === 'revisionBuild' && job.state === 'succeeded')).toBe(true)
      expect((await allJobs(api, { kind: 'revisionBuild', state: 'failed' })).map((job) => job.id)).not.toContain(build!.id)
      expect((await allJobs(api, { kind: 'taskDelete' })).map((job) => job.id)).not.toContain(build!.id)

      // Newest first, cursor pages without overlap: one job per page lists the deletion before the older build.
      const paged: Job[] = []
      let cursor: string | null = null
      do {
        const page: Page<Job> = ok(await api.call<Page<Job>>('listJobs', { query: { limit: 1, ...(cursor ? { cursor } : {}) } }), 'listJobs')
        expect(page.items.length).toBeLessThanOrEqual(1)
        paged.push(...page.items)
        cursor = page.nextCursor
      } while (cursor)
      const ids = paged.map((job) => job.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids.indexOf(deletion.id)).toBeGreaterThanOrEqual(0)
      expect(ids.indexOf(deletion.id)).toBeLessThan(ids.indexOf(build!.id))
      const created = paged.map((job) => Date.parse(job.createdAt))
      expect(created).toEqual([...created].sort((a, b) => b - a))

      // Another user never sees the job; an admin sees it, also filtered by its owner.
      expect((await allJobs(otherApi, { kind: 'revisionBuild' })).map((job) => job.id)).not.toContain(build!.id)
      expect((await allJobs(adminApi, { kind: 'revisionBuild' })).map((job) => job.id)).toContain(build!.id)
      expect((await allJobs(adminApi, { kind: 'revisionBuild', userId: user.id })).map((job) => job.id)).toContain(build!.id)
      expect((await allJobs(adminApi, { kind: 'revisionBuild', userId: otherUser.id })).map((job) => job.id)).not.toContain(build!.id)

      // Only admins may name another user.
      const foreignFilter = await api.call('listJobs', { query: { userId: otherUser.id } })
      expect(foreignFilter.status).toBe(403)
      expect(foreignFilter.body).toMatchObject({ error: { code: 'adminRequired' } })
      expect((await api.call('listJobs', { query: { userId: user.id, kind: 'revisionBuild' } })).status).toBe(200)
      for (const query of [{ kind: 'nosuch' }, { state: 'done' }, { limit: 201 }, { userId: 'not-a-uuid' }]) {
        const response = await api.call('listJobs', { query })
        expect(response.status, JSON.stringify(query)).toBe(400)
        expect(response.body).toMatchObject({ error: { code: 'validationFailed' } })
      }
    },
  )

  test('getJob?wait holds until the job finished; another user’s job is 404', { tag: ['@JOB-002'] }, async ({ api, otherApi, adminApi, tasks, resultset }) => {
    test.setTimeout(180_000)
    // A settled job returns at once.
    const builds = ok(await api.call<Page<Job>>('listJobs', { query: { kind: 'revisionBuild', state: 'succeeded', limit: 200 } }), 'listJobs')
    const build = builds.items.find((job) => job.subject.id === resultset.revision.id)!
    const settled = await api.call<Job>('getJob', { path: { jobId: build.id }, query: { wait: 30 } })
    expect(settled.status).toBe(200)
    expect(settled.headers['scantor-wait']).toBe('settled')
    expect(settled.body).toEqual(build)

    // The testRun job of a sleeping run stays unsettled until the run is cancelled.
    const task = await uploadResultsetWorkspace(api, tasks)
    const run = ok(
      await api.call<TestRun>('testTask', { path: { task: task.name }, body: { scanConfig: { items: ['slow'] }, taskConfig: { sleep_seconds: 600 } } }),
      'testTask',
    )
    const job = await testRunJob(api, run.id)
    expect(job).toMatchObject({ kind: 'testRun', subject: { kind: 'testRun', id: run.id } })

    const plain = await api.call<Job>('getJob', { path: { jobId: job.id } })
    expect(plain.status).toBe(200)
    expect(plain.headers['scantor-wait']).toBeUndefined()
    const early = await api.call<Job>('getJob', { path: { jobId: job.id }, query: { wait: 1 } })
    expect(early.status).toBe(200)
    expect(early.headers['scantor-wait']).toBe('timeout')
    expect(['queued', 'running']).toContain(early.body.state)

    // Cancel only once the analysis runs (docs: a cancellation during the container start is not seen at once).
    await waitUntilAnalysisRuns(api, run.id, 'slow')
    const started = Date.now()
    const held = callLong<Job>(api, 'getJob', { path: { jobId: job.id }, query: { wait: 60 } }, 90_000)
    ok(await api.call('cancelTestRun', { path: { testRunId: run.id } }), 'cancelTestRun')
    const done = await held
    expect(done.status).toBe(200)
    expect(done.headers['scantor-wait']).toBe('settled')
    expect(done.body).toMatchObject({ id: job.id, state: 'cancelled', finishedAt: expect.any(String) })
    expect(Date.now() - started).toBeLessThan(55_000)

    expect((await otherApi.call('getJob', { path: { jobId: job.id } })).status).toBe(404)
    expect((await otherApi.call('getJob', { path: { jobId: job.id } })).body).toMatchObject({ error: { code: 'notFound' } })
    expect(ok(await adminApi.call<Job>('getJob', { path: { jobId: job.id } }), 'getJob').id).toBe(job.id)
    for (const id of [randomUUID(), 'not-a-job']) expect((await api.call('getJob', { path: { jobId: id } })).status, id).toBe(404)
  })
})

test.describe('jobs without a user', () => {
  test('admins see jobs without a user and jobs of deleted users; users do not', { tag: ['@JOB-001', '@JOB-002'] }, async ({ api, adminApi, docker }) => {
    // White-box: no API creates a job without a user, so a finished one is inserted directly (removed afterwards; the
    // TTL index would remove it within the hour anyway).
    const ownerless = randomUUID()
    const now = Date.now()
    await docker.mongosh(
      `const now = new Date(${now}); db.jobs.insertOne({ _id: ${JSON.stringify(ownerless)}, kind: 'userPurge', userId: null, subject: { kind: 'user', id: ${JSON.stringify(randomUUID())} }, state: 'succeeded', active: false, params: {}, cursor: {}, progress: { done: 1, total: 1 }, attempts: 1, maxAttempts: 1, lease: null, notBefore: now, error: null, createdAt: now, startedAt: now, finishedAt: now, updatedAt: now, expiresAt: new Date(${now + 3_600_000}) })`,
      { as: 'root' },
    )
    try {
      // A user created and deleted by the admin (no sign-in needed): its userPurge job carries the deleted user's id.
      const gone = await createUser(adminApi, { prefix: 'jobs-gone' })
      const accepted = ok(await adminApi.call<JobAccepted>('deleteUser', { path: { userId: gone.id } }), 'deleteUser')
      const purgeId = accepted.job.id

      const adminView = await allJobs(adminApi, { kind: 'userPurge' })
      expect(adminView.map((job) => job.id)).toEqual(expect.arrayContaining([ownerless, purgeId]))
      expect(ok(await adminApi.call<Job>('getJob', { path: { jobId: ownerless } }), 'getJob')).toMatchObject({
        id: ownerless,
        kind: 'userPurge',
        state: 'succeeded',
      })
      expect((await allJobs(adminApi, { kind: 'userPurge', userId: gone.id })).map((job) => job.id)).toEqual([purgeId])
      expect((await allJobs(adminApi, { kind: 'userPurge', userId: gone.id })).map((job) => job.id)).not.toContain(ownerless)

      const userView = (await allJobs(api, { kind: 'userPurge' })).map((job) => job.id)
      expect(userView).not.toContain(ownerless)
      expect(userView).not.toContain(purgeId)
      for (const jobId of [ownerless, purgeId]) {
        const hidden = await api.call('getJob', { path: { jobId }, query: { wait: 1 } })
        expect(hidden.status, jobId).toBe(404)
        expect(hidden.body).toMatchObject({ error: { code: 'notFound' } })
      }
    } finally {
      await docker.mongosh(`db.jobs.deleteOne({ _id: ${JSON.stringify(ownerless)}, userId: null })`, { as: 'root' })
    }
  })
})
