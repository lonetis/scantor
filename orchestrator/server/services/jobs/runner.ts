import type { Collection, Filter } from 'mongodb'
import type { JobKind, OrchestratorComponent } from '#shared/utils/enums'
import type { JobDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import { instanceId } from '../../utils/instance'
import {
  FatalJobError,
  JOB_LEASE_MS,
  JOB_RENEW_MS,
  JOB_RETENTION_MS,
  type JobContext,
  type JobKindDefinition,
  jobEvents,
  LeaseLostError,
} from '../../utils/jobs'
import type { Logger } from '../../utils/logger'

// The jobs runner of one component (docs/architecture.md §4.1 "jobs runner", docs/data-model.md §6.8). It claims
// queued jobs of its kinds with a lease, renews leases while handlers run, persists cursors through the handler
// context, retries with exponential backoff, enforces per-kind (and optional per-user) concurrency, and requeues
// jobs whose lease expired because their runner died. All writes are conditional on the lease owner.

const POLL_MS = 1000
const DEFAULT_BACKOFF = { initialMs: 5000, maxMs: 300_000 }

interface RunningJob {
  job: JobDoc
  abort: AbortController
  done: Promise<void>
}

export interface JobsRunnerOptions {
  component: OrchestratorComponent
  jobs: Collection<JobDoc>
  kinds: [JobKind, JobKindDefinition][]
  config: Config
  log: Logger
  owner?: string
  now?: () => Date
  /** claim poll interval (default 1 s) */
  pollMs?: number
  /** lease renewal and expiry sweep interval (default JOB_RENEW_MS) */
  renewMs?: number
}

export function backoffDelay(attempts: number, backoff = DEFAULT_BACKOFF): number {
  return Math.min(backoff.maxMs, backoff.initialMs * 2 ** Math.max(0, attempts - 1))
}

export class JobsRunner {
  private readonly owner: string
  private readonly now: () => Date
  private readonly running = new Map<string, RunningJob>()
  private pollTimer: NodeJS.Timeout | null = null
  private renewTimer: NodeJS.Timeout | null = null
  private ticking = false
  private stopped = true
  private readonly wake = (kind: JobKind) => {
    if (this.options.kinds.some(([k]) => k === kind)) void this.tick()
  }

  constructor(private readonly options: JobsRunnerOptions) {
    this.owner = options.owner ?? instanceId
    this.now = options.now ?? (() => new Date())
  }

  start(): void {
    if (!this.stopped || this.options.kinds.length === 0) return
    this.stopped = false
    jobEvents.on('created', this.wake)
    this.pollTimer = setInterval(() => void this.tick(), this.options.pollMs ?? POLL_MS)
    this.renewTimer = setInterval(() => void this.renewAndSweep(), this.options.renewMs ?? JOB_RENEW_MS)
    void this.renewAndSweep().then(() => this.tick())
  }

  /** Aborts running handlers, waits for them (bounded) and requeues their jobs. */
  async stop(graceMs = 20_000): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    jobEvents.off('created', this.wake)
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.renewTimer) clearInterval(this.renewTimer)
    const pending = [...this.running.values()]
    for (const entry of pending) entry.abort.abort(new Error('orchestrator is stopping'))
    await Promise.race([Promise.allSettled(pending.map((entry) => entry.done)), new Promise((resolve) => setTimeout(resolve, graceMs))])
    for (const entry of pending) {
      await this.options.jobs
        .updateOne(
          { _id: entry.job._id, state: 'running', 'lease.owner': this.owner },
          { $set: { state: 'queued', lease: null, notBefore: this.now(), updatedAt: this.now() } },
        )
        .catch((error: unknown) => this.options.log.warn('requeueing job on stop failed', { jobId: entry.job._id, err: error }))
    }
  }

  /** Number of handlers currently running (for tests and metrics). */
  get activeCount(): number {
    return this.running.size
  }

  private limit(value: number | ((config: Config) => number) | undefined): number | undefined {
    return typeof value === 'function' ? value(this.options.config) : value
  }

  /** Claims and starts jobs while slots are free. */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      for (const [kind, definition] of this.options.kinds) {
        const capacity = this.limit(definition.concurrency) ?? 1
        while (!this.stopped && this.countRunning(kind) < capacity) {
          const job = await this.claim(kind, definition)
          if (!job) break
          this.execute(job, definition)
        }
      }
    } catch (error) {
      this.options.log.warn('claiming jobs failed', { err: error })
    } finally {
      this.ticking = false
    }
  }

  private countRunning(kind: JobKind, userId?: string | null): number {
    let count = 0
    for (const entry of this.running.values()) {
      if (entry.job.kind === kind && (userId === undefined || entry.job.userId === userId)) count++
    }
    return count
  }

  private async claim(kind: JobKind, definition: JobKindDefinition): Promise<JobDoc | null> {
    const now = this.now()
    const filter: Filter<JobDoc> = { state: 'queued', kind, notBefore: { $lte: now } }
    const perUser = this.limit(definition.perUserConcurrency)
    if (perUser !== undefined) {
      const busy = new Set<string>()
      for (const entry of this.running.values()) {
        if (entry.job.kind === kind && entry.job.userId && this.countRunning(kind, entry.job.userId) >= perUser) busy.add(entry.job.userId)
      }
      if (busy.size > 0) filter.userId = { $nin: [...busy] }
    }
    return this.options.jobs.findOneAndUpdate(
      filter,
      [
        {
          $set: {
            state: 'running',
            lease: { owner: this.owner, expiresAt: new Date(now.getTime() + JOB_LEASE_MS) },
            attempts: { $add: ['$attempts', 1] },
            startedAt: { $ifNull: ['$startedAt', now] },
            updatedAt: now,
          },
        },
      ],
      { sort: { notBefore: 1, createdAt: 1 }, returnDocument: 'after' },
    )
  }

  private execute(job: JobDoc, definition: JobKindDefinition): void {
    const abort = new AbortController()
    const log = this.options.log.child({ jobId: job._id, jobKind: job.kind, userId: job.userId ?? undefined })
    const leased = { _id: job._id, state: 'running' as const, 'lease.owner': this.owner }
    const write = async (set: Record<string, unknown>) => {
      const result = await this.options.jobs.updateOne(leased, { $set: { ...set, updatedAt: this.now() } })
      if (result.matchedCount === 0) {
        abort.abort(new LeaseLostError(job._id))
        throw new LeaseLostError(job._id)
      }
    }
    const ctx: JobContext = {
      job,
      log,
      config: this.options.config,
      signal: abort.signal,
      saveCursor: (cursor, progress) =>
        write({
          cursor,
          ...(progress ? { 'progress.done': progress.done, ...(progress.total !== undefined ? { 'progress.total': progress.total } : {}) } : {}),
        }),
      setProgress: (done, total) => write({ 'progress.done': done, ...(total !== undefined ? { 'progress.total': total } : {}) }),
    }
    const done = (async () => {
      try {
        log.info('job started', { attempt: job.attempts })
        await definition.handler(job, ctx)
        // A handler that returns after its signal fired may have stopped early: never record that as success.
        // stop() requeues the job; a lost lease belongs to another runner or a cancellation.
        if (abort.signal.aborted) {
          log.info('job interrupted', { reason: String((abort.signal.reason as Error | undefined)?.message ?? 'aborted') })
          return
        }
        const now = this.now()
        const result = await this.options.jobs.updateOne(leased, {
          $set: { state: 'succeeded', active: false, lease: null, error: null, finishedAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + JOB_RETENTION_MS) },
        })
        if (result.matchedCount > 0) log.info('job succeeded')
        // A cancellation (for example cancelTestRun) may stop the handler before the lease check notices it.
        else if ((await this.options.jobs.findOne({ _id: job._id }, { projection: { state: 1 } }))?.state === 'cancelled') log.info('job cancelled')
        else log.warn('job finished after losing its lease')
      } catch (error) {
        if (abort.signal.aborted && abort.signal.reason instanceof LeaseLostError) {
          log.info('job interrupted: its lease was lost or it was cancelled')
        } else {
          await this.fail(job, definition, error, log)
        }
      } finally {
        this.running.delete(job._id)
        if (!this.stopped) void this.tick()
      }
    })()
    this.running.set(job._id, { job, abort, done })
  }

  private async fail(job: JobDoc, definition: JobKindDefinition, error: unknown, log: Logger): Promise<void> {
    if (error instanceof LeaseLostError || (this.stopped && !(error instanceof FatalJobError))) {
      log.info('job interrupted', { reason: (error as Error).message })
      return
    }
    const now = this.now()
    const fatal = error instanceof FatalJobError
    const failure = { code: fatal ? error.code : 'jobFailed', message: error instanceof Error ? error.message : String(error) }
    if (!fatal && job.attempts < job.maxAttempts) {
      const delay = backoffDelay(job.attempts, definition.backoff)
      log.warn('job attempt failed; retrying', { attempt: job.attempts, retryInMs: delay, err: error })
      await this.options.jobs.updateOne(
        { _id: job._id, state: 'running', 'lease.owner': this.owner },
        { $set: { state: 'queued', lease: null, error: failure, notBefore: new Date(now.getTime() + delay), updatedAt: now } },
      )
      return
    }
    log.error('job failed', { attempt: job.attempts, err: error })
    const result = await this.options.jobs.updateOne(
      { _id: job._id, state: 'running', 'lease.owner': this.owner },
      {
        $set: { state: 'failed', active: false, lease: null, error: failure, finishedAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + JOB_RETENTION_MS) },
      },
    )
    if (result.matchedCount > 0 && definition.onFailed) {
      await definition.onFailed(job, failure, { log, config: this.options.config }).catch((hookError: unknown) =>
        log.error('job onFailed hook failed', { err: hookError }),
      )
    }
  }

  /** Renews the leases of running jobs and requeues (or fails) jobs whose lease expired. */
  async renewAndSweep(): Promise<void> {
    if (this.stopped) return
    const now = this.now()
    const expiresAt = new Date(now.getTime() + JOB_LEASE_MS)
    for (const entry of this.running.values()) {
      try {
        const result = await this.options.jobs.updateOne(
          { _id: entry.job._id, state: 'running', 'lease.owner': this.owner },
          { $set: { 'lease.expiresAt': expiresAt, updatedAt: now } },
        )
        if (result.matchedCount === 0) entry.abort.abort(new LeaseLostError(entry.job._id))
      } catch (error) {
        this.options.log.warn('renewing job lease failed', { jobId: entry.job._id, err: error })
      }
    }
    const kinds = this.options.kinds.map(([kind]) => kind)
    try {
      const expired = await this.options.jobs
        .find({ state: 'running', kind: { $in: kinds }, 'lease.expiresAt': { $lt: now } })
        .project<Pick<JobDoc, '_id' | 'attempts' | 'maxAttempts' | 'kind'>>({ _id: 1, attempts: 1, maxAttempts: 1, kind: 1 })
        .toArray()
      for (const job of expired) {
        const exhausted = job.attempts >= job.maxAttempts
        await this.options.jobs.updateOne(
          { _id: job._id, state: 'running', 'lease.expiresAt': { $lt: now } },
          exhausted
            ? {
                $set: {
                  state: 'failed',
                  active: false,
                  lease: null,
                  error: { code: 'leaseExpired', message: 'the job lease expired too often' },
                  finishedAt: now,
                  updatedAt: now,
                  expiresAt: new Date(now.getTime() + JOB_RETENTION_MS),
                },
              }
            : { $set: { state: 'queued', lease: null, notBefore: now, updatedAt: now } },
        )
        this.options.log.warn(exhausted ? 'job failed after lease expiry' : 'requeued job after lease expiry', { jobId: job._id, jobKind: job.kind })
      }
    } catch (error) {
      this.options.log.warn('sweeping expired job leases failed', { err: error })
    }
  }
}
