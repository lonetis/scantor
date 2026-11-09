import { ACTIVE_SCRIPT_RUN_STATES } from '#shared/utils/enums'
import type { Filter } from 'mongodb'
import type { JobDoc, ScriptRunDoc } from '../../types/documents'
import { useConfig } from '../../utils/config'
import { useDocker } from '../../utils/docker'
import { JOB_RETENTION_MS } from '../../utils/jobs'
import { useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { deletePrefix } from '../../utils/s3'
import { requestCancellation } from './live'
import { cancelError } from './mappers'
import { updateLatestRunPointer } from './pointer'

// Cleanup of script runs for the deletion cascades (docs/scripts.md): scriptDelete (stop → runs → images), the user
// purge (steps 15 and 65), the lockout hook and the scan deletion (runs that read the scan are cancelled). Every
// function is idempotent.

/** Which runs a cleanup applies to: one script's, one user's, or those reading one scan. */
export type ScriptRunScope = { scriptId: string } | { userId: string } | { scanId: string }

function scopeFilter(scope: ScriptRunScope): Filter<ScriptRunDoc> {
  if ('scriptId' in scope) return { scriptId: scope.scriptId }
  if ('userId' in scope) return { userId: scope.userId }
  return { scanIds: scope.scanId }
}

/** The S3 prefix of everything a run stored: `script-runs/<id>/` (source, outputs). */
export function scriptRunPrefix(scriptRunId: string): string {
  return `script-runs/${scriptRunId}/`
}

/**
 * Cancels the active runs of the scope (cancelScriptRunState; `error` {platform, reason} when a reason is given) and
 * returns how many it cancelled. Their jobs stop and remove the containers and end afterwards (countActiveScriptRunJobs).
 */
export async function cancelActiveScriptRuns(scope: ScriptRunScope, reason: string | null): Promise<number> {
  const { scriptRuns } = useCollections()
  const active = await scriptRuns.find({ ...scopeFilter(scope), state: { $in: [...ACTIVE_SCRIPT_RUN_STATES] } }, { projection: { _id: 1 } }).toArray()
  let cancelled = 0
  for (const run of active) {
    if (await cancelScriptRunState(run._id, reason)) cancelled++
  }
  return cancelled
}

/** The retention end of a run that finishes now (null: SCANTOR_SCRIPT_RUN_RETENTION_DAYS = 0 keeps runs forever). */
export function expiresAtOf(finishedAt: Date, retentionDays: number): Date | null {
  return retentionDays > 0 ? new Date(finishedAt.getTime() + retentionDays * 86_400_000) : null
}

const NO_CONTAINER_STATES = ['queued', 'building'] as const

/**
 * Cancels one active run and updates the script's `latestRun`; returns the updated document, or null when the run was
 * not active (or its cancel is already pending).
 *   - `queued`, `building` (no container yet): `cancelled` at once; a queued job is cancelled, a running one notices
 *     (at once in this process, within CANCEL_POLL_MS elsewhere) and ends after its last log lines
 *   - `running`: a cancel request (`cancelRequest`, `finishedAt`, `expiresAt`); the run is reported `cancelled` from
 *     now on, but its token keeps working while the job stops the container (`docker stop -t 60`, the script stores
 *     open outputs as `.partial` and its checkpoint), then the job writes `cancelled` (settleCancelRequest). The job
 *     is never cancelled: deletion cascades wait for it (countActiveScriptRunJobs).
 */
export async function cancelScriptRunState(scriptRunId: string, reason: string | null, retentionDays?: number): Promise<ScriptRunDoc | null> {
  const { scriptRuns } = useCollections()
  const now = new Date()
  const expiresAt = expiresAtOf(now, retentionDays ?? useConfig().scriptRunRetentionDays)
  const cancelled = await scriptRuns.findOneAndUpdate(
    { _id: scriptRunId, state: { $in: [...NO_CONTAINER_STATES] } },
    { $set: { state: 'cancelled', finishedAt: now, expiresAt, updatedAt: now, ...(reason ? { error: cancelError(reason) } : {}) } },
    { returnDocument: 'after' },
  )
  if (cancelled) {
    requestCancellation(scriptRunId)
    await updateQueuedScriptRunJobs(scriptRunId, cancelledJobSet(now))
    await updateLatestRunPointer(cancelled)
    return cancelled
  }
  const requested = await scriptRuns.findOneAndUpdate(
    { _id: scriptRunId, state: 'running', cancelRequest: null },
    { $set: { cancelRequest: { at: now, reason }, finishedAt: now, expiresAt, updatedAt: now } },
    { returnDocument: 'after' },
  )
  if (!requested) return null
  requestCancellation(scriptRunId)
  // A job waiting in its backoff (or requeued by an orchestrator stop) is claimed at once.
  await updateQueuedScriptRunJobs(scriptRunId, { notBefore: now, updatedAt: now })
  await updateLatestRunPointer(requested)
  return requested
}

/**
 * Ends a pending cancel: `running` with a request → `cancelled` with the request's error (the script may have
 * reported its own meanwhile) and `extra` (the exit code). Returns the updated document, or null when no cancel was
 * pending.
 */
export async function settleCancelRequest(scriptRunId: string, extra: Partial<Pick<ScriptRunDoc, 'exitCode'>> = {}): Promise<ScriptRunDoc | null> {
  const { scriptRuns } = useCollections()
  const pending = await scriptRuns.findOne(
    { _id: scriptRunId, state: { $in: [...ACTIVE_SCRIPT_RUN_STATES] }, cancelRequest: { $ne: null } },
    { projection: { cancelRequest: 1 } },
  )
  if (!pending?.cancelRequest) return null
  const now = new Date()
  return scriptRuns.findOneAndUpdate(
    { _id: scriptRunId, state: { $in: [...ACTIVE_SCRIPT_RUN_STATES] }, 'cancelRequest.at': pending.cancelRequest.at },
    { $set: { state: 'cancelled', error: cancelError(pending.cancelRequest.reason), ...extra, updatedAt: now } },
    { returnDocument: 'after' },
  )
}

function cancelledJobSet(now: Date): Partial<JobDoc> {
  return { state: 'cancelled', active: false, lease: null, finishedAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + JOB_RETENTION_MS) }
}

/** Updates the run's job while it is queued (no handler runs it; a running job is left alone). */
async function updateQueuedScriptRunJobs(scriptRunId: string, set: Partial<JobDoc>): Promise<void> {
  await useCollections().jobs.updateMany({ kind: 'scriptRun', 'subject.id': scriptRunId, active: true, state: 'queued' }, { $set: set })
}

/** Cancels the run's job while it is queued: the run was settled without it (the gc, a failed job). */
export async function cancelQueuedScriptRunJob(scriptRunId: string): Promise<void> {
  await updateQueuedScriptRunJobs(scriptRunId, cancelledJobSet(new Date()))
}

/**
 * The runs of the scope that are still winding down: active (a pending cancel, a racing start) or terminal with an
 * active scriptRun job (a cancelled run's job still stopping its container and storing its last log lines). The
 * deletion cascades wait until it is 0, so nothing writes the runs' data after they deleted it.
 */
export async function countActiveScriptRunJobs(scope: ScriptRunScope): Promise<number> {
  const { jobs, scriptRuns } = useCollections()
  const active = await scriptRuns.countDocuments({ ...scopeFilter(scope), state: { $in: [...ACTIVE_SCRIPT_RUN_STATES] } })
  const jobsActive = await jobs.find({ kind: 'scriptRun', active: true }, { projection: { 'subject.id': 1 } }).toArray()
  if (jobsActive.length === 0) return active
  const settling = await scriptRuns.countDocuments({
    ...scopeFilter(scope),
    state: { $nin: [...ACTIVE_SCRIPT_RUN_STATES] },
    _id: { $in: jobsActive.map((job) => job.subject.id) },
  })
  return active + settling
}

/**
 * Deletes the data of the scope's terminal runs: the S3 prefix `script-runs/<id>/`, the log chunks and the run
 * document (in that order, so a retry finds what is left). Active runs are left alone.
 */
export async function deleteScriptRunsData(scope: ScriptRunScope): Promise<number> {
  const runs = await useCollections()
    .scriptRuns.find({ ...scopeFilter(scope), state: { $nin: [...ACTIVE_SCRIPT_RUN_STATES] } }, { projection: { _id: 1 } })
    .toArray()
  for (const run of runs) await deleteScriptRunData(run._id)
  if (runs.length > 0) useLogger('script-runs').info('deleted script runs', { scope, runs: runs.length })
  return runs.length
}

/** Deletes one run's S3 objects, log chunks and document. */
export async function deleteScriptRunData(scriptRunId: string): Promise<void> {
  const { scriptRuns, scriptRunLogs } = useCollections()
  await deletePrefix(scriptRunPrefix(scriptRunId))
  await scriptRunLogs.deleteMany({ scriptRunId })
  await scriptRuns.deleteOne({ _id: scriptRunId, state: { $nin: [...ACTIVE_SCRIPT_RUN_STATES] } })
}

/** The image refs active runs use (never removed). */
export async function scriptImagesInUse(): Promise<Set<string>> {
  const runs = await useCollections()
    .scriptRuns.find({ state: { $in: [...ACTIVE_SCRIPT_RUN_STATES] }, image: { $ne: null } }, { projection: { image: 1 } })
    .toArray()
  return new Set(runs.map((run) => run.image?.ref).filter((ref): ref is string => typeof ref === 'string'))
}

/**
 * Removes the local images `scripts/<scriptId>:*` except `keep` and those an active run uses. An image a container
 * still uses (409) is left for the gc.
 */
export async function removeScriptImages(scriptId: string, keep: string | null = null): Promise<number> {
  const docker = useDocker()
  const inUse = await scriptImagesInUse()
  const images = await docker.listImages({ filters: { reference: [`scripts/${scriptId}:*`] } })
  let removed = 0
  for (const image of images) {
    for (const tag of image.RepoTags ?? []) {
      if (!tag.startsWith(`scripts/${scriptId}:`) || tag === keep || inUse.has(tag)) continue
      try {
        await docker.getImage(tag).remove()
        removed++
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode
        if (status !== 404 && status !== 409) throw error
      }
    }
  }
  return removed
}
