import { createHash } from 'node:crypto'
import { pipeline, type Readable, Transform, type TransformCallback } from 'node:stream'
import type { BundleInfo } from '#shared/types/bundles'
import type { JobDoc, RevisionDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import { FatalJobError, type JobContext, type JobKindDefinition } from '../../utils/jobs'
import { useKeys } from '../../utils/keys'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { uploadStream } from '../../utils/s3'
import { pipelineEnv } from '../pipeline/binary'
import type { BundleArchive, PipelineEvent } from '../pipeline/events'
import { useBuildSlots } from '../pipeline/slots'
import { runTaskBundle, type TaskBundleOutcome } from '../pipeline/task-bundle'
import { revisionImageTag } from '../revisions/build'
import { bundleInfo } from './info'
import { BUNDLE_CONTENT_TYPE, isBundleSettled } from './mappers'
import { discardBundleObject } from './service'

/*
 * The `bundle` job kind (api component; docs/data-model.md §4.12, §4.21, §6.12; docs/tasks.md §9.11). It runs
 * `scantor task bundle - --image <revision tag> --pull localhost:<port>/tasks/<taskId>@<digest> --output-fd 3
 * --events ndjson` in a build slot (shared with revision and test-run builds), with the bundle info on stdin and the
 * push password in the environment only so the step can pull the revision image again when the master's Docker lost
 * it (security.md BDL-6). The archive on fd 3 streams through a SHA-256 and byte counter into
 * `bundles/<taskId>/<bundleId>.tar.gz` (multipart upload); the bundle becomes `ready` only when the pipeline succeeded
 * and its own count and hash equal what was stored. Content errors (exit 2, phase `build`) fail the bundle at once;
 * everything else is retried, and a failed attempt deletes what it stored. Pipeline events are logged at debug
 * level only: a bundle has no build log.
 */

/** Wall-clock limit of the pipeline above SCANTOR_BUILD_TIMEOUT: the pull, `docker save` and the upload. */
export const BUNDLE_DRIVER_MARGIN_MS = 30 * 60_000

export function bundleTimeoutMs(config: Pick<Config, 'buildTimeoutMs'>): number {
  return config.buildTimeoutMs + BUNDLE_DRIVER_MARGIN_MS
}

/** The revision image by digest in the master registry (`--pull`): what the step pulls when the local tag is gone. */
export function revisionPullRef(config: Pick<Config, 'registryPort'>, revision: Pick<RevisionDoc, 'taskId' | 'image'>): string {
  if (!revision.image?.digest) throw new Error('the revision has no image digest')
  return `localhost:${config.registryPort}/tasks/${revision.taskId}@${revision.image.digest}`
}

/** Counts and hashes the bytes passing through; `result()` is set once the stream ended. */
export class ArchiveCounter extends Transform {
  private readonly hash = createHash('sha256')
  private bytes = 0
  private sha256: string | null = null

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.hash.update(chunk)
    this.bytes += chunk.length
    callback(null, chunk)
  }

  override _flush(callback: TransformCallback): void {
    this.sha256 = this.hash.digest('hex')
    callback()
  }

  /** The byte count and SHA-256 of a complete stream, or null while (or when) it did not end. */
  result(): { bytes: number; sha256: string } | null {
    return this.sha256 === null ? null : { bytes: this.bytes, sha256: this.sha256 }
  }
}

export type BundleVerdict = { state: 'ready'; archive: BundleArchive } | { state: 'failed'; message: string } | { state: 'retry'; message: string }

/** Classifies the outcome of `scantor task bundle` and of the upload of its archive (pure). */
export function classifyBundleRun(outcome: TaskBundleOutcome, stored: { bytes: number; sha256: string } | null, timeoutMs: number): BundleVerdict {
  const result = outcome.result
  const firstError = result?.errors?.[0]?.message
  if (outcome.timedOut) return { state: 'retry', message: `the bundle pipeline exceeded ${Math.round(timeoutMs / 1000)} s` }
  if (result?.errors?.some((error) => error.phase === 'build') || outcome.exitCode === 2) {
    return { state: 'failed', message: firstError ?? 'the bundle pipeline rejected the image' }
  }
  if (outcome.outputError) return { state: 'retry', message: `storing the archive failed: ${outcome.outputError.message}` }
  if (outcome.exitCode === 0 && result?.ok && result.bundle) {
    if (!stored) return { state: 'retry', message: 'the archive was not stored completely' }
    if (stored.bytes !== result.bundle.bytes || stored.sha256 !== result.bundle.sha256) {
      return {
        state: 'retry',
        message: `the stored archive (${stored.bytes} bytes, sha256 ${stored.sha256}) differs from the written one (${result.bundle.bytes} bytes, sha256 ${result.bundle.sha256})`,
      }
    }
    return { state: 'ready', archive: result.bundle }
  }
  if (outcome.exitCode === 0) return { state: 'retry', message: 'the bundle pipeline finished without an archive' }
  const detail = outcome.stderrTail.trim().split('\n').at(-1) ?? ''
  return { state: 'retry', message: firstError ?? `the bundle pipeline failed (exit ${outcome.exitCode ?? 'none'})${detail ? `: ${detail}` : ''}` }
}

function bundleIdOf(job: JobDoc): string {
  const id = job.params.bundleId
  if (typeof id !== 'string' || id !== job.subject.id) throw new FatalJobError('invalidParams', 'bundle job without a matching bundleId')
  return id
}

function logEvent(log: Logger, event: PipelineEvent): void {
  if (event.type === 'result') return
  log.debug('bundle pipeline event', { phase: event.phase, type: event.type, text: event.text?.slice(0, 1000), error: event.error })
}

async function runBundle(job: JobDoc, ctx: JobContext): Promise<void> {
  const bundleId = bundleIdOf(job)
  const { bundles, revisions, tasks } = useCollections()
  const bundle = await bundles.findOne({ _id: bundleId })
  if (!bundle || isBundleSettled(bundle)) return
  const revision = await revisions.findOne({ _id: bundle.revisionId })
  const task = revision ? await tasks.findOne({ _id: revision.taskId }, { projection: { deletingAt: 1 } }) : null
  if (!revision || !task || task.deletingAt || revision.state !== 'ready' || !revision.image?.digest) {
    throw new FatalJobError('revisionUnavailable', 'the revision of this bundle is no longer available')
  }
  let info: BundleInfo
  try {
    info = bundleInfo(revision, ctx.config)
  } catch (error) {
    throw new FatalJobError('bundleFailed', (error as Error).message)
  }

  const timeoutMs = bundleTimeoutMs(ctx.config)
  const stored: { counter: ArchiveCounter | null } = { counter: null }
  let outcome: TaskBundleOutcome
  const release = await useBuildSlots().acquire({ signal: ctx.signal })
  try {
    const now = new Date()
    const started = await bundles.updateOne(
      { _id: bundleId, state: { $in: ['queued', 'running'] } },
      { $set: { state: 'running', startedAt: now, error: null, updatedAt: now } },
    )
    // Failed (its task is being deleted) or replaced meanwhile.
    if (started.matchedCount === 0) return
    outcome = await runTaskBundle({
      info,
      image: revisionImageTag(ctx.config, revision.taskId, revision._id),
      pull: revisionPullRef(ctx.config, revision),
      env: pipelineEnv(ctx.config, { SCANTOR_REGISTRY_PUSH_PASSWORD: useKeys().registryPushPassword() }),
      onEvent: (event) => logEvent(ctx.log, event),
      output: async (stream: Readable, signal: AbortSignal) => {
        const counting = new ArchiveCounter()
        stored.counter = counting
        // A failing (cut) output destroys the counter with the error, so the upload aborts instead of completing; the
        // signal (wall-clock limit, stop) aborts an upload that hangs after the archive ended.
        pipeline(stream, counting, () => {})
        try {
          await uploadStream(bundle.key, counting, BUNDLE_CONTENT_TYPE, undefined, signal)
        } finally {
          if (!counting.readableEnded) counting.destroy()
        }
      },
      timeoutMs,
      signal: ctx.signal,
      log: ctx.log,
    })
  } finally {
    release()
  }
  // Stopped, cancelled or lease lost: the runner requeues or another runner owns the job.
  if (ctx.signal.aborted) return

  const verdict = classifyBundleRun(outcome, stored.counter?.result() ?? null, timeoutMs)
  if (verdict.state === 'ready') {
    const { archive } = verdict
    const finished = new Date()
    const platform = { os: archive.platform.os, arch: archive.platform.arch, ...(archive.platform.variant ? { variant: archive.platform.variant } : {}) }
    const ready = await bundles.updateOne(
      { _id: bundleId, state: 'running' },
      {
        $set: {
          state: 'ready',
          bytes: archive.bytes,
          sha256: archive.sha256,
          platform,
          scantorVersion: archive.scantorVersion,
          error: null,
          finishedAt: finished,
          updatedAt: finished,
          expiresAt: new Date(finished.getTime() + ctx.config.bundleRetentionDays * 86_400_000),
        },
      },
    )
    if (ready.matchedCount === 0) {
      // The bundle failed (its task is being deleted) or was replaced while the archive was written.
      await discardBundleObject(bundle.key, ctx.log)
      return
    }
    ctx.log.info('bundle ready', { bundleId, revisionId: revision._id, bytes: archive.bytes })
    return
  }
  await discardBundleObject(bundle.key, ctx.log)
  if (verdict.state === 'failed' || job.attempts >= job.maxAttempts) throw new FatalJobError('bundleFailed', verdict.message)
  throw new Error(verdict.message)
}

export const bundleJobKind: JobKindDefinition = {
  component: 'api',
  concurrency: (config) => config.buildConcurrency,
  perUserConcurrency: 1,
  maxAttempts: 3,
  backoff: { initialMs: 10_000, maxMs: 60_000 },
  handler: runBundle,
  async onFailed(job, error, { log }) {
    const now = new Date()
    const failed = await useCollections().bundles.findOneAndUpdate(
      { _id: String(job.params.bundleId ?? job.subject.id), state: { $in: ['queued', 'running'] } },
      { $set: { state: 'failed', error: { code: error.code, message: error.message }, finishedAt: now, updatedAt: now } },
      { returnDocument: 'after' },
    )
    if (!failed) return
    log.warn('bundle failed', { bundleId: failed._id, revisionId: failed.revisionId, code: error.code })
    await discardBundleObject(failed.key, log)
  },
  async onRequeued(job, { log }) {
    const now = new Date()
    const result = await useCollections().bundles.updateOne(
      { _id: String(job.params.bundleId ?? job.subject.id), state: 'running' },
      { $set: { state: 'queued', updatedAt: now } },
    )
    if (result.modifiedCount > 0) log.info('bundle queued again until its job runs', { bundleId: job.subject.id })
  },
}
