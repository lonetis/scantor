import type { JobDoc, ScriptDoc } from '../../types/documents'
import { FatalJobError, type JobContext, JobDeferredError, type JobKindDefinition } from '../../utils/jobs'
import { useCollections } from '../../utils/mongo'
import { deleteFolder } from '../helpers/ops'
import { cancelActiveScriptRuns, countActiveScriptRunJobs, deleteScriptRunsData, removeScriptImages } from '../script-runs/cleanup'
import { scriptFolder } from './files'

// Script deletion (docs/api.md deleteScript, docs/scripts.md, docs/data-model.md §4.12 `scriptDelete`): the API hides
// the script at once (`deletingAt`); this job (reconciler component, cursor `{phase}`) then cancels the script's
// active runs and waits until their jobs ended (deferring itself, so the wait holds no slot), deletes the runs' data
// (S3 `script-runs/<id>/` prefixes, log chunks, run documents), the script's local images `scripts/<scriptId>:*`,
// the workspace folder (helper `delete-files --script <name> --path "" --recursive`) and finally the document. Every
// phase is idempotent, so a job restarted after a lease expiry resumes at its phase; a run that appears after the stop
// phase sends the job back to it before the document goes.

export const SCRIPT_DELETE_PHASES = ['stop', 'runs', 'images', 'workspace', 'script'] as const
export type ScriptDeletePhase = (typeof SCRIPT_DELETE_PHASES)[number]

export const SCRIPT_DELETED = 'the script was deleted'

/**
 * How long the job waits after it cancelled runs before it looks again: a running scriptRun job notices the cancel at
 * once in this process, or within CANCEL_POLL_MS (5 s) in another one, and then stops its container, which can take
 * the 60 s SIGTERM grace (STOP_RECHECK_MS rechecks until the run's job is no longer active).
 */
export const STOP_SETTLE_MS = 20_000

/** How long the job waits before it checks again whether a run's job is still active. */
export const STOP_RECHECK_MS = 5_000

/**
 * The stop phase: cancels the active runs of the script and defers the job while a run's job may still be working
 * (it just cancelled runs, or a scriptRun job of the script is still active). Returns only when nothing runs.
 */
export async function stopScriptRuns(scriptId: string, now = Date.now()): Promise<void> {
  const cancelled = await cancelActiveScriptRuns({ scriptId }, SCRIPT_DELETED)
  if (cancelled > 0) throw new JobDeferredError(new Date(now + STOP_SETTLE_MS), `cancelled ${cancelled} active run(s) of the script`)
  const active = await countActiveScriptRunJobs({ scriptId })
  if (active > 0) throw new JobDeferredError(new Date(now + STOP_RECHECK_MS), `${active} run job(s) of the script are still active`)
}

/**
 * A run that a start inserted after the stop phase (it resolved the script just before the deletion mark) sends the
 * job back to the stop phase, so the document is never removed while a run of it exists.
 */
async function assertNoLateRun(script: ScriptDoc, ctx: JobContext): Promise<void> {
  const late = await useCollections().scriptRuns.findOne({ scriptId: script._id }, { projection: { _id: 1 } })
  if (!late) return
  await ctx.saveCursor({ phase: 'stop' }, { done: 0, total: SCRIPT_DELETE_PHASES.length })
  throw new JobDeferredError(new Date(Date.now() + STOP_RECHECK_MS), `run ${late._id} was started while the script was being deleted`)
}

async function runPhase(phase: ScriptDeletePhase, script: ScriptDoc, ctx: JobContext): Promise<void> {
  switch (phase) {
    case 'stop':
      await stopScriptRuns(script._id)
      return
    case 'runs':
      await deleteScriptRunsData({ scriptId: script._id })
      return
    case 'images':
      await removeScriptImages(script._id)
      return
    case 'workspace':
      await deleteFolder(script.userId, scriptFolder(script))
      return
    case 'script':
      await assertNoLateRun(script, ctx)
      await useCollections().scripts.deleteOne({ _id: script._id, deletingAt: { $ne: null } })
      return
  }
}

async function loadScript(job: JobDoc): Promise<ScriptDoc | null> {
  return useCollections().scripts.findOne({ _id: job.subject.id })
}

export const scriptDeleteJobKind: JobKindDefinition = {
  component: 'reconciler',
  concurrency: 2,
  maxAttempts: 10,
  backoff: { initialMs: 10_000, maxMs: 300_000 },
  async handler(job: JobDoc, ctx: JobContext) {
    if (job.subject.kind !== 'script') throw new FatalJobError('invalidSubject', `scriptDelete needs a script subject, got ${job.subject.kind}`)
    const script = await loadScript(job)
    if (!script) return
    if (!script.deletingAt) throw new FatalJobError('invalidState', `script ${script._id} is not being deleted`)
    const resume = SCRIPT_DELETE_PHASES.indexOf(job.cursor.phase as ScriptDeletePhase)
    for (let index = Math.max(0, resume); index < SCRIPT_DELETE_PHASES.length; index++) {
      const phase = SCRIPT_DELETE_PHASES[index]!
      ctx.signal.throwIfAborted()
      await ctx.saveCursor({ phase }, { done: index, total: SCRIPT_DELETE_PHASES.length })
      await runPhase(phase, script, ctx)
    }
    await ctx.setProgress(SCRIPT_DELETE_PHASES.length, SCRIPT_DELETE_PHASES.length)
    ctx.log.info('script deleted', { scriptId: script._id, name: script.name, userId: script.userId })
  },
}
