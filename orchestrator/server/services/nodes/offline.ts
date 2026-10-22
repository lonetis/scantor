import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { notifyAssignmentsChanged } from './assignments'
import { recordEvent } from './events'
import { markNodeWorkersLost } from './workers'

// Node offline detection (reconciler, docs/nodes.md §7.4, docs/architecture.md §11.4 step 5): a node without a status
// for SCANTOR_NODE_OFFLINE_AFTER becomes `offline`, its active workers `lost` (their tokens stop validating at once;
// placement places replacements, a new scheduler gets epoch + 1). The next hello or status of the node sets it
// `online` again, and the shrunken desired set makes the daemon remove the stale containers.

export async function detectOfflineNodes(offlineAfterMs: number, log: Logger, now = new Date()): Promise<string[]> {
  const { nodes } = useCollections()
  const threshold = new Date(now.getTime() - offlineAfterMs)
  const stale = await nodes.find({ state: 'online', lastSeenAt: { $lt: threshold } }, { projection: { _id: 1, name: 1 } }).toArray()
  const offline: string[] = []
  for (const node of stale) {
    const result = await nodes.updateOne(
      { _id: node._id, state: 'online', lastSeenAt: { $lt: threshold } },
      { $set: { state: 'offline', updatedAt: now } },
    )
    if (result.modifiedCount === 0) continue
    offline.push(node._id)
    const lost = await markNodeWorkersLost(node._id, 'nodeOffline', now)
    if (lost.length > 0) await notifyAssignmentsChanged(node._id)
    await recordEvent({
      type: 'node.offline',
      level: 'warning',
      nodeId: node._id,
      message: `node ${node.name} sent no status for ${Math.round(offlineAfterMs / 1000)} s; ${lost.length} worker${lost.length === 1 ? '' : 's'} lost`,
      data: { lostWorkers: lost.length },
      at: now,
    }, log)
    log.warn('node offline', { nodeId: node._id, lostWorkers: lost.length })
  }
  return offline
}
