import { cancelActiveJobs } from '../../utils/jobs'
import { useCollections } from '../../utils/mongo'
import { deletePrefix } from '../../utils/s3'
import type { UserPurgeContext, UserPurgeStep } from '../../utils/user-purge'
import { deleteScanAnalyses, deleteScanBrokerObjects, deleteScanExports, deleteScanWorkers, settleDelayMs } from './delete'
import { cancelScansOfUser } from './lifecycle'

// The scans steps of the userPurge job (docs/data-model.md §5; server/utils/user-purge.ts): step 10 cancels the
// user's scans, step 40 deletes them with the scan-delete logic (broker objects first, one settle delay for all
// scans, a final analyses sweep) and then removes the scan documents themselves: the user is gone, so no tombstone
// is kept (the ingestor drops results of unknown scans just like those of deleted ones). Both steps are idempotent.

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}

export async function purgeUserScans({ userId, config, signal, log }: UserPurgeContext): Promise<void> {
  const { scans, analyses, events } = useCollections()
  const ids = (await scans.find({ userId }, { projection: { _id: 1 } }).toArray()).map((scan) => scan._id)
  if (ids.length === 0) return
  // From here on the ingestor drops results of these scans (docs/queue.md §6.2 check 4).
  await scans.updateMany({ userId, state: { $ne: 'deleted' } }, { $set: { state: 'deleting', updatedAt: new Date() } })
  for (const scanId of ids) {
    signal.throwIfAborted()
    await cancelActiveJobs('scanRetryFailed', scanId)
    await cancelActiveJobs('scanDelete', scanId)
    await deleteScanBrokerObjects(scanId)
  }
  const settleUntil = Date.now() + settleDelayMs(config)
  for (const scanId of ids) {
    signal.throwIfAborted()
    await deleteScanWorkers(scanId)
    await deleteScanAnalyses(scanId, -1, async () => signal.throwIfAborted(), signal)
    await deletePrefix(`files/${scanId}/`)
    await deleteScanExports(scanId, log)
    await events.deleteMany({ scanId })
  }
  const remaining = settleUntil - Date.now()
  if (remaining > 0) await sleep(remaining, signal)
  await analyses.deleteMany({ scanId: { $in: ids } })
  await scans.deleteMany({ _id: { $in: ids }, userId })
  log.info('deleted the scans of a purged user', { userId, scans: ids.length })
}

export const userPurgeSteps: UserPurgeStep[] = [
  { name: 'cancel-scans', order: 10, run: ({ userId }) => cancelScansOfUser(userId) },
  { name: 'scans', order: 40, run: purgeUserScans },
]
