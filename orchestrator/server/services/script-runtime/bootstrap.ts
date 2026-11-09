import type { Collection, Document } from 'mongodb'
import type { ScanDoc, ScriptRunDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import { apiError } from '../../utils/errors'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import type { ScriptRunPrincipal } from '../../utils/principal'
import { SecretDecryptionError } from '../../utils/secrets'
import { isoDate, isoDateOrNull } from '../../utils/serialize'
import { mapQueryError } from '../query/errors'
import { queryAnalysesCollection } from '../query/execute'
import { scopedFilter } from '../query/scope'
import {
  CHECKPOINT_WRITE_INTERVAL_MS,
  FILE_URL_TTL_SECONDS,
  MAX_READS_PER_RUN,
  OUTPUT_PART_BYTES,
  PROGRESS_WRITE_INTERVAL_MS,
  SCRIPT_CHECKPOINT_MAX_BYTES,
} from './limits'
import { loadRunningRun } from './run'
import { unsealScriptRunSecrets } from './secrets'

/*
 * GET /api/script-runtime/bootstrap (docs/scripts.md, docs/api.md): everything the script needs once at start. The
 * secrets are decrypted here and nowhere else (security.md SEC-1). Every scan of the run is listed in request order
 * with its newest seq, its status counts, the result and analysis config schemas and the paths of embedded FileRefs
 * and secrets of its revision; a scan that was deleted meanwhile is 404 (deleting a scan cancels its script runs).
 * A run restarted with `resume` also gets the checkpoint and the stored outputs of the run it continues.
 */

export type ScriptBootstrapConfig = Pick<Config, 's3InternalUrl' | 'maxResultBytes' | 'scriptRunMaxOutputs' | 'scriptRunMaxOutputBytes' | 'queryMaxTimeMs'>

export interface ScriptScanCounts {
  total: number
  pending: number
  retrying: number
  succeeded: number
  failed: number
  lost: number
  cancelled: number
  /** true: the scan's hint counters (a scan that still runs or was not recounted since it ended); false: exact */
  hint: boolean
}

const TERMINAL_SCAN_STATES = new Set(['completed', 'failed', 'cancelled'])

/** The status counts of a scan: exact once a recount followed its end (docs/queue.md §6.9), else the hints. */
export function scanCounts(scan: Pick<ScanDoc, 'state' | 'stats' | 'completedAt'>): ScriptScanCounts {
  const { pending, retrying, succeeded, failed, lost, cancelled } = scan.stats
  const recountedAt = scan.stats.recountedAt?.getTime() ?? null
  const exact = TERMINAL_SCAN_STATES.has(scan.state) && recountedAt !== null && (scan.completedAt === null || recountedAt >= scan.completedAt.getTime())
  return {
    total: pending + retrying + succeeded + failed + lost + cancelled,
    pending,
    retrying,
    succeeded,
    failed,
    lost,
    cancelled,
    hint: !exact,
  }
}

/** The newest seq of a scan's analyses (null without analyses), from the `{scanId, seq}` index. */
async function maxSeqOf(scan: ScanDoc, analyses: Collection<Document>, config: ScriptBootstrapConfig): Promise<number | null> {
  try {
    const doc = await analyses.findOne(scopedFilter(scan), { sort: { seq: -1 }, projection: { seq: 1 }, maxTimeMS: config.queryMaxTimeMs })
    return typeof doc?.seq === 'number' ? doc.seq : null
  } catch (error) {
    throw mapQueryError(error, 'scan')
  }
}

interface RevisionView {
  _id: string
  description?: { schemas?: { analysisConfig?: Record<string, unknown>; result?: Record<string, unknown> }; fileRefPaths?: string[] } | null
}

async function bootstrapScan(scan: ScanDoc, revision: RevisionView | undefined, analyses: Collection<Document>, config: ScriptBootstrapConfig) {
  return {
    id: scan._id,
    name: scan.name ?? null,
    state: scan.state,
    task: { id: scan.task.id, name: scan.task.name },
    revision: { id: scan.revision.id, number: scan.revision.number },
    createdAt: isoDate(scan.createdAt),
    completedAt: isoDateOrNull(scan.completedAt),
    maxSeq: await maxSeqOf(scan, analyses, config),
    counts: scanCounts(scan),
    schemas: {
      analysisConfig: revision?.description?.schemas?.analysisConfig ?? null,
      result: revision?.description?.schemas?.result ?? null,
    },
    fileRefPaths: revision?.description?.fileRefPaths ?? [],
    secretPaths: { analysisConfig: scan.secretPaths?.analysisConfig ?? [], result: scan.secretPaths?.result ?? [] },
  }
}

/** The scans of the run in request order; 404 when one is no longer the owner's or is being deleted. */
async function runScans(run: Pick<ScriptRunDoc, 'userId' | 'scanIds'>): Promise<ScanDoc[]> {
  const found = await useCollections()
    .scans.find({ _id: { $in: run.scanIds }, userId: run.userId, state: { $nin: ['deleting', 'deleted'] } })
    .toArray()
  const byId = new Map(found.map((scan) => [scan._id, scan]))
  return run.scanIds.map((id) => {
    const scan = byId.get(id)
    if (!scan) throw apiError('notFound', `scan ${id} not found`)
    return scan
  })
}

/** The resume block of a run restarted with `resume`: the checkpoint and stored outputs of the run it continues. */
async function resumeOf(run: Pick<ScriptRunDoc, 'userId' | 'restartedFrom'>) {
  if (!run.restartedFrom?.resume) return null
  const original = await useCollections().scriptRuns.findOne(
    { _id: run.restartedFrom.id, userId: run.userId },
    { projection: { _id: 1, checkpoint: 1, outputs: 1 } },
  )
  return {
    runId: run.restartedFrom.id,
    checkpoint: original?.checkpoint ? original.checkpoint.state : null,
    outputs: (original?.outputs ?? [])
      .filter((output) => output.state === 'stored')
      .map((output) => ({ id: output.id, name: output.name, size: output.size ?? 0, sha256: output.sha256 ?? '', contentType: output.contentType })),
  }
}

/** The integer number of processes a script should use for CPU-bound work (at least 1). */
export function scriptCpus(cpus: number | null | undefined): number {
  return Math.max(1, Math.floor(cpus ?? 1))
}

export async function scriptRuntimeBootstrap(principal: ScriptRunPrincipal, config: ScriptBootstrapConfig, log: Logger) {
  const run = await loadRunningRun(principal)
  let secrets: Record<string, string>
  try {
    secrets = unsealScriptRunSecrets(run)
  } catch (error) {
    if (error instanceof SecretDecryptionError || error instanceof SyntaxError) {
      log.error('the secrets of a script run cannot be decrypted (was SCANTOR_SECRET changed?)', { scriptRunId: run._id })
      throw apiError('internal', 'the secrets of the script run cannot be decrypted')
    }
    throw error
  }
  const scans = await runScans(run)
  const revisionIds = [...new Set(scans.map((scan) => scan.revision.id))]
  const [revisions, analyses, resume] = await Promise.all([
    useCollections()
      .revisions.find(
        { _id: { $in: revisionIds } },
        { projection: { _id: 1, 'description.schemas.analysisConfig': 1, 'description.schemas.result': 1, 'description.fileRefPaths': 1 } },
      )
      .toArray() as Promise<RevisionView[]>,
    queryAnalysesCollection(),
    resumeOf(run),
  ])
  const revisionById = new Map(revisions.map((revision) => [revision._id, revision]))
  const settings = run.input.settings
  const { startedAt } = run
  return {
    scriptRun: {
      id: run._id,
      scriptId: run.scriptId,
      scriptName: run.scriptName,
      config: run.input.config,
      secrets,
      settings: { timeoutMs: settings.timeoutMs, resources: settings.resources, limit: settings.limit },
      cpus: scriptCpus(settings.resources.cpus),
      startedAt: isoDateOrNull(startedAt),
      deadline: startedAt && settings.timeoutMs !== null ? isoDate(new Date(startedAt.getTime() + settings.timeoutMs)) : null,
    },
    scans: await Promise.all(scans.map((scan) => bootstrapScan(scan, revisionById.get(scan.revision.id), analyses, config))),
    resume,
    limits: {
      maxResultBytes: config.maxResultBytes,
      maxCheckpointBytes: SCRIPT_CHECKPOINT_MAX_BYTES,
      maxOutputs: config.scriptRunMaxOutputs,
      maxOutputBytes: config.scriptRunMaxOutputBytes,
      partBytes: OUTPUT_PART_BYTES,
      fileUrlTtlSeconds: FILE_URL_TTL_SECONDS,
      maxStreams: MAX_READS_PER_RUN,
      progressIntervalMs: PROGRESS_WRITE_INTERVAL_MS,
      checkpointIntervalMs: CHECKPOINT_WRITE_INTERVAL_MS,
    },
    s3Origin: new URL(config.s3InternalUrl).origin,
  }
}

export type ScriptRuntimeBootstrap = Awaited<ReturnType<typeof scriptRuntimeBootstrap>>
