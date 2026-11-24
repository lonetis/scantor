import type { ScantorError } from '#shared/types/common'
import type { Event } from '#shared/types/events'
import type { DaemonConfigValues, Node, NodeDaemonConfig, NodeInfo } from '#shared/types/nodes'
import type { Worker } from '#shared/types/workers'
import type { EventDoc, NodeDoc, ScantorErrorDoc, WorkerDoc } from '../../types/documents'
import { isoDate, isoDateOrNull } from '../../utils/serialize'
import { instanceDaemonConfig, instanceOverrides } from './overrides'

// API representations of the node area (docs/api.md §2): `Node` (− tokenHash, instance.id; + activeWorkers, and the
// daemon configuration on request), `Worker` (− spec.specHash; + node {id, name}, scan {id, name}) and `Event`.

function toApiNodeInfo(info: NonNullable<NodeDoc['info']>): NodeInfo {
  const { resolver, ...rest } = info
  if (resolver === undefined) return { ...rest }
  return { ...rest, resolver: resolver ? { ...resolver, since: isoDate(resolver.since) } : null }
}

/**
 * `Node.daemonConfig` (docs/api.md §2): the configuration the current daemon instance reported with the overrides
 * set for that instance; null when no daemon of the current instance reported one. `pending` while the daemon has
 * not applied the latest overrides revision.
 */
export function toApiDaemonConfig(doc: NodeDoc): NodeDaemonConfig | null {
  const report = instanceDaemonConfig(doc)
  if (!report) return null
  const overrides = instanceOverrides(doc)
  const overridesRev = overrides?.rev ?? 0
  return {
    // A daemon of an older release lacks the keys added after it (docs/nodes.md §7.1); clients treat a missing
    // value as not reported.
    values: report.values as DaemonConfigValues,
    sources: report.sources,
    warnings: report.warnings,
    overrides: overrides?.values ?? {},
    overridesRev,
    appliedOverridesRev: report.appliedOverridesRev,
    pending: report.appliedOverridesRev !== overridesRev,
    rejected: report.rejected,
    overriddenBy: overrides?.updatedBy ?? null,
    overriddenAt: isoDateOrNull(overrides?.updatedAt),
    reportedAt: isoDate(report.reportedAt),
  }
}

export interface ApiNodeOptions {
  /** add `daemonConfig` (getNode, the daemon overrides routes, listNodes with include=daemonConfig) */
  daemonConfig?: boolean
}

export function toApiNode(doc: NodeDoc, activeWorkers: number, options: ApiNodeOptions = {}): Node {
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
    info: doc.info ? toApiNodeInfo(doc.info) : null,
    assignmentsRev: doc.assignmentsRev,
    lastSeenAt: isoDateOrNull(doc.lastSeenAt),
    createdBy: doc.createdBy ?? null,
    activeWorkers,
    ...(options.daemonConfig ? { daemonConfig: toApiDaemonConfig(doc) } : {}),
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
  if (doc.scriptId) event.scriptId = doc.scriptId
  if (doc.scriptRunId) event.scriptRunId = doc.scriptRunId
  if (doc.workerId) event.workerId = doc.workerId
  if (doc.nodeId) event.nodeId = doc.nodeId
  if (doc.data) event.data = doc.data
  return event
}
