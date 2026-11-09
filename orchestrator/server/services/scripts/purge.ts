import { JobDeferredError } from '../../utils/jobs'
import { useCollections } from '../../utils/mongo'
import type { UserPurgeContext, UserPurgeStep } from '../../utils/user-purge'
import { cancelActiveScriptRuns, countActiveScriptRunJobs, deleteScriptRunsData, removeScriptImages } from '../script-runs/cleanup'
import { STOP_RECHECK_MS, STOP_SETTLE_MS } from './delete'

// The scripts step of the userPurge job (docs/data-model.md §5, server/utils/user-purge.ts): 65 deletes the user's
// script runs (S3 `script-runs/<id>/`, log chunks, documents), the scripts' local images and the script documents.
// Step 15 (the script-run lifecycle) cancelled the active runs long before; this step cancels again for a start that
// raced the lockout and defers the purge job while a run's job is still active. The workspace step (80) removes the
// script folders with the rest of the workspace. Idempotent; the user is locked out, so no new scripts appear.

export const USER_PURGE_REASON = 'the user was deleted'

export async function purgeUserScripts({ userId, signal, log }: UserPurgeContext): Promise<void> {
  const cancelled = await cancelActiveScriptRuns({ userId }, USER_PURGE_REASON)
  if (cancelled > 0) throw new JobDeferredError(new Date(Date.now() + STOP_SETTLE_MS), `cancelled ${cancelled} active script run(s) of the user`)
  const active = await countActiveScriptRunJobs({ userId })
  if (active > 0) throw new JobDeferredError(new Date(Date.now() + STOP_RECHECK_MS), `${active} script run job(s) of the user are still active`)
  await deleteScriptRunsData({ userId })
  const { scripts } = useCollections()
  const owned = await scripts.find({ userId }, { projection: { _id: 1 } }).toArray()
  for (const script of owned) {
    signal.throwIfAborted()
    await removeScriptImages(script._id)
  }
  const { deletedCount } = await scripts.deleteMany({ userId })
  log.info('deleted the scripts of a purged user', { userId, scripts: deletedCount })
}

export const scriptPurgeSteps: UserPurgeStep[] = [{ name: 'scripts', order: 65, run: purgeUserScripts }]
