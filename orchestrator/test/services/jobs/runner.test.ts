import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobDoc } from '../../../server/types/documents'
import type { Config } from '../../../server/utils/config'
import { cancelActiveJobs, createJob, FatalJobError, type JobKindDefinition, JOB_LEASE_MS } from '../../../server/utils/jobs'
import { backoffDelay, JobsRunner } from '../../../server/services/jobs/runner'
import { type Logger, useLogger } from '../../../server/utils/logger'
import { FakeCollection } from '../../helpers/fake-collection'

// The jobs runner (docs/data-model.md §4.12, §6.8): leased claims, cursors, retries with backoff, per-kind and
// per-user concurrency, lease expiry and cancellation.

const config = {} as Config
const log = useLogger('test').child({})
let jobs: FakeCollection<JobDoc>
let runners: JobsRunner[]
/** added to the real time: createJob stamps notBefore with the real time, tests move the runner time forward */
let offset: number
const now = () => new Date(Date.now() + offset)

function newJobs(): FakeCollection<JobDoc> {
  return new FakeCollection<JobDoc>('jobs', [{ keys: ['kind', 'subject.id'], partialFilter: { active: true } }])
}

function runner(kinds: [JobDoc['kind'], JobKindDefinition][], owner = 'runner-1'): JobsRunner {
  const created = new JobsRunner({
    component: 'reconciler',
    jobs: jobs.asCollection(),
    kinds,
    config,
    log,
    owner,
    now,
    pollMs: 5,
    renewMs: 20,
  })
  runners.push(created)
  return created
}

function job(id: string): JobDoc {
  const found = jobs.docs.find((doc) => doc._id === id)
  if (!found) throw new Error(`job ${id} missing`)
  return found as unknown as JobDoc
}

async function create(kind: JobDoc['kind'], subjectId: string, userId: string | null = 'u1', maxAttempts?: number) {
  return (await createJob({ kind, userId, subject: { kind: 'scan', id: subjectId }, ...(maxAttempts ? { maxAttempts } : {}) }, jobs.asCollection())).job
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  jobs = newJobs()
  runners = []
  offset = 0
})

afterEach(async () => {
  for (const instance of runners) await instance.stop(100)
})

describe('createJob', () => {
  it('inserts a queued active job', async () => {
    const created = await create('scanDelete', 's1')
    expect(created).toMatchObject({ kind: 'scanDelete', state: 'queued', active: true, attempts: 0, maxAttempts: 5, cursor: {}, lease: null })
  })

  it('returns the active job of the same kind and subject instead of a second one', async () => {
    const first = await create('scanDelete', 's1')
    const second = await createJob({ kind: 'scanDelete', userId: 'u1', subject: { kind: 'scan', id: 's1' } }, jobs.asCollection())
    expect(second).toEqual({ job: expect.objectContaining({ _id: first._id }), created: false })
    expect(jobs.docs).toHaveLength(1)
  })

  it('allows a new job once the previous one finished', async () => {
    const first = await create('scanDelete', 's1')
    expect(await cancelActiveJobs('scanDelete', 's1', jobs.asCollection())).toBe(1)
    expect(job(first._id)).toMatchObject({ state: 'cancelled', active: false })
    expect((await create('scanDelete', 's1'))._id).not.toBe(first._id)
  })
})

describe('JobsRunner', () => {
  it('runs a job to success and persists cursor and progress', async () => {
    const seen: Record<string, unknown>[] = []
    const instance = runner([
      [
        'scanDelete',
        {
          component: 'reconciler',
          concurrency: 1,
          async handler(claimed, ctx) {
            seen.push(claimed.cursor)
            await ctx.saveCursor({ phase: 'analyses', afterSeq: 10 }, { done: 1, total: 2 })
            await ctx.setProgress(2)
          },
        },
      ],
    ])
    const created = await create('scanDelete', 's1')
    instance.start()
    await vi.waitFor(() => expect(job(created._id).state).toBe('succeeded'))
    expect(job(created._id)).toMatchObject({
      active: false,
      attempts: 1,
      lease: null,
      cursor: { phase: 'analyses', afterSeq: 10 },
      progress: { done: 2, total: 2 },
      error: null,
    })
    expect(Math.abs(job(created._id).expiresAt!.getTime() - (Date.now() + 7 * 86_400_000))).toBeLessThan(5000)
    expect(seen).toEqual([{}])
  })

  it('claims FIFO and never runs more than the kind’s concurrency', async () => {
    const gate = deferred()
    let running = 0
    let peak = 0
    const order: string[] = []
    const instance = runner([
      [
        'scanDelete',
        {
          component: 'reconciler',
          concurrency: 2,
          async handler(claimed) {
            order.push(claimed.subject.id)
            running++
            peak = Math.max(peak, running)
            await gate.promise
            running--
          },
        },
      ],
    ])
    for (const id of ['a', 'b', 'c', 'd']) {
      await create('scanDelete', id)
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    instance.start()
    await vi.waitFor(() => expect(order).toHaveLength(2))
    expect(order).toEqual(['a', 'b'])
    expect(instance.activeCount).toBe(2)
    gate.resolve()
    await vi.waitFor(() => expect(jobs.docs.every((doc) => doc.state === 'succeeded')).toBe(true))
    expect(order).toEqual(['a', 'b', 'c', 'd'])
    expect(peak).toBe(2)
  })

  it('limits jobs per owner when the kind asks for it', async () => {
    const gate = deferred()
    const started: string[] = []
    const instance = runner([
      [
        'export',
        {
          component: 'reconciler',
          concurrency: 5,
          perUserConcurrency: 1,
          async handler(claimed) {
            started.push(`${claimed.userId}:${claimed.subject.id}`)
            await gate.promise
          },
        },
      ],
    ])
    await create('export', 'e1', 'alice')
    await create('export', 'e2', 'alice')
    await create('export', 'e3', 'bob')
    instance.start()
    await vi.waitFor(() => expect(started).toHaveLength(2))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(started.sort()).toEqual(['alice:e1', 'bob:e3'])
    gate.resolve()
    await vi.waitFor(() => expect(started).toHaveLength(3))
  })

  it('retries a failed attempt after the backoff, then succeeds', async () => {
    let calls = 0
    const instance = runner([
      [
        'scanDelete',
        {
          component: 'reconciler',
          concurrency: 1,
          backoff: { initialMs: 1000, maxMs: 10_000 },
          async handler() {
            calls++
            if (calls === 1) throw new Error('transient')
          },
        },
      ],
    ])
    const created = await create('scanDelete', 's1')
    instance.start()
    await vi.waitFor(() => expect(job(created._id)).toMatchObject({ state: 'queued', attempts: 1, error: { code: 'jobFailed', message: 'transient' } }))
    expect(job(created._id).notBefore.getTime()).toBeGreaterThan(Date.now() + 500)
    offset += 1000
    await vi.waitFor(() => expect(job(created._id).state).toBe('succeeded'))
    expect(job(created._id).attempts).toBe(2)
    expect(calls).toBe(2)
  })

  it('fails at once on FatalJobError and after the last attempt, calling onFailed once', async () => {
    const failures: string[] = []
    const definition: JobKindDefinition = {
      component: 'reconciler',
      concurrency: 2,
      backoff: { initialMs: 0, maxMs: 0 },
      async handler(claimed) {
        if (claimed.subject.id === 'fatal') throw new FatalJobError('invalidSubject', 'no such scan')
        throw new Error('always')
      },
      async onFailed(failed, error) {
        failures.push(`${failed.subject.id}:${error.code}`)
      },
    }
    const instance = runner([['scanDelete', definition]])
    const fatal = await create('scanDelete', 'fatal')
    const flaky = await create('scanDelete', 'flaky', 'u1', 2)
    instance.start()
    await vi.waitFor(() => expect([job(fatal._id).state, job(flaky._id).state]).toEqual(['failed', 'failed']))
    expect(job(fatal._id)).toMatchObject({ attempts: 1, active: false, error: { code: 'invalidSubject', message: 'no such scan' } })
    expect(job(flaky._id)).toMatchObject({ attempts: 2, active: false, error: { code: 'jobFailed', message: 'always' } })
    expect(failures.sort()).toEqual(['fatal:invalidSubject', 'flaky:jobFailed'])
  })

  it('aborts a handler whose job was cancelled and does not overwrite the cancellation', async () => {
    let aborted = false
    const instance = runner([
      [
        'scanDelete',
        {
          component: 'reconciler',
          concurrency: 1,
          async handler(_claimed, ctx) {
            await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()))
            aborted = true
            await ctx.saveCursor({ phase: 'late' })
          },
        },
      ],
    ])
    const created = await create('scanDelete', 's1')
    instance.start()
    await vi.waitFor(() => expect(job(created._id).state).toBe('running'))
    await cancelActiveJobs('scanDelete', 's1', jobs.asCollection())
    await vi.waitFor(() => expect(aborted).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(job(created._id)).toMatchObject({ state: 'cancelled', active: false, cursor: {} })
  })

  it('logs a job cancelled while its handler was finishing as cancelled, not as a lost lease', async () => {
    const messages: string[] = []
    const record = (level: string) => (message: string) => void messages.push(`${level}: ${message}`)
    const recording = { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') } as unknown as Logger
    Object.assign(recording, { child: () => recording })
    const release = deferred()
    // The lease renewal is slow here, so the handler returns before the runner notices the cancellation.
    const instance = new JobsRunner({
      component: 'reconciler',
      jobs: jobs.asCollection(),
      kinds: [['scanDelete', { component: 'reconciler', concurrency: 1, handler: () => release.promise }]],
      config,
      log: recording,
      owner: 'runner-1',
      now,
      pollMs: 5,
      renewMs: 60_000,
    })
    runners.push(instance)
    const created = await create('scanDelete', 's1')
    instance.start()
    await vi.waitFor(() => expect(job(created._id).state).toBe('running'))
    await cancelActiveJobs('scanDelete', 's1', jobs.asCollection())
    release.resolve()
    await vi.waitFor(() => expect(messages).toContain('info: job cancelled'))
    expect(messages).not.toContain('warn: job finished after losing its lease')
    expect(job(created._id).state).toBe('cancelled')
  })

  it('requeues jobs whose lease expired and fails them once attempts are exhausted', async () => {
    const stale = await create('scanDelete', 'stale', 'u1', 3)
    const exhausted = await create('scanDelete', 'exhausted', 'u1', 1)
    for (const [id, attempts] of [
      [stale._id, 1],
      [exhausted._id, 1],
    ] as const) {
      await jobs.updateOne(
        { _id: id },
        { $set: { state: 'running', attempts, lease: { owner: 'dead-runner', expiresAt: new Date(Date.now() - JOB_LEASE_MS) } } },
      )
    }
    const instance = runner([['scanDelete', { component: 'reconciler', concurrency: 0, async handler() {} }]])
    instance.start()
    await vi.waitFor(() => expect([job(stale._id).state, job(exhausted._id).state]).toEqual(['queued', 'failed']))
    expect(job(stale._id).lease).toBeNull()
    expect(job(exhausted._id).error).toEqual({ code: 'leaseExpired', message: 'the job lease expired too often' })
  })

  it('requeues running jobs when it stops', async () => {
    const instance = runner([
      [
        'scanDelete',
        {
          component: 'reconciler',
          concurrency: 1,
          handler: (_claimed, ctx) => new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve())),
        },
      ],
    ])
    const created = await create('scanDelete', 's1')
    instance.start()
    await vi.waitFor(() => expect(job(created._id).state).toBe('running'))
    await instance.stop(100)
    expect(job(created._id)).toMatchObject({ state: 'queued', lease: null, active: true })
  })

  it('only claims its own kinds', async () => {
    const other = await create('taskDelete', 't1')
    const instance = runner([['scanDelete', { component: 'reconciler', concurrency: 1, async handler() {} }]])
    instance.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(job(other._id).state).toBe('queued')
  })
})

describe('backoffDelay', () => {
  it('doubles up to the maximum', () => {
    expect([1, 2, 3, 10].map((attempt) => backoffDelay(attempt, { initialMs: 1000, maxMs: 5000 }))).toEqual([1000, 2000, 4000, 5000])
  })
})
