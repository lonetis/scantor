import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { RestartScriptRunBody, StartScriptRunBody } from '#shared/schemas/scripts'
import type { ValidationIssue } from '#shared/types/common'
import type { ScanDoc, ScriptDoc, ScriptRunDoc, ScriptRunSettingsDoc } from '../../types/documents'
import { loadScansForScriptRun } from '../../utils/authz'
import { shutdownSignal } from '../../utils/boot'
import type { Config } from '../../utils/config'
import { apiError, invalidState, validationError } from '../../utils/errors'
import { createJob } from '../../utils/jobs'
import { useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import type { UserPrincipal } from '../../utils/principal'
import { copyObject, deleteObject } from '../../utils/s3'
import { reserveWait, reserveWaitFor } from '../../utils/wait'
import { validateConfig } from '../configs/validate'
import { discardTmpSnapshot, snapshotToTmp, type StoredSnapshot } from '../pipeline/snapshot'
import { scanCounts } from '../script-runtime/bootstrap'
import { sealScriptRunSecrets, unsealScriptRunSecrets } from '../script-runtime/secrets'
import { applyScriptWorkspaceSummary } from '../scripts/store'
import { cancelScriptRunState } from './cleanup'
import { emptyLogState } from './logs'
import { isCancelPending, isScriptRunActive } from './mappers'
import { recomputeLatestRunPointer, setLatestRunPointer } from './pointer'

// Starting and restarting script runs (docs/scripts.md, docs/api.md startScriptRun / restartScriptRun): the synchronous
// checks of the route, in order:
//   1. the script (resolved by the route; never one being deleted); the run's owner is always the script's owner
//   2. the scans: deduplicated in request order, each one of the owner's live scans (admins never bind another user's)
//   3. the config (a JSON object of at most SCANTOR_MAX_SCAN_CONFIG_BYTES) and the settings caps
//   4. the snapshot of the script folder now (like a revision publish), stored as `script-runs/<id>/source.tar.gz`;
//      its summary refreshes the script's workspace cache
//   5. the config against the script's described config schema when it was described for exactly this pack
//   6. MCP: a run without `settings.limit` needs `confirm: true` (confirmationRequired with the scans' sizes)
//   7. the run document (queued, secrets sealed for this run), the script's `latestRun`, then its scriptRun job
// The snapshot is taken into a temporary object first and promoted only when every check passed.

const log = useLogger('script-runs')

export type StartConfig = Pick<Config, 'maxScanConfigBytes' | 'scriptRunTimeoutMs' | 'scriptRunMaxCpus' | 'scriptRunMaxMemoryBytes'>

export function sourceKey(scriptRunId: string): string {
  return `script-runs/${scriptRunId}/source.tar.gz`
}

/** Settings caps of a run (400 validationFailed); the build checks the merged settings again. */
export function settingsIssues(
  settings: ScriptRunSettingsDoc,
  config: Pick<Config, 'scriptRunTimeoutMs' | 'scriptRunMaxCpus' | 'scriptRunMaxMemoryBytes'>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (settings.timeoutMs !== null && settings.timeoutMs > config.scriptRunTimeoutMs) {
    issues.push({ path: '/settings/timeoutMs', message: `must be at most ${config.scriptRunTimeoutMs} (SCANTOR_SCRIPT_RUN_TIMEOUT)` })
  }
  if (settings.resources.cpus !== null && settings.resources.cpus > config.scriptRunMaxCpus) {
    issues.push({ path: '/settings/resources/cpus', message: `must be at most ${config.scriptRunMaxCpus} (SCANTOR_SCRIPT_RUN_MAX_CPUS)` })
  }
  if (settings.resources.memoryMiB !== null && settings.resources.memoryMiB * 1024 ** 2 > config.scriptRunMaxMemoryBytes) {
    issues.push({
      path: '/settings/resources/memoryMiB',
      message: `must be at most ${Math.floor(config.scriptRunMaxMemoryBytes / 1024 ** 2)} (SCANTOR_SCRIPT_RUN_MAX_MEMORY)`,
    })
  }
  return issues
}

function checkConfigSize(config: Record<string, unknown>, limit: number): void {
  const bytes = Buffer.byteLength(JSON.stringify(config), 'utf8')
  if (bytes > limit) throw apiError('payloadTooLarge', `config exceeds ${limit} bytes`, { limit, actual: bytes })
}

interface RunInput {
  principal: UserPrincipal
  script: ScriptDoc
  scanIds: string[]
  config: Record<string, unknown>
  secrets: Record<string, string>
  settings: ScriptRunSettingsDoc
  confirm: boolean
  restartedFrom: ScriptRunDoc['restartedFrom']
}

/** Step 5: the config against the described schema of exactly this pack (defaults filled). */
function validatedConfig(script: ScriptDoc, packSha256: string, config: Record<string, unknown>): Record<string, unknown> {
  const schema = script.describe?.packSha256 === packSha256 ? script.describe.configSchema : null
  if (!schema) return config
  const { value, issues } = validateConfig('config', schema, config)
  if (issues.length > 0) throw apiError('configInvalid', `config is invalid: ${issues[0]!.path} ${issues[0]!.message}`, { issues })
  return value as Record<string, unknown>
}

/** Step 6: an MCP client must confirm a run over every analysis of the scans. */
function checkConfirmation(input: RunInput, scans: ScanDoc[], packSha256: string): void {
  if (input.principal.via !== 'mcp' || input.settings.limit !== null || input.confirm) return
  const details = { scans: scans.map((scan) => ({ id: scan._id, name: scan.name ?? null, analyses: scanCounts(scan).total })), packSha256 }
  const total = details.scans.reduce((sum, scan) => sum + scan.analyses, 0)
  throw apiError(
    'confirmationRequired',
    `the script run would read all ${total} analyses of ${scans.length} scan(s); ask the user, then repeat the request with confirm: true (or try it on a sample with settings.limit)`,
    details,
  )
}

async function createRun(input: RunInput, config: StartConfig): Promise<ScriptRunDoc> {
  const { script } = input
  const scans = await loadScansForScriptRun(script, input.scanIds)
  checkConfigSize(input.config, config.maxScanConfigBytes)
  const issues = settingsIssues(input.settings, config)
  if (issues.length > 0) throw validationError(issues, 'the settings exceed the instance limits')

  const id = randomUUID()
  let snapshot: StoredSnapshot | null = await snapshotToTmp(script.userId, { script: script.name })
  let promoted = false
  try {
    // The snapshot is the folder now: it refreshes the workspace cache, which editor writes (straight to the volume)
    // never do, so `workspace.packSha256` names the content this run builds.
    const summary = { packSha256: snapshot.packSha256, fileCount: snapshot.fileCount, bytes: snapshot.bytes }
    await applyScriptWorkspaceSummary(script._id, summary).catch((error: unknown) =>
      log.warn('refreshing the workspace cache failed', { scriptId: script._id, err: error }),
    )
    const effectiveConfig = validatedConfig(script, snapshot.packSha256, input.config)
    checkConfirmation(input, scans, snapshot.packSha256)
    const key = sourceKey(id)
    await copyObject(snapshot.tmpKey, key)
    promoted = true
    const source = { key, packSha256: snapshot.packSha256, packBytes: snapshot.packBytes, fileCount: snapshot.fileCount }
    await discardTmpSnapshot(snapshot)
    snapshot = null

    const now = new Date()
    const doc: ScriptRunDoc = {
      _id: id,
      userId: script.userId,
      scriptId: script._id,
      scriptName: script.name,
      scanIds: scans.map((scan) => scan._id),
      state: 'queued',
      input: { config: effectiveConfig, settings: input.settings },
      secrets: sealScriptRunSecrets(id, input.secrets),
      source,
      restartedFrom: input.restartedFrom,
      image: null,
      entry: null,
      container: null,
      errors: [],
      error: null,
      exitCode: null,
      progress: null,
      checkpoint: null,
      result: null,
      outputs: [],
      log: emptyLogState(),
      jobId: '',
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
      expiresAt: null,
    }
    const { scriptRuns } = useCollections()
    await scriptRuns.insertOne(doc)
    try {
      // Before the job exists: the job's first state change (building) updates only a pointer that names this run.
      await setLatestRunPointer(doc)
      const { job } = await createJob({ kind: 'scriptRun', userId: script.userId, subject: { kind: 'scriptRun', id }, params: { scriptRunId: id } })
      doc.jobId = job._id
      await scriptRuns.updateOne({ _id: id }, { $set: { jobId: job._id } })
    } catch (error) {
      await scriptRuns.deleteOne({ _id: id })
      await recomputeLatestRunPointer(script._id, id).catch((pointerError: unknown) =>
        log.warn('restoring the latest run pointer failed', { scriptId: script._id, scriptRunId: id, err: pointerError }),
      )
      throw error
    }
    // A deletion that began while this run was being created: the run must not outlive its script.
    if ((await useCollections().scripts.findOne({ _id: script._id }, { projection: { deletingAt: 1 } }))?.deletingAt) {
      await cancelScriptRunState(id, 'the script was deleted')
      throw apiError('notFound', 'script not found')
    }
    log.info('script run queued', {
      scriptRunId: id,
      scriptId: script._id,
      userId: script.userId,
      scans: doc.scanIds.length,
      restartedFrom: input.restartedFrom?.id,
    })
    return doc
  } catch (error) {
    if (snapshot) await discardTmpSnapshot(snapshot)
    if (promoted && !(await useCollections().scriptRuns.findOne({ _id: id }, { projection: { _id: 1 } }))) {
      await deleteObject(sourceKey(id)).catch((deleteError: unknown) =>
        log.warn('deleting the source of a refused run failed', { scriptRunId: id, err: deleteError }),
      )
    }
    throw error
  }
}

/** startScriptRun: a new run of the script's current folder. */
export async function startScriptRun(principal: UserPrincipal, script: ScriptDoc, body: StartScriptRunBody, config: StartConfig): Promise<ScriptRunDoc> {
  const settings: ScriptRunSettingsDoc = {
    timeoutMs: body.settings?.timeoutMs ?? null,
    resources: { cpus: body.settings?.resources?.cpus ?? null, memoryMiB: body.settings?.resources?.memoryMiB ?? null },
    limit: body.settings?.limit ?? null,
  }
  return createRun(
    { principal, script, scanIds: body.scans, config: body.config, secrets: body.secrets ?? {}, settings, confirm: body.confirm === true, restartedFrom: null },
    config,
  )
}

/** How long a resume waits for a cancelled original whose container is still stopping (docs/scripts.md §6.7). */
export const RESUME_STOP_WAIT_MS = 30_000
const RESUME_STOP_POLL_MS = 500

/**
 * The original of a resume once its container stopped: the script stores its open outputs as `.partial` and its last
 * checkpoint during the stop, and the resumed run reads both, so a pending cancel is waited for up to `waitMs`. Still
 * pending then, or when the orchestrator begins to stop, is 409 invalidState.
 */
export async function stoppedOriginal(original: ScriptRunDoc, waitMs = RESUME_STOP_WAIT_MS): Promise<ScriptRunDoc> {
  const deadline = Date.now() + waitMs
  const stopping = shutdownSignal()
  let current: ScriptRunDoc | null = original
  while (current && isCancelPending(current)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0 || stopping.aborted) {
      throw apiError('invalidState', 'the cancelled script run is still stopping its container; resume it once it stopped', {
        state: 'cancelled',
        allowed: ['completed', 'failed', 'cancelled'],
      })
    }
    try {
      await sleep(Math.min(RESUME_STOP_POLL_MS, remaining), undefined, { signal: stopping })
    } catch (error) {
      // The orchestrator began to stop: the next round answers 409 at once.
      if (!stopping.aborted) throw error
    }
    current = await useCollections().scriptRuns.findOne({ _id: original._id })
  }
  if (!current) throw apiError('notFound', 'script run not found')
  return current
}

/**
 * The wait reservation a restart holds across its side effect: one for `wait`, or else one for a resume whose
 * original is still stopping (stoppedOriginal holds the request up to RESUME_STOP_WAIT_MS), so every long-held request
 * counts against the user's SCANTOR_MAX_CONCURRENT_WAITS (429 tooManyRequests before anything is created).
 */
export function reserveRestartWait(
  userId: string,
  original: ScriptRunDoc,
  body: Pick<RestartScriptRunBody, 'resume'>,
  waitSeconds: number | undefined,
): (() => void) | null {
  const reservation = reserveWaitFor(userId, waitSeconds)
  if (reservation || !body.resume || !isCancelPending(original)) return reservation
  return reserveWait(userId)
}

/**
 * restartScriptRun: a new run of the script's CURRENT folder with the original's scans, config, secrets (sealed again
 * for the new run) and settings, each overridable. `resume` needs a terminal original (a cancelled one whose container
 * is still stopping is waited for, stoppedOriginal) and hands its checkpoint and outputs to the new run's bootstrap.
 */
export async function restartScriptRun(
  principal: UserPrincipal,
  requested: ScriptRunDoc,
  body: RestartScriptRunBody,
  config: StartConfig,
  resumeWaitMs = RESUME_STOP_WAIT_MS,
): Promise<ScriptRunDoc> {
  const original = body.resume ? await stoppedOriginal(requested, resumeWaitMs) : requested
  if (body.resume && isScriptRunActive(original.state)) throw invalidState('script run', original.state, ['completed', 'failed', 'cancelled'], 'resume')
  const script = await useCollections().scripts.findOne({ _id: original.scriptId, deletingAt: null })
  if (!script) throw apiError('notFound', 'script not found')
  const overrides = body.settings
  const settings: ScriptRunSettingsDoc = {
    timeoutMs: overrides?.timeoutMs ?? original.input.settings.timeoutMs,
    resources: {
      cpus: overrides?.resources?.cpus ?? original.input.settings.resources.cpus,
      memoryMiB: overrides?.resources?.memoryMiB ?? original.input.settings.resources.memoryMiB,
    },
    limit: overrides?.limit === undefined ? original.input.settings.limit : overrides.limit,
  }
  return createRun(
    {
      principal,
      script,
      scanIds: original.scanIds,
      config: body.config ?? original.input.config,
      secrets: unsealScriptRunSecrets(original),
      settings,
      confirm: body.confirm === true,
      restartedFrom: { id: original._id, resume: body.resume },
    },
    config,
  )
}
