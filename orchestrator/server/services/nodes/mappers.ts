import type { ScantorError } from '#shared/types/common'
import type { Event } from '#shared/types/events'
import type { Node } from '#shared/types/nodes'
import type { Worker } from '#shared/types/workers'
import type { EventDoc, NodeDoc, ScantorErrorDoc, WorkerDoc } from '../../types/documents'
import { isoDate, isoDateOrNull } from '../../utils/serialize'

// API representations of the node area (docs/api.md §2): `Node` (− tokenHash, instance.id; + activeWorkers),
// `Worker` (− spec.specHash; + node {id, name}, scan {id, name}) and `Event`.

export function toApiNode(doc: NodeDoc, activeWorkers: number): Node {
  return {
    id: doc._id,
    name: doc.name,
    builtIn: doc.builtIn,
    state: doc.state,
    endpointProfile: doc.endpointProfile,
    tokenPrefix: doc.tokenPrefix ?? null,
    tokenRotatedAt: isoDateOrNull(doc.tokenRotatedAt),
    pool: doc.pool,
    labels: doc.labels ?? {},
    maxWorkers: doc.maxWorkers ?? null,
    cordoned: doc.cordoned,
    instance: doc.instance
      ? { version: doc.instance.version, startedAt: isoDate(doc.instance.startedAt), lastSeenAt: isoDate(doc.instance.lastSeenAt) }
      : null,
    info: doc.info ? { ...doc.info } : null,
    assignmentsRev: doc.assignmentsRev,
    lastSeenAt: isoDateOrNull(doc.lastSeenAt),
    createdBy: doc.createdBy ?? null,
    activeWorkers,
    createdAt: isoDate(doc.createdAt),
    updatedAt: isoDate(doc.updatedAt),
  }
}

export function toApiScantorError(doc: ScantorErrorDoc): ScantorError {
  return { ...doc, at: isoDate(doc.at) }
}

export function toApiWorker(doc: WorkerDoc, refs: { node: { id: string; name: string } | null; scan: { id: string; name: string | null } }): Worker {
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
    processes: {
      desired: doc.processes.desired,
      assigned: doc.processes.assigned,
      applied: doc.processes.applied ?? null,
      running: doc.processes.running ?? null,
    },
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
          version: doc.runtime.version ?? null,
          protocolVersion: doc.runtime.protocolVersion ?? null,
          bootstrappedAt: isoDateOrNull(doc.runtime.bootstrappedAt),
          lastSeenAt: isoDateOrNull(doc.runtime.lastSeenAt),
          lastError: doc.runtime.lastError ? toApiScantorError(doc.runtime.lastError) : null,
          scheduler: doc.runtime.scheduler ?? null,
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
    node: refs.node,
    scan: refs.scan,
    createdAt: isoDate(doc.createdAt),
    assignedAt: isoDateOrNull(doc.assignedAt),
    startedAt: isoDateOrNull(doc.startedAt),
    stoppedAt: isoDateOrNull(doc.stoppedAt),
    updatedAt: isoDate(doc.updatedAt),
    expiresAt: isoDateOrNull(doc.expiresAt),
  }
}

export function toApiEvent(doc: EventDoc): Event {
  const event: Event = { id: doc._id, at: isoDate(doc.at), type: doc.type, level: doc.level, userId: doc.userId, message: doc.message }
  if (doc.scanId) event.scanId = doc.scanId
  if (doc.taskId) event.taskId = doc.taskId
  if (doc.revisionId) event.revisionId = doc.revisionId
  if (doc.workerId) event.workerId = doc.workerId
  if (doc.nodeId) event.nodeId = doc.nodeId
  if (doc.data) event.data = doc.data
  return event
}
