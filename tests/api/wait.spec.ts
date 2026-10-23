import type { ClientRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { readFileSync } from 'node:fs'
import type { Export } from '#shared/types/exports'
import type { Revision } from '#shared/types/revisions'
import type { UploadTaskResult } from '#shared/types/tasks'
import type { TestRun } from '#shared/types/test-runs'
import { ok, type ApiResponse } from '../helpers/api-client'
import { rawJson, settleScan, testRunJob, UNPLACEABLE_SETTINGS, uploadResultsetWorkspace, waitUntilAnalysisRuns } from '../helpers/api-results'
import { removeResultsetTask, writeResultsetTask } from '../helpers/api-results-task'
import { env } from '../helpers/env'
import { packTask } from '../helpers/tasks'
import { expect, test as fixturesTest, unique } from '../fixtures'
import { apiResultsTest } from '../helpers/api-results-fixtures'

const test = apiResultsTest(fixturesTest)

// Long-polling with `wait` (docs/api.md §1.9): integer seconds 0–120; no Scantor-Wait header without a wait;
// `settled` at once for a settled resource; otherwise the request holds until the resource settles or the time runs
// out (`timeout`), always with the normal status and body. Unsettled resources are made deterministic: a scan whose
// node selector matches no node stays `running`, a revision with a slow build step stays `building` for a while,
// a test run and its testRun job wait for a sleeping analysis. SCANTOR_MAX_CONCURRENT_WAITS is 20 in the stack.

const MAX_CONCURRENT_WAITS = 20
const BUILD_SECONDS = 5

type Timed<T> = ApiResponse<T> & { elapsedMs: number }

async function timed<T>(call: () => Promise<ApiResponse<T>>): Promise<Timed<T>> {
  const started = Date.now()
  const response = await call()
  return { ...response, elapsedMs: Date.now() - started }
}

/** Every waitable operation rejects wait values outside 0–120 seconds and anything but a decimal integer. */
async function expectWaitBounds(what: string, call: (wait: string) => Promise<ApiResponse>): Promise<void> {
  for (const wait of ['121', '-1', '60s', '1.5', 'x']) {
    const response = await call(wait)
    expect(response.status, `${what} wait=${wait}`).toBe(400)
    expect(response.body, `${what} wait=${wait}`).toMatchObject({
      error: { code: 'validationFailed', details: { issues: [expect.objectContaining({ path: 'wait' })] } },
    })
  }
}

/**
 * Repeats a wait request until it answers `Scantor-Wait: settled` (at most `attempts` times); every `timeout` answer
 * must still show the resource unsettled.
 */
async function waitUntilSettled<T>(
  call: () => Promise<{ status: number; headers: Record<string, string>; body: T }>,
  unsettled: (body: T) => boolean,
  attempts = 3,
) {
  for (let attempt = 1; ; attempt++) {
    const response = await call()
    if (response.headers['scantor-wait'] === 'settled') return response
    expect(response.headers['scantor-wait'], JSON.stringify(response.body)).toBe('timeout')
    expect(unsettled(response.body), JSON.stringify(response.body)).toBe(true)
    if (attempt >= attempts) throw new Error(`still unsettled after ${attempts} waits: ${JSON.stringify(response.body)}`)
  }
}

async function packSlowTask(name: string, marker: string): Promise<Buffer> {
  const dir = await writeResultsetTask({ buildSeconds: BUILD_SECONDS, marker })
  try {
    return await packTask(dir, { name })
  } finally {
    await removeResultsetTask(dir)
  }
}

test.describe('wait on long-running operations', () => {
  test('uploadTask, publishRevision and getRevision wait for the revision build', { tag: ['@API-012'] }, async ({ api, tasks }) => {
    test.setTimeout(180_000)
    const name = unique('wait-rev')
    tasks.track(name)
    const revisionPath = (revisionId: string) => `/api/tasks/${name}/revisions/${revisionId}`

    // A workspace without a revision, then a publish whose build takes at least BUILD_SECONDS.
    const workspace = await api.uploadTask(await packSlowTask(name, 'first'), { publish: false })
    expect(workspace.status).toBe(201)
    expect(workspace.headers['scantor-wait']).toBeUndefined()

    const published = await timed(() => api.publishRevision(name, {}, 1))
    expect(published.status).toBe(201)
    expect(published.headers['scantor-wait']).toBe('timeout')
    expect(['queued', 'building']).toContain(published.body.state)
    expect(published.elapsedMs).toBeGreaterThanOrEqual(900)
    const revisionId = published.body.id

    expect((await api.getRevision(name, revisionId)).headers['scantor-wait']).toBeUndefined()
    const zero = await api.getRevision(name, revisionId, 0)
    expect(zero.status).toBe(200)
    expect(zero.headers['scantor-wait']).toBeUndefined()
    const short = await api.getRevision(name, revisionId, 1)
    expect(short.status).toBe(200)
    expect(short.headers['scantor-wait']).toBe('timeout')
    expect(['queued', 'building']).toContain(short.body.state)

    // The held request answers once the build settled (a build queued behind other suites' builds may need longer
    // than one wait; every timeout in between still shows the unfinished build).
    const held = await waitUntilSettled(
      () => rawJson<Revision>(api, 'GET', revisionPath(revisionId), { params: { wait: 50 }, timeoutMs: 80_000 }),
      (revision) => ['queued', 'building'].includes(revision.state),
    )
    expect(held.status).toBe(200)
    expect(held.body.state).toBe('ready')

    // Settled resources return at once.
    const again = await timed(() => api.getRevision(name, revisionId, 60))
    expect(again.headers['scantor-wait']).toBe('settled')
    expect(again.elapsedMs).toBeLessThan(10_000)
    const republished = await timed(() => api.publishRevision(name, {}, 60))
    expect(republished.body.id).toBe(revisionId)
    expect(republished.headers['scantor-wait']).toBe('settled')
    expect(republished.elapsedMs).toBeLessThan(10_000)
    expect((await api.publishRevision(name, {})).headers['scantor-wait']).toBeUndefined()

    // uploadTask with new content: the revision part times out, then holds until the build settled; the same
    // content again is settled at once.
    const changed = await packSlowTask(name, 'second')
    const uploaded = await timed(() => api.uploadTask(changed, { publish: true, wait: 1 }))
    expect(uploaded.status).toBe(201)
    expect(uploaded.headers['scantor-wait']).toBe('timeout')
    expect(['queued', 'building']).toContain(uploaded.body.revision!.state)
    const settledUpload = await waitUntilSettled(
      () =>
        rawJson<UploadTaskResult>(api, 'POST', api.openapi.get('uploadTask').path, {
          data: changed,
          headers: { 'Content-Type': 'application/gzip' },
          params: { publish: 'true', wait: 50 },
          timeoutMs: 80_000,
        }),
      (result) => ['queued', 'building'].includes(result.revision!.state),
    )
    expect(settledUpload.status).toBe(201)
    expect(settledUpload.body.revision).toMatchObject({ id: uploaded.body.revision!.id, state: 'ready' })
    const unchanged = await timed(() => api.uploadTask(changed, { publish: true, wait: 60 }))
    expect(unchanged.status).toBe(201)
    expect(unchanged.headers['scantor-wait']).toBe('settled')
    expect(unchanged.body.revision!.id).toBe(uploaded.body.revision!.id)
    expect(unchanged.elapsedMs).toBeLessThan(15_000)
    expect((await api.uploadTask(changed, { publish: true })).headers['scantor-wait']).toBeUndefined()

    await expectWaitBounds('getRevision', (wait) => api.call('getRevision', { path: { task: name, revision: revisionId }, query: { wait } }))
    await expectWaitBounds('publishRevision', (wait) => api.call('publishRevision', { path: { task: name }, body: {}, query: { wait } }))
    await expectWaitBounds('uploadTask', (wait) =>
      api.call<UploadTaskResult>('uploadTask', { body: changed, headers: { 'Content-Type': 'application/gzip' }, query: { wait } }),
    )
  })

  test('testTask, getTestRun and getJob wait for the test run and its job', { tag: ['@API-012'] }, async ({ api, tasks }) => {
    test.setTimeout(180_000)
    const task = await uploadResultsetWorkspace(api, tasks)
    const slow = await timed(() =>
      api.call<TestRun>('testTask', {
        path: { task: task.name },
        body: { scanConfig: { items: ['slow'] }, taskConfig: { sleep_seconds: 600 } },
        query: { wait: 1 },
      }),
    )
    expect(slow.status).toBe(201)
    expect(slow.headers['scantor-wait']).toBe('timeout')
    expect(['queued', 'building', 'running']).toContain(slow.body.state)
    expect(slow.elapsedMs).toBeGreaterThanOrEqual(900)
    const testRunId = slow.body.id

    expect((await api.call('getTestRun', { path: { testRunId } })).headers['scantor-wait']).toBeUndefined()
    expect((await api.call('getTestRun', { path: { testRunId }, query: { wait: 0 } })).headers['scantor-wait']).toBeUndefined()
    const short = await api.call<TestRun>('getTestRun', { path: { testRunId }, query: { wait: 1 } })
    expect(short.status).toBe(200)
    expect(short.headers['scantor-wait']).toBe('timeout')
    expect(['queued', 'building', 'running']).toContain(short.body.state)

    // The run's testRun job is unsettled as long as the run.
    const job = await testRunJob(api, testRunId)
    expect((await api.getJob(job.id)).headers['scantor-wait']).toBeUndefined()
    expect((await api.getJob(job.id, 0)).headers['scantor-wait']).toBeUndefined()
    const pendingJob = await timed(() => api.getJob(job.id, 1))
    expect(pendingJob.status).toBe(200)
    expect(pendingJob.headers['scantor-wait']).toBe('timeout')
    expect(['queued', 'running']).toContain(pendingJob.body.state)
    expect(pendingJob.elapsedMs).toBeGreaterThanOrEqual(900)

    // Waits held while the run is cancelled return the cancelled run and job (cancelled once its analysis runs).
    await waitUntilAnalysisRuns(api, testRunId, 'slow')
    const held = timed(() => api.call<TestRun>('getTestRun', { path: { testRunId }, query: { wait: 25 } }))
    const heldJob = timed(() => api.getJob(job.id, 25))
    ok(await api.call('cancelTestRun', { path: { testRunId } }), 'cancelTestRun')
    const released = await held
    expect(released.status).toBe(200)
    expect(released.headers['scantor-wait']).toBe('settled')
    expect(released.body.state).toBe('cancelled')
    expect(released.elapsedMs).toBeLessThan(24_000)
    const releasedJob = await heldJob
    expect(releasedJob.status).toBe(200)
    expect(releasedJob.headers['scantor-wait']).toBe('settled')
    expect(releasedJob.body.state).toBe('cancelled')
    expect(releasedJob.elapsedMs).toBeLessThan(24_000)
    const settledJob = await timed(() => api.getJob(job.id, 60))
    expect(settledJob.headers['scantor-wait']).toBe('settled')
    expect(settledJob.elapsedMs).toBeLessThan(10_000)
    await expectWaitBounds('getJob', (wait) => api.call('getJob', { path: { jobId: job.id }, query: { wait } }))

    const quick = await rawJson<TestRun>(api, 'POST', `/api/tasks/${task.name}/test-runs`, {
      data: { scanConfig: { items: ['quick'] } },
      params: { wait: 120 },
      timeoutMs: 150_000,
    })
    expect(quick.status).toBe(201)
    expect(quick.headers['scantor-wait']).toBe('settled')
    expect(quick.body.state).toBe('completed')
    const settledAgain = await timed(() => api.call<TestRun>('getTestRun', { path: { testRunId: quick.body.id }, query: { wait: 60 } }))
    expect(settledAgain.headers['scantor-wait']).toBe('settled')
    expect(settledAgain.elapsedMs).toBeLessThan(10_000)
    const unwaited = await api.call<TestRun>('testTask', { path: { task: task.name }, body: { scanConfig: { items: ['plain'] } } })
    expect(unwaited.headers['scantor-wait']).toBeUndefined()
    ok(await api.call('cancelTestRun', { path: { testRunId: unwaited.body.id } }), 'cancelTestRun')

    await expectWaitBounds('getTestRun', (wait) => api.call('getTestRun', { path: { testRunId }, query: { wait } }))
    await expectWaitBounds('testTask', (wait) => api.call('testTask', { path: { task: task.name }, body: {}, query: { wait } }))
  })
})

// ── the per-user cap ──────────────────────────────────────────────────────────────────────────────────

interface HeldWait {
  request: ClientRequest
  /** resolves with the status code once the response ended, or `aborted` */
  done: Promise<number | string>
  /** the outcome once the request ended, else null */
  outcome: number | string | null
  /** the response body once it ended */
  body: string
}

/** A getScan?wait request through the public origin that the test can abort (a client disconnect). */
function holdWait(apiKey: string, scanId: string, waitSeconds: number): HeldWait {
  const held: HeldWait = { request: undefined as unknown as ClientRequest, done: Promise.resolve(0), outcome: null, body: '' }
  held.done = new Promise<number | string>((resolve) => {
    const finish = (outcome: number | string) => {
      held.outcome ??= outcome
      resolve(held.outcome)
    }
    held.request = httpsRequest(
      new URL(`${env.publicUrl}/api/scans/${scanId}?wait=${waitSeconds}`),
      { headers: { Authorization: `Bearer ${apiKey}` }, ca: readFileSync(env.caCertFile) },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          held.body = Buffer.concat(chunks).toString('utf8')
          finish(response.statusCode ?? 0)
        })
        response.on('error', () => finish('aborted'))
      },
    )
    held.request.on('error', () => finish('aborted'))
    held.request.end()
  })
  return held
}

test.describe('waits on scans, jobs and exports', () => {
  test('getScan waits until the scan settles', { tag: ['@API-012'] }, async ({ api, resultset }) => {
    const scan = await resultset.start({ scanConfig: { items: ['a'] }, settings: UNPLACEABLE_SETTINGS })
    await settleScan(api, scan.id, 'running', 60_000)

    expect((await api.getScan(scan.id)).headers['scantor-wait']).toBeUndefined()
    expect((await api.getScan(scan.id, 0)).headers['scantor-wait']).toBeUndefined()
    const short = await timed(() => api.getScan(scan.id, 1))
    expect(short.status).toBe(200)
    expect(short.headers['scantor-wait']).toBe('timeout')
    expect(short.body.state).toBe('running')
    expect(short.elapsedMs).toBeGreaterThanOrEqual(900)

    const held = timed(() => api.getScan(scan.id, 25))
    ok(await api.cancelScan(scan.id), 'cancelScan')
    const released = await held
    expect(released.headers['scantor-wait']).toBe('settled')
    expect(released.body.state).toBe('cancelled')
    expect(released.elapsedMs).toBeLessThan(24_000)
    const settled = await timed(() => api.getScan(scan.id, 60))
    expect(settled.headers['scantor-wait']).toBe('settled')
    expect(settled.elapsedMs).toBeLessThan(10_000)
    await expectWaitBounds('getScan', (wait) => api.call('getScan', { path: { scanId: scan.id }, query: { wait } }))
  })

  test('exportScan and getExport wait for the export', { tag: ['@API-012'] }, async ({ api, resultset }) => {
    const scan = await resultset.start({ scanConfig: { items: ['a', 'b', 'c'] } })
    await settleScan(api, scan.id)

    const created = await rawJson<Export>(api, 'POST', `/api/scans/${scan.id}/exports`, { data: { format: 'jsonl' }, params: { wait: 60 }, timeoutMs: 90_000 })
    expect(created.status).toBe(201)
    expect(created.headers['scantor-wait']).toBe('settled')
    expect(created.body).toMatchObject({ state: 'ready', rows: 3 })
    const again = await timed(() => api.call<Export>('getExport', { path: { exportId: created.body.id }, query: { wait: 60 } }))
    expect(again.headers['scantor-wait']).toBe('settled')
    expect(again.elapsedMs).toBeLessThan(10_000)
    expect((await api.call('getExport', { path: { exportId: created.body.id } })).headers['scantor-wait']).toBeUndefined()
    expect((await api.call('getExport', { path: { exportId: created.body.id }, query: { wait: 0 } })).headers['scantor-wait']).toBeUndefined()

    const unwaited = await api.call<Export>('exportScan', { path: { scanId: scan.id }, body: { format: 'csv' } })
    expect(unwaited.status).toBe(201)
    expect(unwaited.headers['scantor-wait']).toBeUndefined()
    const followed = await rawJson<Export>(api, 'GET', `/api/exports/${unwaited.body.id}`, { params: { wait: 60 }, timeoutMs: 90_000 })
    expect(followed.headers['scantor-wait']).toBe('settled')
    expect(followed.body.state).toBe('ready')

    await expectWaitBounds('getExport', (wait) => api.call('getExport', { path: { exportId: created.body.id }, query: { wait } }))
    await expectWaitBounds('exportScan', (wait) => api.call('exportScan', { path: { scanId: scan.id }, body: { format: 'jsonl' }, query: { wait } }))
    for (const exportId of [created.body.id, unwaited.body.id]) ok(await api.call('deleteExport', { path: { exportId } }), 'deleteExport')
  })

  test(
    'more than SCANTOR_MAX_CONCURRENT_WAITS waits of one user are 429; a disconnect frees its slot',
    { tag: ['@API-013'] },
    async ({ api, user, resultset }) => {
      const scan = await resultset.start({ scanConfig: { items: ['a'] }, settings: UNPLACEABLE_SETTINGS })
      await settleScan(api, scan.id, 'running', 60_000)

      // One wait more than the cap at once, and nothing else of this user waits: exactly the last one to arrive is
      // refused, and its refusal proves the other twenty hold their slots.
      const holders = Array.from({ length: MAX_CONCURRENT_WAITS + 1 }, () => holdWait(user.apiKey, scan.id, 100))
      try {
        const ended = () => holders.filter((holder) => holder.outcome !== null)
        await expect.poll(() => ended().map((holder) => holder.outcome), { timeout: 30_000, intervals: [100, 250] }).toEqual([429])
        const refused = ended()[0]!
        expect(JSON.parse(refused.body)).toMatchObject({ error: { code: 'tooManyRequests', details: { limit: MAX_CONCURRENT_WAITS } } })
        const pending = holders.filter((holder) => holder !== refused)
        expect(pending.every((holder) => holder.outcome === null)).toBe(true)

        // A further wait of the same user (session instead of API key) is refused as well.
        const probe = () => api.getScan(scan.id, 1)
        const another = await probe()
        expect(another.status).toBe(429)
        expect(another.body).toMatchObject({ error: { code: 'tooManyRequests', details: { limit: MAX_CONCURRENT_WAITS } } })

        // Aborting one held wait frees exactly its slot: the probe is admitted and holds its one second.
        pending[0]!.request.destroy()
        expect(await pending[0]!.done).toBe('aborted')
        await expect.poll(async () => (await probe()).status, { timeout: 30_000, intervals: [200, 500] }).toBe(200)
        expect((await probe()).headers['scantor-wait']).toBe('timeout')
        expect(pending.slice(1).every((holder) => holder.outcome === null)).toBe(true)
      } finally {
        for (const holder of holders) holder.request.destroy()
        await Promise.all(holders.map((holder) => holder.done))
      }
      // With every holder gone the user waits normally again.
      await expect.poll(async () => (await api.getScan(scan.id, 1)).status, { timeout: 30_000, intervals: [200, 500] }).toBe(200)
    },
  )
})
