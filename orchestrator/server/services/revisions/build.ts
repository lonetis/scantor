import type { BuildErrorDoc, JobDoc, RevisionDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import { FatalJobError, type JobContext, type JobKindDefinition, LeaseLostError } from '../../utils/jobs'
import { useKeys } from '../../utils/keys'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { getObjectStream } from '../../utils/s3'
import { findAuthUser } from '../../utils/users'
import { pipelineEnv } from '../pipeline/binary'
import { type BuildResult, platformError, type PipelineEvent } from '../pipeline/events'
import { useBuildSlots } from '../pipeline/slots'
import { runTaskBuild, type TaskBuildOutcome } from '../pipeline/task-build'
import { writeEvent } from '../scans/events'
import { recordRevisionOutcome } from '../tasks/store'
import { finishBuildLog, startBuildLog } from './build-log'

// The `revisionBuild` job (docs/data-model.md §4.12, docs/tasks.md §9, docs/architecture.md §11.1 step 6): streams the
// revision's stored S3 snapshot into `scantor task build - --tag localhost:<port>/tasks/<taskId>:<revisionId> --push
// --push-gate 3 --expect-name <task> [--allow-privileged] --events ndjson`, stores the NDJSON events as the build
// log, answers the push gate after the registry-GC handshake (docs/deployment.md §14.1) and records the result on the
// revision. Content failures (exit 2) fail the revision; platform failures (exit 3, a crashed pipeline) are retried
// by the job and fail the revision when the attempts are exhausted. A job that goes back to `queued` without finishing
// (the orchestrator stopped, its runner died, a retry) puts a `building` revision back to `queued` (onRequeued,
// docs/data-model.md §6.4); the next attempt builds from scratch from the stored snapshot.

const REVISION_WAIT_MS = 10_000
const REGISTRY_WAIT_MS = 10_000
/** Wall-clock safety net above the binary's own timeouts: pulls, pushes and the build-cache prune. */
const DRIVER_MARGIN_MS = 30 * 60_000

export type BuildCursorPhase = 'build' | 'push' | 'waitRegistry' | 'finalize'

export function revisionImageTag(config: Pick<Config, 'registryPort'>, taskId: string, revisionId: string): string {
  return `localhost:${config.registryPort}/tasks/${taskId}:${revisionId}`
}

export function driverTimeoutMs(config: Pick<Config, 'buildTimeoutMs' | 'describeTimeoutMs'>): number {
  return config.buildTimeoutMs + 2 * config.describeTimeoutMs + DRIVER_MARGIN_MS
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('aborted'))
      },
      { once: true },
    )
  })
}

/** The publish request inserts the revision right after creating its job; wait for that insert. */
async function waitForRevision(revisionId: string, signal: AbortSignal): Promise<RevisionDoc | null> {
  const { revisions } = useCollections()
  const deadline = Date.now() + REVISION_WAIT_MS
  for (;;) {
    const revision = await revisions.findOne({ _id: revisionId })
    if (revision || Date.now() > deadline) return revision
    await sleep(200, signal)
  }
}

/** True while the registry GC holds its lock (docs/deployment.md §14.1). */
export async function registryGcHeld(now = new Date()): Promise<boolean> {
  return (await useCollections().locks.countDocuments({ _id: 'registryGc', expiresAt: { $gt: now } }, { limit: 1 })) > 0
}

/**
 * The push-gate handshake (docs/tasks.md §9.7): (a) cursor.phase = push; (b) while the registryGc lock is held,
 * cursor.phase = waitRegistry and wait 10 s, then (a) again; (c) resolve, which writes `push` to the gate.
 */
export async function pushGateHandshake(
  ctx: Pick<JobContext, 'saveCursor'>,
  signal: AbortSignal,
  gcHeld: () => Promise<boolean> = registryGcHeld,
  waitMs = REGISTRY_WAIT_MS,
): Promise<void> {
  for (;;) {
    await ctx.saveCursor({ phase: 'push' satisfies BuildCursorPhase })
    if (!(await gcHeld())) return
    await ctx.saveCursor({ phase: 'waitRegistry' satisfies BuildCursorPhase })
    await sleep(waitMs, signal)
  }
}

/**
 * ctx.saveCursor for the cursor writes of a build. A LeaseLostError means that the job was cancelled (task deletion,
 * a failed publish) or that another runner took it over; both stop the build through the job's signal. The first one
 * is logged once: a cancellation is expected (info), a lease lost to another runner is a warning. The error is
 * rethrown either way, so the push gate never opens without the lease.
 */
export function buildCursorWriter(job: Pick<JobDoc, '_id'>, ctx: Pick<JobContext, 'saveCursor' | 'log'>): JobContext['saveCursor'] {
  let reported = false
  return async (cursor, progress) => {
    try {
      await ctx.saveCursor(cursor, progress)
    } catch (error) {
      if (error instanceof LeaseLostError && !reported) {
        reported = true
        const current = await useCollections()
          .jobs.findOne({ _id: job._id }, { projection: { state: 1 } })
          .catch((readError: unknown) => {
            ctx.log.debug('reading the state of a build job failed', { err: readError })
            return null
          })
        if (current?.state === 'cancelled') ctx.log.info('the build job was cancelled; stopping the build', { phase: cursor.phase })
        else ctx.log.warn('the build job lost its lease; stopping the build', { phase: cursor.phase, state: current?.state ?? null })
      }
      throw error
    }
  }
}

export type BuildVerdict =
  | { state: 'ready'; result: BuildResult }
  | { state: 'failed'; errors: BuildErrorDoc[]; result: BuildResult | null }
  | { state: 'retry'; errors: BuildErrorDoc[]; result: BuildResult | null }

/** Classifies the outcome of `scantor task build` (docs/tasks.md §9.9 exit codes) for a revision build. */
export function classifyRevisionBuild(outcome: TaskBuildOutcome, config: Pick<Config, 'maxImageBytes'>, timeoutMs: number): BuildVerdict {
  const result = outcome.result
  if (outcome.timedOut) return { state: 'failed', errors: [platformError(`the task pipeline exceeded ${Math.round(timeoutMs / 1000)} s`)], result }
  if (outcome.exitCode === 0 && result?.ok && result.image?.digest) {
    if (result.image.bytes > config.maxImageBytes) {
      return { state: 'failed', errors: [{ phase: 'build', message: `image size ${result.image.bytes} bytes exceeds SCANTOR_MAX_IMAGE_BYTES (${config.maxImageBytes})` }], result }
    }
    return { state: 'ready', result }
  }
  const errors = result?.errors?.length ? result.errors : []
  if (outcome.exitCode === 2) {
    return { state: 'failed', errors: errors.length > 0 ? errors : [{ phase: 'build', message: 'the task pipeline rejected the task' }], result }
  }
  if (outcome.exitCode === 0) {
    return { state: 'failed', errors: [platformError('the task pipeline finished without a pushed image')], result }
  }
  const detail = outcome.stderrTail.trim().split('\n').at(-1) ?? ''
  return {
    state: 'retry',
    errors: errors.length > 0 ? errors : [platformError(`the task pipeline failed (exit ${outcome.exitCode ?? 'none'})${detail ? `: ${detail}` : ''}`)],
    result,
  }
}

/** The revision fields copied from a BuildResult (docs/tasks.md §9.8). */
export function revisionFieldsFromResult(result: BuildResult | null, taskId: string, revisionId: string): Partial<RevisionDoc> {
  if (!result) return {}
  const fields: Partial<RevisionDoc> = {}
  if (result.manifest) fields.manifest = result.manifest
  if (result.language) fields.language = result.language
  if (result.baseImage) fields.baseImage = result.baseImage
  if (result.description) fields.description = result.description
  if (result.settingsDefaults) fields.settingsDefaults = result.settingsDefaults
  if (typeof result.privileged === 'boolean') fields.privileged = result.privileged
  if (result.image?.digest) {
    fields.image = {
      repository: result.image.repository ?? `tasks/${taskId}`,
      tag: result.image.tag ?? revisionId,
      digest: result.image.digest,
      bytes: result.image.bytes,
      platform: { os: result.image.platform.os, arch: result.image.platform.arch },
    }
  }
  return fields
}

async function finalizeRevision(revision: RevisionDoc, state: 'ready' | 'failed', fields: Partial<RevisionDoc>, errors: BuildErrorDoc[], log: Logger): Promise<void> {
  const now = new Date()
  const updated = await useCollections().revisions.findOneAndUpdate(
    { _id: revision._id, state: { $in: ['queued', 'building'] } },
    { $set: { ...fields, state, errors: state === 'ready' ? [] : errors, image: state === 'ready' ? (fields.image ?? null) : null, finishedAt: now, updatedAt: now } },
    { returnDocument: 'after' },
  )
  if (!updated) return
  await recordRevisionOutcome(updated)
  log.info(`revision ${state}`, { revisionId: updated._id, taskId: updated.taskId, number: updated.number })
  await writeEvent({
    type: state === 'ready' ? 'revision.ready' : 'revision.failed',
    level: state === 'ready' ? 'info' : 'error',
    userId: updated.userId,
    taskId: updated.taskId,
    revisionId: updated._id,
    message: state === 'ready' ? `revision ${updated.taskName}@${updated.number} is ready` : `revision ${updated.taskName}@${updated.number} failed: ${errors[0]?.message ?? 'build failed'}`,
    data: state === 'ready' ? { number: updated.number } : { number: updated.number, errors: errors.slice(0, 5) },
  })
}

/**
 * The revision's job went back to `queued` without finishing: a `building` revision is `queued` again until the next
 * attempt claims the job, in the revision and in the task's latestRevision mirror (docs/data-model.md §6.4).
 */
export async function requeueRevision(revisionId: string, log: Logger): Promise<void> {
  const { revisions, tasks } = useCollections()
  const now = new Date()
  const revision = await revisions.findOneAndUpdate({ _id: revisionId, state: 'building' }, { $set: { state: 'queued', updatedAt: now } }, { returnDocument: 'after' })
  if (!revision) return
  await tasks.updateOne(
    { _id: revision.taskId, 'latestRevision.id': revision._id, 'latestRevision.state': 'building' },
    { $set: { 'latestRevision.state': 'queued', updatedAt: now } },
  )
  log.info('revision queued again until its build runs', { revisionId: revision._id, taskId: revision.taskId, number: revision.number })
}

/** Fails a revision that has not finished (task deleted, job attempts exhausted). */
export async function failRevision(revisionId: string, errors: BuildErrorDoc[], log: Logger): Promise<void> {
  const revision = await useCollections().revisions.findOne({ _id: revisionId })
  if (!revision) return
  await finalizeRevision(revision, 'failed', {}, errors, log)
}

async function buildRevision(job: JobDoc, ctx: JobContext): Promise<void> {
  const revisionId = String(job.params.revisionId ?? job.subject.id)
  const { revisions, tasks } = useCollections()
  const revision = await waitForRevision(revisionId, ctx.signal)
  if (!revision) throw new FatalJobError('notFound', `revision ${revisionId} does not exist`)
  if (revision.state === 'ready' || revision.state === 'failed') return
  const task = await tasks.findOne({ _id: revision.taskId })
  if (!task || task.deletingAt) {
    await finalizeRevision(revision, 'failed', {}, [platformError('the task was deleted')], ctx.log)
    return
  }
  const owner = await findAuthUser(revision.userId)
  if (!owner) {
    await finalizeRevision(revision, 'failed', {}, [platformError('the owner of the task no longer exists')], ctx.log)
    return
  }

  const saveCursor = buildCursorWriter(job, ctx)
  await saveCursor({ phase: 'build' satisfies BuildCursorPhase })
  const release = await useBuildSlots().acquire({ signal: ctx.signal })
  const buildLog = startBuildLog(revision._id, revision.buildLogKey)
  let outcome: TaskBuildOutcome
  const timeoutMs = driverTimeoutMs(ctx.config)
  try {
    const now = new Date()
    await revisions.updateOne(
      { _id: revision._id, state: { $in: ['queued', 'building'] } },
      { $set: { state: 'building', startedAt: now, errors: [], updatedAt: now } },
    )
    await tasks.updateOne({ _id: task._id, 'latestRevision.id': revision._id }, { $set: { 'latestRevision.state': 'building', updatedAt: now } })
    const input = await getObjectStream(revision.snapshotKey)
    outcome = await runTaskBuild({
      input,
      tag: revisionImageTag(ctx.config, task._id, revision._id),
      expectName: task.name,
      allowPrivileged: owner.canRunPrivileged === true,
      push: true,
      env: pipelineEnv(ctx.config, { SCANTOR_REGISTRY_PUSH_PASSWORD: useKeys().registryPushPassword() }),
      onEvent: async (event: PipelineEvent) => {
        buildLog.append(event)
        if (event.type === 'result') await saveCursor({ phase: 'finalize' satisfies BuildCursorPhase })
      },
      pushGate: (signal) => pushGateHandshake({ saveCursor }, signal),
      timeoutMs,
      signal: ctx.signal,
      log: ctx.log,
    })
  } finally {
    release()
    await finishBuildLog(revision._id, buildLog).catch((error: unknown) => ctx.log.error('storing the build log failed', { revisionId, err: error }))
  }
  // Stopped, cancelled or lease lost: the runner requeues or another runner owns the job.
  if (ctx.signal.aborted) return

  const verdict = classifyRevisionBuild(outcome, ctx.config, timeoutMs)
  const fields = revisionFieldsFromResult(verdict.result, task._id, revision._id)
  if (verdict.state === 'ready') {
    await finalizeRevision(revision, 'ready', fields, [], ctx.log)
    return
  }
  if (verdict.state === 'retry' && job.attempts < job.maxAttempts) {
    // The runner schedules the retry; its onRequeued hook puts the revision back to `queued`.
    await revisions.updateOne({ _id: revision._id, state: 'building' }, { $set: { errors: verdict.errors, updatedAt: new Date() } })
    throw new Error(verdict.errors[0]?.message ?? 'the task pipeline failed')
  }
  await finalizeRevision(revision, 'failed', fields, verdict.errors, ctx.log)
}

export const revisionBuildJobKind: JobKindDefinition = {
  component: 'api',
  concurrency: (config) => config.buildConcurrency,
  maxAttempts: 3,
  backoff: { initialMs: 10_000, maxMs: 60_000 },
  handler: buildRevision,
  async onFailed(job, error, { log }) {
    const revisionId = String(job.params.revisionId ?? job.subject.id)
    const revision = await useCollections().revisions.findOne({ _id: revisionId })
    const errors = revision?.errors.length ? revision.errors : [platformError(error.message)]
    await failRevision(revisionId, errors, log)
  },
  async onRequeued(job, { log }) {
    await requeueRevision(String(job.params.revisionId ?? job.subject.id), log)
  },
}
