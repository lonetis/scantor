import type { Page } from '#shared/types/common'
import type { FileDownload } from '#shared/types/exports'
import type { RevisionSummary } from '#shared/types/revisions'
import type { Task } from '#shared/types/tasks'
import type { TestRun, TestRunAnalysis, TestRunStreamEvents } from '#shared/types/test-runs'
import type { Upload } from '#shared/types/uploads'
import { ok, type ApiClient } from '../helpers/api-client'
import {
  callLong,
  download,
  readTestRunStream,
  settledTestRun,
  sha256,
  testRunContainerState,
  testRunContainers,
  testRunJob,
  uploadResultsetWorkspace,
  waitUntilAnalysisRuns,
  watchContainerCreation,
} from '../helpers/api-results'
import { expect, test as fixturesTest, unique } from '../fixtures'
import { apiResultsTest } from '../helpers/api-results-fixtures'

const test = apiResultsTest(fixturesTest)

// Test runs of a task's live workspace (docs/api.md §4.11, docs/tasks.md §11): a draft image built without a
// revision, the local-mode run in a `scantor-t-<id>` container, the representation, the SSE stream, cancellation
// and file downloads. Every test uploads its own copy of the resultset task (helpers/api-results-task.ts) as a
// workspace without publishing it; its manifest sets the per-analysis timeout to 4 minutes.

const MANIFEST_TIMEOUT_MS = 240_000
const DAY_MS = 86_400_000
/** The whole stack runs SCANTOR_TEST_RUN_CONCURRENCY = 2 test runs at a time, so a run may queue behind other suites'. */
const TEST_RUN_TEST_TIMEOUT_MS = 180_000
/** below SCANTOR_MAX_UPLOAD_BYTES (100 MiB) */
const STARTUP_UPLOAD_BYTES = 90 * 1024 * 1024

test.describe.configure({ timeout: TEST_RUN_TEST_TIMEOUT_MS })

type CancelConflict = { error: { code: string; details: { state: string; allowed: string[] } } }

/** cancelTestRun of a finished run is 409 invalidState naming the run's state and the cancellable states. */
async function expectCancelConflict(api: ApiClient, testRunId: string, state: 'completed' | 'failed'): Promise<void> {
  const response = await api.call<CancelConflict>('cancelTestRun', { path: { testRunId } })
  expect(response.status).toBe(409)
  expect(response.body.error).toMatchObject({ code: 'invalidState', details: { state, allowed: ['queued', 'building', 'running'] } })
}

/** testTask, with a request timeout above `wait` (the request context's default is 30 s). */
function testTask(api: ApiClient, task: string, body: Record<string, unknown>, wait?: number) {
  return callLong<TestRun>(api, 'testTask', { path: { task }, body, query: { wait } }, ((wait ?? 0) + 30) * 1000)
}

async function startTestRun(api: ApiClient, task: string, body: Record<string, unknown>): Promise<TestRun> {
  const response = await testTask(api, task, body)
  expect(response.status, JSON.stringify(response.body)).toBe(201)
  return response.body
}

/** Rejects once the run settled before `until` resolved (polled every second); never resolves otherwise. */
async function failIfSettled(api: ApiClient, testRunId: string, until: Promise<unknown>): Promise<never> {
  let done = false
  until.then(
    () => (done = true),
    () => (done = true),
  )
  while (!done) {
    const run = ok(await api.call<TestRun>('getTestRun', { path: { testRunId }, query: { analyses: false } }), 'getTestRun')
    if (!['queued', 'building', 'running'].includes(run.state)) throw new Error(`test run ${testRunId} is ${run.state}: ${JSON.stringify(run.errors)}`)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return new Promise<never>(() => undefined)
}

test.describe('creating and running test runs', () => {
  test(
    'a test run of an unpublished workspace builds a draft image and completes whatever the outcomes',
    { tag: ['@TRUN-001'] },
    async ({ api, tasks, docker: inner }) => {
      const task = await uploadResultsetWorkspace(api, tasks)
      expect(task.revisionCount).toBe(0)

      const created = await startTestRun(api, task.name, { scanConfig: { items: ['ok', 'fatal:on purpose'] } })
      // The run is created queued; the response reloads it, so an idle stack's job may already have started the build.
      expect(created).toMatchObject({ taskId: task.id, taskName: task.name, errors: [] })
      expect(['queued', 'building']).toContain(created.state)

      const { events } = await readTestRunStream(api, created.id)
      const states = events.filter((event) => event.event === 'state').map((event) => (event.data as TestRunStreamEvents['state']).state)
      const order = ['building', 'running', 'completed'].map((state) => states.indexOf(state as TestRun['state']))
      expect(
        order.every((index) => index >= 0),
        states.join(' → '),
      ).toBe(true)
      expect(order).toEqual([...order].sort((a, b) => a - b))

      const run = await settledTestRun(api, created.id)
      expect(run.state).toBe('completed')
      expect(run.errors).toEqual([])
      expect(run.summary).toEqual({ analyses: 2, succeeded: 1, failed: 1 })
      expect(run.packSha256).toBe(task.workspace.packSha256)
      expect(run.draftImage!.ref).toBe(`tasks/${task.id}:draft-${task.workspace.packSha256}`)
      expect(run.draftImage!.digest).toMatch(/^sha256:[0-9a-f]{64}$/)

      // The draft image exists on the master's engine; no revision was created.
      const image = await inner.inspect<{ RepoTags: string[] }>(run.draftImage!.ref)
      expect(image.RepoTags).toContain(run.draftImage!.ref)
      expect(ok(await api.getTask(task.name), 'getTask')).toMatchObject({ revisionCount: 0, latestRevision: null })
      const revisions = ok(await api.call<Page<RevisionSummary>>('listRevisions', { path: { task: task.name } }), 'listRevisions')
      expect(revisions.items).toEqual([])
    },
  )

  test(
    'the settled run carries analyses, summary, draft image and expiry; unchanged content reuses the draft image',
    { tag: ['@TRUN-002', '@TRUN-008'] },
    async ({ api, tasks }) => {
      const task = await uploadResultsetWorkspace(api, tasks)
      const first = await testTask(api, task.name, { scanConfig: { items: ['one', 'two'] }, taskConfig: { text: 'first' } }, 120)
      expect(first.status).toBe(201)
      expect(first.headers['scantor-wait']).toBe('settled')
      const run = first.body
      expect(run.state).toBe('completed')
      expect(run.summary).toEqual({ analyses: 2, succeeded: 2, failed: 0 })
      expect(run.analyses!.map((analysis) => [analysis.seq, analysis.status, analysis.result?.value, analysis.result?.text])).toEqual([
        [0, 'succeeded', 'one', 'first'],
        [1, 'succeeded', 'two', 'first'],
      ])
      expect(run.analyses![0]).toMatchObject({ id: `${run.id}-0`, attempt: 1, config: { item: 'one', index: 0 }, error: null, files: [] })
      expect(run.analyses![0]!.logTail).toContain('stdout one')
      expect(run.draftImage).toEqual({ ref: `tasks/${task.id}:draft-${task.workspace.packSha256}`, digest: expect.stringMatching(/^sha256:/), cached: false })
      expect(run.description).toMatchObject({ schedule: { kind: 'custom' } })
      expect(Date.parse(run.expiresAt) - Date.parse(run.createdAt)).toBe(7 * DAY_MS)

      const second = ok(await testTask(api, task.name, { scanConfig: { items: ['three'] } }, 120), 'testTask')
      expect(second.state).toBe('completed')
      expect(second.draftImage).toEqual({ ...run.draftImage, cached: true })
      // Static checks and describe still ran: the cached run has its own description of the same image.
      expect(second.description).toEqual(run.description)
      expect(second.analyses!.map((analysis) => analysis.result?.value)).toEqual(['three'])

      // A completed run cannot be cancelled.
      await expectCancelConflict(api, run.id, 'completed')
    },
  )

  test('inputs are bounded and default to 5 analyses, 1 attempt and the manifest timeout', { tag: ['@TRUN-003'] }, async ({ api, tasks }) => {
    const task = await uploadResultsetWorkspace(api, tasks)
    const invalid: [string, Record<string, unknown>][] = [
      ['limit', { limit: 0 }],
      ['limit', { limit: 51 }],
      ['limit', { limit: 99 }],
      ['limit', { limit: 2.5 }],
      ['maxAttempts', { maxAttempts: 0 }],
      ['maxAttempts', { maxAttempts: 6 }],
      ['timeoutMs', { timeoutMs: 999 }],
      ['timeoutMs', { timeoutMs: 86_400_001 }],
      ['taskConfig', { taskConfig: 'text' }],
    ]
    for (const [path, body] of invalid) {
      const response = await api.call<{ error: { code: string; details: { issues: { path: string }[] } } }>('testTask', { path: { task: task.name }, body })
      expect(response.status, JSON.stringify(body)).toBe(400)
      expect(response.body.error.code).toBe('validationFailed')
      expect(response.body.error.details.issues.map((issue) => issue.path)).toContain(path)
    }

    const big = { items: ['x'.repeat(1024 * 1024)] }
    const tooLarge = await api.call<{ error: { code: string; details: { limit: number; actual: number } } }>('testTask', {
      path: { task: task.name },
      body: { scanConfig: big },
    })
    expect(tooLarge.status).toBe(413)
    expect(tooLarge.body.error).toMatchObject({ code: 'payloadTooLarge', details: { limit: 1024 * 1024 } })
    expect(tooLarge.body.error.details.actual).toBeGreaterThan(1024 * 1024)

    // The largest accepted values (the run is cancelled at once; only the accepted input matters).
    const bounds = await startTestRun(api, task.name, { limit: 50, maxAttempts: 5, timeoutMs: 1000 })
    expect(bounds.input).toMatchObject({ limit: 50, maxAttempts: 5, timeoutMs: 1000 })
    ok(await api.call('cancelTestRun', { path: { testRunId: bounds.id } }), 'cancelTestRun')

    // Defaults; the timeout comes from the manifest once the draft is described.
    const defaults = ok(await testTask(api, task.name, { scanConfig: { items: Array.from({ length: 8 }, (_, i) => `item-${i}`) } }, 120), 'testTask')
    expect(defaults.state).toBe('completed')
    expect(defaults.input).toMatchObject({ limit: 5, maxAttempts: 1, timeoutMs: MANIFEST_TIMEOUT_MS })
    expect(defaults.summary.analyses).toBe(5)
    expect(defaults.analyses!.map((analysis) => analysis.seq)).toEqual([0, 1, 2, 3, 4])
  })

  test('configs the schema rejects and failing schedules end the run failed with BuildErrors', { tag: ['@TRUN-004', '@TRUN-008'] }, async ({ api, tasks }) => {
    const task = await uploadResultsetWorkspace(api, tasks)

    const config = await testTask(api, task.name, { taskConfig: { text: 5 }, scanConfig: { delay_seconds: 'slow' } }, 120)
    expect(config.status).toBe(201)
    expect(config.body.state).toBe('failed')
    expect(config.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'config', message: 'taskConfig /text: must be string' }),
        expect.objectContaining({ phase: 'config', message: expect.stringMatching(/^scanConfig \/delay_seconds: /) }),
      ]),
    )
    expect(config.body.errors.every((error) => error.phase === 'config')).toBe(true)
    expect(config.body.summary).toEqual({ analyses: 0, succeeded: 0, failed: 0 })
    expect(config.body.analyses).toEqual([])

    const schedule = await testTask(api, task.name, { scanConfig: { fail: true } }, 120)
    expect(schedule.status).toBe(201)
    expect(schedule.body.state).toBe('failed')
    expect(schedule.body.errors).toEqual([expect.objectContaining({ phase: 'schedule', message: expect.stringContaining('schedule failed on purpose') })])

    // A failed run cannot be cancelled.
    await expectCancelConflict(api, schedule.body.id, 'failed')
  })

  test('with analysisConfig the run skips schedule and calls run once', { tag: ['@TRUN-005'] }, async ({ api, tasks }) => {
    const task = await uploadResultsetWorkspace(api, tasks)
    // The scan config would fail the schedule; it is never called.
    const run = ok(await testTask(api, task.name, { scanConfig: { fail: true }, analysisConfig: { item: 'direct', index: 41 }, limit: 10 }, 120), 'testTask')
    expect(run.state).toBe('completed')
    expect(run.input).toMatchObject({ analysisConfig: { item: 'direct', index: 41 } })
    expect(run.summary).toEqual({ analyses: 1, succeeded: 1, failed: 0 })
    expect(run.analyses).toHaveLength(1)
    expect(run.analyses![0]).toMatchObject({ seq: 0, status: 'succeeded', config: { item: 'direct', index: 41 }, result: { item: 'direct', index: 41 } })
  })
})

test.describe('reading test runs', () => {
  test(
    'listTestRuns pages newest first without analyses; getTestRun includes them unless analyses=false',
    { tag: ['@TRUN-006'] },
    async ({ api, otherApi, tasks }) => {
      const task = await uploadResultsetWorkspace(api, tasks)
      const older = await startTestRun(api, task.name, { scanConfig: { items: ['older'] } })
      const newer = await startTestRun(api, task.name, { scanConfig: { items: ['newer'] } })

      // wait holds until the run settled.
      const held = await callLong<TestRun>(api, 'getTestRun', { path: { testRunId: older.id }, query: { wait: 120 } }, 150_000)
      expect(held.status).toBe(200)
      expect(held.headers['scantor-wait']).toBe('settled')
      expect(held.body.state).toBe('completed')
      expect(held.body.analyses!.map((analysis: TestRunAnalysis) => analysis.result?.value)).toEqual(['older'])
      await settledTestRun(api, newer.id)

      const all = ok(await api.call<Page<TestRun>>('listTestRuns', { path: { task: task.name } }), 'listTestRuns')
      expect(all.items.map((run) => run.id)).toEqual([newer.id, older.id])
      expect(all.nextCursor).toBeNull()
      for (const run of all.items) expect(run).not.toHaveProperty('analyses')
      const firstPage = ok(await api.call<Page<TestRun>>('listTestRuns', { path: { task: task.name }, query: { limit: 1 } }), 'listTestRuns')
      expect(firstPage.items.map((run) => run.id)).toEqual([newer.id])
      const secondPage = ok(
        await api.call<Page<TestRun>>('listTestRuns', { path: { task: task.name }, query: { limit: 1, cursor: firstPage.nextCursor! } }),
        'listTestRuns',
      )
      expect(secondPage.items.map((run) => run.id)).toEqual([older.id])

      const without = ok(await api.call<TestRun>('getTestRun', { path: { testRunId: older.id }, query: { analyses: false } }), 'getTestRun')
      expect(without).not.toHaveProperty('analyses')
      expect(without).toEqual({ ...held.body, analyses: undefined })

      // Another user sees neither the runs nor the task.
      expect((await otherApi.call('getTestRun', { path: { testRunId: older.id } })).status).toBe(404)
      expect((await otherApi.call('listTestRuns', { path: { task: task.id } })).status).toBe(404)
    },
  )

  test('the event stream follows a run live and replays a finished one', { tag: ['@TRUN-007'] }, async ({ api, tasks }) => {
    const task = await uploadResultsetWorkspace(api, tasks)
    const created = await startTestRun(api, task.name, { scanConfig: { items: ['streamed', 'fatal:streamed failure'] } })
    const live = await readTestRunStream(api, created.id)
    expect(live.contentType).toMatch(/^text\/event-stream/)
    const names = live.events.map((event) => event.event)
    expect(names.at(-1)).toBe('end')
    expect(names.filter((name) => name === 'end')).toHaveLength(1)
    expect(new Set(names)).toEqual(new Set(['state', 'log', 'analysis', 'end']))

    const logs = live.events.filter((event) => event.event === 'log').map((event) => event.data as TestRunStreamEvents['log'])
    for (const log of logs) {
      expect(Object.keys(log).sort()).toEqual(['at', 'seq', 'stream', 'text'])
      expect(['stdout', 'stderr', 'build']).toContain(log.stream)
    }
    expect(logs).toContainEqual(expect.objectContaining({ seq: 0, stream: 'stdout', text: 'stdout streamed' }))
    expect(logs.some((log) => log.stream === 'build' && log.seq === null)).toBe(true)

    const analyses = live.events.filter((event) => event.event === 'analysis').map((event) => event.data as TestRunAnalysis)
    expect(analyses.map((analysis) => [analysis.seq, analysis.status])).toEqual([
      [0, 'succeeded'],
      [1, 'failed'],
    ])
    const end = live.events.at(-1)!.data as TestRun
    expect(end).toMatchObject({ id: created.id, state: 'completed', summary: { analyses: 2, succeeded: 1, failed: 1 } })
    expect(end).not.toHaveProperty('analyses')

    // A finished run: state, analyses and end again (logs are not replayed), then the stream ends.
    const replay = await readTestRunStream(api, created.id)
    expect(replay.events.map((event) => event.event)).toEqual(['state', 'analysis', 'analysis', 'end'])
    expect(replay.events[0]!.data).toEqual({ state: 'completed' })
    expect(replay.events.slice(1, 3).map((event) => event.data)).toEqual(analyses)
    expect(replay.events[3]!.data).toEqual(end)

    // A failed run replays its errors as `error` events.
    const failed = ok(await testTask(api, task.name, { scanConfig: { fail: true } }, 120), 'testTask')
    expect(failed.state).toBe('failed')
    const failedReplay = await readTestRunStream(api, failed.id)
    expect(failedReplay.events.map((event) => event.event)).toEqual(['state', ...failed.errors.map(() => 'error'), 'end'])
    expect(failedReplay.events.filter((event) => event.event === 'error').map((event) => event.data)).toEqual(failed.errors)
  })

  test('getTestRunFileDownload serves the exact content of a test-run file', { tag: ['@TRUN-009'] }, async ({ api, otherApi, tasks }) => {
    const task = await uploadResultsetWorkspace(api, tasks)
    const run = ok(await testTask(api, task.name, { scanConfig: { items: ['file:report.txt'] } }, 120), 'testTask')
    expect(run.state).toBe('completed')
    const file = run.analyses![0]!.files[0]!
    const content = 'report of file:report.txt\n'
    expect(file).toEqual({ id: expect.any(String), name: 'report.txt', size: Buffer.byteLength(content), sha256: sha256(content), contentType: 'text/plain' })

    const before = Date.now()
    const link = ok(await api.call<FileDownload>('getTestRunFileDownload', { path: { testRunId: run.id, fileId: file.id } }), 'getTestRunFileDownload')
    expect(link).toMatchObject({ name: 'report.txt', size: file.size, sha256: file.sha256, contentType: 'text/plain', inline: false })
    expect(Date.parse(link.expiresAt) - before).toBeGreaterThan(9 * 60_000)
    const fetched = await download(link.url)
    expect(fetched.status).toBe(200)
    expect(fetched.body.toString('utf8')).toBe(content)
    expect(sha256(fetched.body)).toBe(file.sha256)

    const redirect = await api.call('getTestRunFileDownload', { path: { testRunId: run.id, fileId: file.id }, query: { redirect: true } })
    expect(redirect.status).toBe(302)
    const viaRedirect = await download(redirect.headers.location!)
    expect(viaRedirect.body.toString('utf8')).toBe(content)

    for (const fileId of ['00000000-0000-4000-8000-000000000000', run.id]) {
      const missing = await api.call('getTestRunFileDownload', { path: { testRunId: run.id, fileId } })
      expect(missing.status, fileId).toBe(404)
      expect(missing.body).toMatchObject({ error: { code: 'notFound' } })
    }
    expect((await otherApi.call('getTestRunFileDownload', { path: { testRunId: run.id, fileId: file.id } })).status).toBe(404)
  })
})

test.describe('cancelling test runs', () => {
  // Finished runs (409) are cancelled in the TRUN-002 and TRUN-004 tests, which have them anyway.
  test('cancel stops a running run and removes its container; a repeat returns the cancelled run unchanged', { tag: ['@TRUN-008'] }, async ({ api, tasks }) => {
    const task = await uploadResultsetWorkspace(api, tasks)
    const running = await startTestRun(api, task.name, { scanConfig: { items: ['slow'] }, taskConfig: { sleep_seconds: 600 } })
    await waitUntilAnalysisRuns(api, running.id, 'slow')

    const cancelled = await api.call<TestRun>('cancelTestRun', { path: { testRunId: running.id } })
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.state).toBe('cancelled')
    expect(cancelled.body.finishedAt).toEqual(expect.any(String))
    await expect.poll(() => testRunContainers(running.id), { timeout: 60_000 }).toEqual([])

    const again = await api.call<TestRun>('cancelTestRun', { path: { testRunId: running.id } })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ state: 'cancelled', finishedAt: cancelled.body.finishedAt })
    expect((await settledTestRun(api, running.id)).state).toBe('cancelled')
  })

  test('a queued or building run is cancelled at once and never starts a container', { tag: ['@TRUN-008'] }, async ({ api, tasks }) => {
    const task = await uploadResultsetWorkspace(api, tasks)
    const created = await startTestRun(api, task.name, { scanConfig: { items: ['never'] }, taskConfig: { sleep_seconds: 600 } })
    expect(['queued', 'building']).toContain(created.state)

    // The draft build takes seconds, so the run is still queued or building when the cancel arrives.
    const cancelled = await api.call<TestRun>('cancelTestRun', { path: { testRunId: created.id } })
    expect(cancelled.status).toBe(200)
    expect(cancelled.body).toMatchObject({ id: created.id, state: 'cancelled', finishedAt: expect.any(String) })
    expect(cancelled.body.analyses ?? []).toEqual([])

    // Its testRun job ends cancelled as well, and the run stays cancelled without a container.
    const job = await testRunJob(api, created.id)
    expect(ok(await api.getJob(job.id, 30), 'getJob').state).toBe('cancelled')
    const settled = await settledTestRun(api, created.id)
    expect(settled).toMatchObject({ state: 'cancelled', summary: { analyses: 0, succeeded: 0, failed: 0 } })
    expect(await testRunContainers(created.id)).toEqual([])
  })

  test(
    'a run cancelled while its container is being started is stopped as well',
    { tag: ['@TRUN-008'] },
    async ({ api, tasks }) => {
      const task = await uploadResultsetWorkspace(api, tasks)
      // An upload referenced by the scan config is copied into the container with the runtime between its creation and
      // its start (putArchive); a large one keeps that gap open long enough to cancel inside it.
      const content = Buffer.alloc(STARTUP_UPLOAD_BYTES, 0x61)
      Buffer.from(`${unique('startup')}\n`).copy(content)
      const upload = ok(
        await api.call<Upload>('createUpload', { body: content, headers: { 'Content-Type': 'application/octet-stream' }, query: { name: 'startup.txt' } }),
        'createUpload',
      )
      try {
        // The cancel must arrive while Docker still reports the container `created` (not yet started); an attempt that
        // was too late cannot tell anything and is repeated with a new run.
        let cancelledId: string | null = null
        for (let attempt = 1; attempt <= 3 && !cancelledId; attempt++) {
          const created = await startTestRun(api, task.name, { scanConfig: { items: ['late'], upload: upload.id }, taskConfig: { sleep_seconds: 30 } })
          const watch = watchContainerCreation(`scantor-t-${created.id}`, 150_000)
          try {
            await Promise.race([watch.created, failIfSettled(api, created.id, watch.created)])
          } finally {
            watch.stop()
          }
          const cancelled = ok(await api.call<TestRun>('cancelTestRun', { path: { testRunId: created.id } }), 'cancelTestRun')
          expect(cancelled.state).toBe('cancelled')
          // null: the cancel already removed the container, which only the fixed cancellation does in time.
          const state = await testRunContainerState(created.id)
          if (state === 'created' || state === null) cancelledId = created.id
        }
        // Not an expected failure: without a cancel inside the gap the case was not exercised.
        test.skip(!cancelledId, 'no cancel of three attempts arrived before the container started')
        const testRunId = cancelledId!
        // Removed well before the 30 s analysis could end by itself.
        await expect.poll(() => testRunContainers(testRunId), { timeout: 15_000, intervals: [500] }).toEqual([])
      } finally {
        const deleted = await api.call('deleteUpload', { path: { uploadId: upload.id } })
        expect([204, 404]).toContain(deleted.status)
      }
    },
  )

  test('deleting the task cancels its running test runs', { tag: ['@TRUN-008'] }, async ({ api, tasks }) => {
    const task: Task = await uploadResultsetWorkspace(api, tasks)
    const running = await startTestRun(api, task.name, { scanConfig: { items: ['slow'] }, taskConfig: { sleep_seconds: 600 } })
    await waitUntilAnalysisRuns(api, running.id, 'slow')

    const settled = callLong<TestRun>(api, 'getTestRun', { path: { testRunId: running.id }, query: { wait: 90, analyses: false } }, 120_000)
    const deleted = await api.deleteTask(task.name)
    expect(deleted.status).toBe(202)
    const result = await settled
    expect(result.status).toBe(200)
    expect(result.headers['scantor-wait']).toBe('settled')
    expect(result.body.state).toBe('cancelled')
    await expect.poll(() => testRunContainers(running.id), { timeout: 60_000 }).toEqual([])
  })
})
