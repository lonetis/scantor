import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Collection } from 'mongodb'
import type { JobKind, JobSubjectKind, OrchestratorComponent } from '#shared/utils/enums'
import type { JobDoc } from '../types/documents'
import type { Config } from './config'
import type { Logger } from './logger'
import { useCollections } from './mongo'

/*
 * Jobs: resumable, leased background work in the `jobs` collection (docs/data-model.md §4.12, §6.8). This module
 * is the extension seam; the runner lives in server/services/jobs/runner.ts.
 *
 * Registering a kind (domain plugins server/plugins/20-89.<area>.ts, synchronously):
 *
 *   registerJobKind('scanDelete', {
 *     component: 'reconciler',           // which SCANTOR_COMPONENTS member runs it (docs/data-model.md §4.12)
 *     concurrency: 2,                    // or (config) => config.buildConcurrency
 *     perUserConcurrency: undefined,     // optional cap per job owner (exports)
 *     maxAttempts: 5,                    // default for jobs created without maxAttempts
 *     async handler(job, ctx) {
 *       // resume from job.cursor; persist progress after every batch:
 *       await ctx.saveCursor({ phase: 'analyses', afterSeq }, { done, total })
 *       // ctx.signal is aborted when the lease is lost, the job is cancelled or the process stops
 *     },
 *     async onFailed(job, error, ctx) { … },  // optional: final failure (attempts exhausted or FatalJobError)
 *     async onRequeued(job, ctx) { … },       // optional: a running job went back to queued (stop, lease expiry, retry)
 *   })
 *
 * Creating a job (API handlers): `await createJob({ kind, userId, subject, params })` inserts it `queued`; a
 * second active job of the same kind and subject is refused by the partial unique index and the existing one is
 * returned (`created: false`). The runner claims queued jobs FIFO per kind with a 30 s lease renewed every 10 s,
 * retries failed attempts with exponential backoff (`notBefore`), requeues jobs whose lease expired, and enforces
 * per-kind concurrency. Handlers must be idempotent: a job may restart from its last saved cursor.
 */

export const JOB_LEASE_MS = 30_000
export const JOB_RENEW_MS = 10_000
export const JOB_RETENTION_MS = 7 * 86_400_000
export const DEFAULT_JOB_MAX_ATTEMPTS = 5

export interface JobContext {
  /** the claimed job (attempts already incremented) */
  readonly job: JobDoc
  log: Logger
  config: Config
  /** aborted when the lease is lost, the job is cancelled or the process stops */
  signal: AbortSignal
  /** Persists the resume position (and optionally progress); throws LeaseLostError when the lease is gone. */
  saveCursor(cursor: Record<string, unknown>, progress?: { done: number; total?: number | null }): Promise<void>
  /** Persists progress only; throws LeaseLostError when the lease is gone. */
  setProgress(done: number, total?: number | null): Promise<void>
}

export interface JobKindDefinition {
  component: OrchestratorComponent
  /** maximum number of jobs of this kind running at once in this process */
  concurrency: number | ((config: Config) => number)
  /** optional maximum number of jobs of this kind running at once per owner (`userId`) */
  perUserConcurrency?: number | ((config: Config) => number)
  /** default for jobs created without `maxAttempts` */
  maxAttempts?: number
  /** backoff between attempts: min(maxMs, initialMs × 2^(attempts − 1)) */
  backoff?: { initialMs: number; maxMs: number }
  handler(job: JobDoc, ctx: JobContext): Promise<void>
  /** called once when the job ends `failed` */
  onFailed?(job: JobDoc, error: { code: string; message: string }, ctx: { log: Logger; config: Config }): Promise<void>
  /**
   * called after a running job went back to `queued` without finishing: its runner stopped, its lease expired (the
   * runner died) or a retryable attempt failed. Resets the subject's own state machine (docs/data-model.md §6.4).
   */
  onRequeued?(job: JobDoc, ctx: { log: Logger; config: Config }): Promise<void>
}

/** A failure that must not be retried: the job ends `failed` at once. */
export class FatalJobError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'FatalJobError'
  }
}

/** Thrown by ctx.saveCursor / ctx.setProgress when another runner took the job over or it was cancelled. */
export class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`lease of job ${jobId} was lost`)
    this.name = 'LeaseLostError'
  }
}

const globalKey = '__scantorJobKinds'
type GlobalWithKinds = typeof globalThis & { [globalKey]?: Map<JobKind, JobKindDefinition> }

function kinds(): Map<JobKind, JobKindDefinition> {
  const global = globalThis as GlobalWithKinds
  global[globalKey] ??= new Map()
  return global[globalKey]
}

export function registerJobKind(kind: JobKind, definition: JobKindDefinition): void {
  if (kinds().has(kind)) throw new Error(`job kind ${kind} is registered twice`)
  kinds().set(kind, definition)
}

export function jobKindDefinition(kind: JobKind): JobKindDefinition | undefined {
  return kinds().get(kind)
}

/** The registered kinds run by `component`. */
export function jobKindsOf(component: OrchestratorComponent): [JobKind, JobKindDefinition][] {
  return [...kinds()].filter(([, definition]) => definition.component === component)
}

/** Clears registered kinds (server/plugins/00.boot.ts and tests). */
export function resetJobKinds(): void {
  kinds().clear()
}

/** In-process wake-up of runners when a job is created, so queued jobs start without waiting for a poll. */
export const jobEvents = new EventEmitter()
jobEvents.setMaxListeners(50)

export interface CreateJobInput {
  kind: JobKind
  userId: string | null
  subject: { kind: JobSubjectKind; id: string }
  params?: Record<string, unknown>
  maxAttempts?: number
  /** earliest start (default: now) */
  notBefore?: Date
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000
}

/**
 * Inserts a queued job. When an active job of the same kind and subject exists, that job is returned instead
 * (`created: false`), because the partial unique index allows one active job per kind and subject.
 */
export async function createJob(
  input: CreateJobInput,
  jobs: Collection<JobDoc> = useCollections().jobs,
): Promise<{ job: JobDoc; created: boolean }> {
  const now = new Date()
  const job: JobDoc = {
    _id: randomUUID(),
    kind: input.kind,
    userId: input.userId,
    subject: input.subject,
    state: 'queued',
    active: true,
    params: input.params ?? {},
    cursor: {},
    progress: { done: 0, total: null },
    attempts: 0,
    maxAttempts: input.maxAttempts ?? jobKindDefinition(input.kind)?.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS,
    lease: null,
    notBefore: input.notBefore ?? now,
    error: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
  }
  try {
    await jobs.insertOne(job)
  } catch (error) {
    if (!isDuplicateKey(error)) throw error
    const existing = await jobs.findOne({ kind: input.kind, 'subject.id': input.subject.id, active: true })
    if (existing) return { job: existing, created: false }
    throw error
  }
  jobEvents.emit('created', job.kind)
  return { job, created: true }
}

/** Cancels active jobs matching kind and subject (for example when the subject is deleted). */
export async function cancelActiveJobs(
  kind: JobKind,
  subjectId: string,
  jobs: Collection<JobDoc> = useCollections().jobs,
): Promise<number> {
  const now = new Date()
  const result = await jobs.updateMany(
    { kind, 'subject.id': subjectId, active: true },
    {
      $set: {
        state: 'cancelled',
        active: false,
        lease: null,
        finishedAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + JOB_RETENTION_MS),
      },
    },
  )
  return result.modifiedCount
}
