import type { Collection, Filter } from 'mongodb'
import type { Page } from '#shared/types/common'
import type { Worker } from '#shared/types/workers'
import type { WorkerState } from '#shared/utils/enums'
import type { NodeDoc, ScanDoc, WorkerDoc } from '../../types/documents'
import { createdAtCursorFilter, decodeCursor, encodeCursor, isCreatedAtCursor, pageLimit, type CreatedAtCursor } from '../../utils/pagination'
import { useCollections } from '../../utils/mongo'
import { isoDate, isoDateOrNull } from '../../utils/serialize'
import { toApiError, type WorkerStateCounts } from './mappers'

// Worker representations (docs/api.md §2 `Worker`): − spec.specHash, + node {id, name}, + scan {id, name}. Shared by
// listScanWorkers and (for orch-node-runtime) listNodeWorkers.

export function toApiWorker(doc: WorkerDoc, nodeNames: ReadonlyMap<string, string>, scanNames: ReadonlyMap<string, string | null>): Worker {
  const { specHash: _specHash, ...spec } = doc.spec
  return {
    id: doc._id,
    userId: doc.userId,
    scanId: doc.scanId,
    role: doc.role,
    nodeId: doc.nodeId,
    epoch: doc.epoch,
    state: doc.state,
    stateReason: doc.stateReason ? { code: doc.stateReason.code, message: doc.stateReason.message, at: isoDate(doc.stateReason.at) } : null,
    spec,
    processes: { ...doc.processes },
    container: doc.container
      ? {
          id: doc.container.id,
          name: doc.container.name,
          startedAt: isoDateOrNull(doc.container.startedAt),
          restarts: doc.container.restarts,
          lastExit: doc.container.lastExit ? { ...doc.container.lastExit, at: isoDate(doc.container.lastExit.at) } : null,
          nextRestartAt: isoDateOrNull(doc.container.nextRestartAt),
        }
      : null,
    runtime: doc.runtime
      ? {
          version: doc.runtime.version,
          protocolVersion: doc.runtime.protocolVersion,
          bootstrappedAt: isoDateOrNull(doc.runtime.bootstrappedAt),
          lastSeenAt: isoDateOrNull(doc.runtime.lastSeenAt),
          lastError: doc.runtime.lastError ? toApiError(doc.runtime.lastError) : null,
        }
      : null,
    logs: doc.logs
      ? {
          requestId: doc.logs.requestId,
          requestedAt: isoDate(doc.logs.requestedAt),
          tailBytes: doc.logs.tailBytes,
          text: doc.logs.text,
          collectedAt: isoDateOrNull(doc.logs.collectedAt),
          truncated: doc.logs.truncated,
        }
      : null,
    node: doc.nodeId ? { id: doc.nodeId, name: nodeNames.get(doc.nodeId) ?? doc.nodeId } : null,
    scan: { id: doc.scanId, name: scanNames.get(doc.scanId) ?? null },
    createdAt: isoDate(doc.createdAt),
    assignedAt: isoDateOrNull(doc.assignedAt),
    startedAt: isoDateOrNull(doc.startedAt),
    stoppedAt: isoDateOrNull(doc.stoppedAt),
    updatedAt: isoDate(doc.updatedAt),
    expiresAt: isoDateOrNull(doc.expiresAt),
  }
}

/** Node names of the given workers, for the `node` field of the representation. */
export async function nodeNamesOf(workers: readonly WorkerDoc[], nodes: Collection<NodeDoc> = useCollections().nodes): Promise<Map<string, string>> {
  const ids = [...new Set(workers.map((worker) => worker.nodeId).filter((id): id is string => id !== null))]
  if (ids.length === 0) return new Map()
  const docs = await nodes.find({ _id: { $in: ids } }, { projection: { _id: 1, name: 1 } }).toArray()
  return new Map(docs.map((doc) => [doc._id, doc.name]))
}

/** Counts of a scan's non-terminal workers by state (the `workers` summary of `Scan`). */
export async function workerStateCounts(scanId: string, workers: Collection<WorkerDoc> = useCollections().workers): Promise<WorkerStateCounts> {
  const groups = await workers
    .aggregate<{ _id: WorkerState; n: number }>([
      { $match: { scanId, state: { $nin: ['stopped', 'lost'] } } },
      { $group: { _id: '$state', n: { $sum: 1 } } },
    ])
    .toArray()
  return Object.fromEntries(groups.map((group) => [group._id, group.n]))
}

/** listScanWorkers: newest first, optionally filtered by state. */
export async function listScanWorkers(
  scan: Pick<ScanDoc, '_id' | 'name'>,
  query: { state?: WorkerState[]; limit?: number; cursor?: string },
): Promise<Page<Worker>> {
  const { workers } = useCollections()
  const limit = pageLimit(query.limit)
  const clauses: Filter<WorkerDoc>[] = [{ scanId: scan._id }]
  if (query.state && query.state.length > 0) clauses.push({ state: { $in: query.state } })
  if (query.cursor) clauses.push(createdAtCursorFilter<WorkerDoc>(decodeCursor(query.cursor, isCreatedAtCursor)))
  const docs = await workers
    .find(clauses.length === 1 ? clauses[0]! : { $and: clauses })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .toArray()
  const page = docs.slice(0, limit)
  const nodeNames = await nodeNamesOf(page)
  const scanNames = new Map([[scan._id, scan.name ?? null]])
  const last = page.at(-1)
  return {
    items: page.map((doc) => toApiWorker(doc, nodeNames, scanNames)),
    nextCursor: docs.length > limit && last ? encodeCursor({ t: last.createdAt.getTime(), i: last._id } satisfies CreatedAtCursor) : null,
  }
}
