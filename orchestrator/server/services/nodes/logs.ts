import type { WorkerLogsBody } from '#shared/schemas/nodes'
import type { NodeDoc } from '../../types/documents'
import { apiError } from '../../utils/errors'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { notifyAssignmentsChanged } from './assignments'

// On-demand worker log tails, node side (docs/api.md §7.4, docs/nodes.md §7.3). getWorkerLogs (scans area) stores
// `workers.logs = {requestId, requestedAt, tailBytes, text: null, collectedAt: null}` and bumps the node's
// assignments revision, so the next assignments response carries it in `logRequests`. The daemon answers with
// `POST /api/node/workers/{workerId}/logs`; only the worker's own node and the open request id are accepted, and the
// text is cut to the requested tail size.

/** Cuts a text to its last `maxBytes` bytes on a UTF-8 boundary. */
export function tailBytesOf(text: string, maxBytes: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return { text, cut: false }
  let start = bytes.length - maxBytes
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++
  return { text: bytes.subarray(start).toString('utf8'), cut: true }
}

/** Stores the daemon's answer to an open log request of one of its workers (204 on success, 404 otherwise). */
export async function storeWorkerLogs(node: Pick<NodeDoc, '_id'>, workerId: string, body: WorkerLogsBody, log: Logger): Promise<void> {
  const { workers } = useCollections()
  const worker = await workers.findOne({ _id: workerId, nodeId: node._id }, { projection: { logs: 1 } })
  if (!worker?.logs || worker.logs.requestId !== body.requestId || worker.logs.collectedAt) {
    log.info('log answer for an unknown request or a worker of another node ignored', { nodeId: node._id, workerId })
    throw apiError('notFound', 'no open log request for this worker on this node')
  }
  const bounded = tailBytesOf(body.text, worker.logs.tailBytes)
  const result = await workers.updateOne(
    { _id: workerId, nodeId: node._id, 'logs.requestId': body.requestId, 'logs.collectedAt': null },
    {
      $set: {
        'logs.text': bounded.text,
        'logs.collectedAt': new Date(body.collectedAt),
        'logs.truncated': body.truncated || bounded.cut,
        updatedAt: new Date(),
      },
    },
  )
  if (result.modifiedCount === 0) throw apiError('notFound', 'no open log request for this worker on this node')
  // The answered request leaves the node's log requests (docs/data-model.md §4.8 assignmentsRev).
  await notifyAssignmentsChanged(node._id)
}
