import type { ScriptRun, ScriptRunLogLine, ScriptRunScan, ScriptRunSummary } from '#shared/types/scripts'
import { ACTIVE_SCRIPT_RUN_STATES, type ScriptRunState } from '#shared/utils/enums'
import type { ScriptRunDoc, ScriptRunErrorDoc } from '../../types/documents'
import { isoDate, isoDateOrNull } from '../../utils/serialize'

// Script-run representations (docs/api.md `ScriptRun`, docs/scripts.md). Internal fields never leave the server: the S3
// keys, the sealed secrets (only their names), upload ids and reservations of outputs, the log bookkeeping, the image
// id, the container and the job id. Pending outputs are not listed. `scans` carries the names the caller resolved. A
// running run with a cancel request is reported `cancelled` with the request's error: the cancel is final, only the
// container is still stopping (its job writes the state).

export function isScriptRunActive(state: ScriptRunState): boolean {
  return (ACTIVE_SCRIPT_RUN_STATES as readonly ScriptRunState[]).includes(state)
}

type CancelRequestOf = Pick<ScriptRunDoc, 'state' | 'cancelRequest'>

/** True while a cancelled run's container is still stopping (the document still says `running`). */
export function isCancelPending(doc: CancelRequestOf): boolean {
  return Boolean(doc.cancelRequest) && isScriptRunActive(doc.state)
}

/** The state clients see: a pending cancel is already `cancelled`. */
export function effectiveScriptRunState(doc: CancelRequestOf): ScriptRunState {
  return isCancelPending(doc) ? 'cancelled' : doc.state
}

/** The error of a cancelled run: the cascade's reason as a platform error, none for a user's cancel. */
export function cancelError(reason: string | null): ScriptRunErrorDoc | null {
  return reason ? { type: 'platform', message: reason } : null
}

/**
 * The wait condition of getScriptRun, startScriptRun and restartScriptRun: the run has ended. A pending cancel is
 * reported `cancelled` at once but settles only once its job stopped the container and stored the exit code, the last
 * checkpoint and outputs, so a run a wait returns can be resumed at once.
 */
export function isScriptRunSettled(doc: CancelRequestOf): boolean {
  return !isScriptRunActive(doc.state)
}

function progressOf(doc: Pick<ScriptRunDoc, 'progress'>): ScriptRunSummary['progress'] {
  const progress = doc.progress
  if (!progress) return null
  return { done: progress.done, total: progress.total, message: progress.message, updatedAt: isoDate(progress.updatedAt) }
}

/** The summary of a run embedded in a script's `recentRuns` (RUN_SUMMARY_PROJECTION suffices). */
export function toScriptRunSummary(doc: Pick<ScriptRunDoc, '_id' | 'state' | 'cancelRequest' | 'createdAt' | 'finishedAt' | 'progress'>): ScriptRunSummary {
  return {
    id: doc._id,
    state: effectiveScriptRunState(doc),
    createdAt: isoDate(doc.createdAt),
    finishedAt: isoDateOrNull(doc.finishedAt),
    progress: progressOf(doc),
  }
}

export interface ScriptRunRepresentationOptions {
  /** the names of the run's scans by id (a deleted scan has no name) */
  scanNames?: ReadonlyMap<string, string | null>
  /** the last lines of the log (single-run responses) */
  logTail?: ScriptRunLogLine[]
}

export function toApiScriptRun(doc: ScriptRunDoc, options: ScriptRunRepresentationOptions = {}): ScriptRun {
  const scans: ScriptRunScan[] = doc.scanIds.map((id) => ({ id, name: options.scanNames?.get(id) ?? null }))
  const error = isCancelPending(doc) ? cancelError(doc.cancelRequest?.reason ?? null) : doc.error
  return {
    id: doc._id,
    userId: doc.userId,
    scriptId: doc.scriptId,
    scriptName: doc.scriptName,
    scans,
    state: effectiveScriptRunState(doc),
    input: {
      config: doc.input.config,
      settings: {
        timeoutMs: doc.input.settings.timeoutMs,
        resources: { cpus: doc.input.settings.resources.cpus, memoryMiB: doc.input.settings.resources.memoryMiB },
        limit: doc.input.settings.limit,
      },
    },
    secrets: doc.secrets?.names ?? [],
    source: { packSha256: doc.source.packSha256, packBytes: doc.source.packBytes, fileCount: doc.source.fileCount },
    restartedFrom: doc.restartedFrom ? { id: doc.restartedFrom.id, resume: doc.restartedFrom.resume } : null,
    image: doc.image ? { ref: doc.image.ref, cached: doc.image.cached } : null,
    errors: doc.errors.map((error) => ({ ...error })),
    error: error ? { type: error.type, message: error.message, ...(error.stack === undefined ? {} : { stack: error.stack }) } : null,
    exitCode: doc.exitCode,
    progress: progressOf(doc),
    checkpoint: doc.checkpoint ? { savedAt: isoDate(doc.checkpoint.savedAt), bytes: doc.checkpoint.bytes } : null,
    result: doc.result ?? null,
    outputs: doc.outputs
      .filter((output) => output.state === 'stored')
      .map((output) => ({
        id: output.id,
        name: output.name,
        size: output.size ?? 0,
        sha256: output.sha256 ?? '',
        contentType: output.contentType,
        createdAt: isoDate(output.createdAt),
      })),
    log: { lines: doc.log.lines, firstLine: doc.log.firstLine, droppedLines: doc.log.droppedLines },
    ...(options.logTail ? { logTail: options.logTail } : {}),
    createdAt: isoDate(doc.createdAt),
    startedAt: isoDateOrNull(doc.startedAt),
    finishedAt: isoDateOrNull(doc.finishedAt),
    updatedAt: isoDate(doc.updatedAt),
    expiresAt: isoDateOrNull(doc.expiresAt),
  }
}
