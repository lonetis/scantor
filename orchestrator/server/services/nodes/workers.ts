import { ACTIVE_WORKER_STATES } from '#shared/utils/enums'
import type { WorkerDoc } from '../../types/documents'
import { useCollections } from '../../utils/mongo'
import { forgetWorker } from '../inflight'
import { type EventInput, recordEvents } from './events'

// Worker state changes owned by the node area (docs/data-model.md §6.6): `lost` when a node goes offline, is
// revoked or deleted (their worker tokens stop validating at once; placement creates replacements), and the TTL of
// terminal worker documents (7 days after they stopped).

export const WORKER_RETENTION_MS = 7 * 86_400_000

export type LostReason = 'nodeOffline' | 'nodeRevoked' | 'nodeDeleted'

const LOST_MESSAGES: Record<LostReason, string> = {
  nodeOffline: 'the node stopped reporting',
  nodeRevoked: 'the node token was revoked',
  nodeDeleted: 'the node was deleted',
}

export function workerExpiresAt(stoppedAt: Date): Date {
  return new Date(stoppedAt.getTime() + WORKER_RETENTION_MS)
}

/** Marks every active worker of a node `lost`; returns the workers that changed. */
export async function markNodeWorkersLost(nodeId: string, reason: LostReason, now = new Date()): Promise<WorkerDoc[]> {
  const { workers } = useCollections()
  const candidates = await workers.find({ nodeId, state: { $in: [...ACTIVE_WORKER_STATES] } }).toArray()
  const lost: WorkerDoc[] = []
  for (const worker of candidates) {
    const result = await workers.updateOne(
      { _id: worker._id, state: { $in: [...ACTIVE_WORKER_STATES] } },
      {
        $set: {
          state: 'lost',
          stateReason: { code: reason, message: LOST_MESSAGES[reason], at: now },
          stoppedAt: now,
          expiresAt: workerExpiresAt(now),
          updatedAt: now,
        },
      },
    )
    if (result.modifiedCount === 1) {
      lost.push(worker)
      forgetWorker(worker._id)
    }
  }
  const events: EventInput[] = lost.map((worker) => ({
    type: 'worker.lost',
    level: 'warning',
    userId: worker.userId,
    scanId: worker.scanId,
    workerId: worker._id,
    nodeId,
    message: `${worker.role} worker lost: ${LOST_MESSAGES[reason]}`,
    data: { reason },
    at: now,
  }))
  await recordEvents(events)
  return lost
}
