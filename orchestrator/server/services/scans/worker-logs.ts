import { randomUUID } from 'node:crypto'
import type { H3Event } from 'h3'
import type { WorkerLogs } from '#shared/types/scans'
import { ACTIVE_WORKER_STATES } from '#shared/utils/enums'
import type { ScanDoc, WorkerDoc } from '../../types/documents'
import { apiError } from '../../utils/errors'
import { useCollections } from '../../utils/mongo'
import { isoDateOrNull } from '../../utils/serialize'
import { loadWithWait } from '../../utils/wait'
import { notifyAssignmentsChanged } from '../nodes/assignments'

/*
 * getWorkerLogs (docs/api.md §4.13, §7.2, §7.4; docs/nodes.md §7.3): every call requests a fresh tail from the node
 * that runs the worker. The request is recorded in `workers.logs` as `{requestId, requestedAt, tailBytes, text: null,
 * collectedAt: null, truncated: false}` and the node's assignments revision is bumped, so the node's long-poll returns
 * it in `logRequests`; the node answers with POST /api/node/workers/{workerId}/logs, which fills `text`,
 * `collectedAt` and `truncated` for the matching `requestId`. `text: null` therefore means "pending". An unanswered
 * request younger than REUSE_MS with the same size is reused instead of asking again.
 */

const REUSE_MS = 10_000

type LogsDoc = NonNullable<WorkerDoc['logs']>

/**
 * The response: the latest tail; while a request is still unanswered (`pending`), the tail collected for the
 * previous request (`previous`) is shown instead of nothing.
 */
export function toWorkerLogs(worker: Pick<WorkerDoc, 'logs'>, previous: LogsDoc | null = null): WorkerLogs {
  const logs = worker.logs
  const pending = logs !== null && logs !== undefined && logs.text === null
  const shown = pending && previous ? previous : logs
  return {
    text: shown?.text ?? '',
    collectedAt: isoDateOrNull(shown?.collectedAt),
    requestedAt: isoDateOrNull(logs?.requestedAt),
    pending,
    truncated: shown?.truncated ?? false,
  }
}

function canCollect(worker: WorkerDoc): boolean {
  return worker.nodeId !== null && (ACTIVE_WORKER_STATES as readonly string[]).includes(worker.state)
}

export async function getWorkerLogs(
  event: H3Event,
  scan: Pick<ScanDoc, '_id'>,
  workerId: string,
  options: { tailBytes: number; waitSeconds: number | undefined; userId: string },
): Promise<WorkerLogs> {
  const { workers } = useCollections()
  const worker = await workers.findOne({ _id: workerId, scanId: scan._id })
  if (!worker) throw apiError('notFound', 'worker not found')

  let requestId: string | null = null
  const previous = worker.logs && worker.logs.text !== null ? worker.logs : null
  if (canCollect(worker)) {
    const now = new Date()
    const outstanding = worker.logs
    if (outstanding && outstanding.text === null && outstanding.tailBytes === options.tailBytes && now.getTime() - outstanding.requestedAt.getTime() < REUSE_MS) {
      requestId = outstanding.requestId
    } else {
      requestId = randomUUID()
      await workers.updateOne(
        { _id: worker._id, state: { $in: [...ACTIVE_WORKER_STATES] } },
        { $set: { logs: { requestId, requestedAt: now, tailBytes: options.tailBytes, text: null, collectedAt: null, truncated: false }, updatedAt: now } },
      )
      await notifyAssignmentsChanged(worker.nodeId!)
    }
  }

  const current = await loadWithWait(event, {
    waitSeconds: requestId ? options.waitSeconds : 0,
    userId: options.userId,
    load: async () => (await workers.findOne({ _id: worker._id }, { projection: { logs: 1 } })) ?? { logs: null },
    settled: (doc) => doc.logs?.requestId !== requestId || doc.logs?.text !== null,
    watch: { collection: workers as never, id: worker._id },
  })
  return toWorkerLogs(current, previous)
}
