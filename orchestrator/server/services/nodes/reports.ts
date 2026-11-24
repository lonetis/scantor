import type { z } from 'zod'
import { type DaemonConfigReport, daemonConfigReport, NODE_SUB_REPORT_MAX_BYTES, type NodeResolverReportInput, nodeResolverReport } from '#shared/schemas/nodes'
import type { ResolverState } from '#shared/types/nodes'
import type { DaemonConfigDoc, NodeDoc, NodeResolverDoc } from '../../types/documents'
import type { Logger } from '../../utils/logger'
import { zodIssues } from '../../utils/zod'
import type { EventInput } from './events'

// Daemon-reported sub-reports of hello and status (docs/nodes.md §6.11, §6.12, §7.1): the daemon configuration and
// the node resolver state. They are parsed apart from the heartbeat, so a report that fails its schema can never
// fail the status (the node would go offline and lose its workers): an oversized or invalid sub-report is stored as
// null and logged (at most every 10 minutes per node and kind). An absent one in a status leaves the stored report
// alone; a hello replaces the stored reports (with null without one).

export type SubReportKind = 'daemonConfig' | 'resolver'

const INVALID_LOG_INTERVAL_MS = 10 * 60_000
/** When an invalid sub-report was last logged, per `<nodeId>:<kind>`. */
const invalidLoggedAt = new Map<string, number>()

function logInvalid(log: Logger, nodeId: string, kind: SubReportKind, fields: Record<string, unknown>, now: number): void {
  const key = `${nodeId}:${kind}`
  const last = invalidLoggedAt.get(key)
  if (last !== undefined && now - last < INVALID_LOG_INTERVAL_MS) return
  invalidLoggedAt.set(key, now)
  log.warn('node sent an invalid sub-report; stored as null', { nodeId, kind, ...fields })
}

/**
 * Parses one sub-report: undefined when the key is absent (an older daemon; the stored report stays), null when it is
 * null, larger than NODE_SUB_REPORT_MAX_BYTES or invalid.
 */
export function parseSubReport<T extends z.ZodType>(
  schema: T,
  raw: unknown,
  kind: SubReportKind,
  nodeId: string,
  log: Logger,
  now = Date.now(),
): z.output<T> | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  const bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8')
  if (bytes > NODE_SUB_REPORT_MAX_BYTES) {
    logInvalid(log, nodeId, kind, { bytes, maxBytes: NODE_SUB_REPORT_MAX_BYTES }, now)
    return null
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    logInvalid(log, nodeId, kind, { issues: zodIssues(result.error).slice(0, 10) }, now)
    return null
  }
  invalidLoggedAt.delete(`${nodeId}:${kind}`)
  return result.data
}

export function toResolverDoc(report: NodeResolverReportInput, now: Date): NodeResolverDoc {
  const { since, ...rest } = report
  return { ...rest, since: since ? new Date(since) : now }
}

export function toDaemonConfigDoc(report: DaemonConfigReport, instanceId: string, now: Date): DaemonConfigDoc {
  return {
    instanceId,
    appliedOverridesRev: report.appliedOverridesRev,
    values: report.values,
    sources: report.sources,
    warnings: report.warnings,
    rejected: report.rejected,
    reportedAt: now,
  }
}

/** The sub-reports of one hello or status body; undefined = not sent, null = null or invalid. */
export interface NodeSubReports {
  daemonConfig: DaemonConfigDoc | null | undefined
  resolver: NodeResolverDoc | null | undefined
}

export function parseNodeSubReports(
  body: { instanceId: string; daemonConfig?: unknown; info: { resolver?: unknown } },
  nodeId: string,
  log: Logger,
  now: Date,
): NodeSubReports {
  const config = parseSubReport(daemonConfigReport, body.daemonConfig, 'daemonConfig', nodeId, log, now.getTime())
  const resolver = parseSubReport(nodeResolverReport, body.info.resolver, 'resolver', nodeId, log, now.getTime())
  return {
    daemonConfig: config ? toDaemonConfigDoc(config, body.instanceId, now) : config,
    resolver: resolver ? toResolverDoc(resolver, now) : resolver,
  }
}

// ── resolver events ─────────────────────────────────────────────────────────

/** States in which new workers do not use the node resolver because it cannot serve them. */
export const FAILING_RESOLVER_STATES: readonly ResolverState[] = ['failed', 'degraded', 'unreachable']

function isFailing(state: ResolverState | null | undefined): state is ResolverState {
  return state != null && FAILING_RESOLVER_STATES.includes(state)
}

/**
 * The change of `NodeDoc.resolverFailedState` a resolver report implies: a failing state is remembered, `ready` clears
 * it, and the states in between (starting, disabled) and absent or invalid reports leave it alone. A resolver that
 * recovers through `starting` (a restarted or replaced container, a restarted daemon) is thereby still known to have
 * failed when it is ready again.
 */
export function resolverFailedStateUpdate(next: NodeResolverDoc | null | undefined): Partial<Pick<NodeDoc, 'resolverFailedState'>> {
  if (!next) return {}
  if (isFailing(next.state)) return { resolverFailedState: next.state }
  return next.state === 'ready' ? { resolverFailedState: null } : {}
}

/**
 * The event of a resolver state change (none for a report without a state change): `node.resolverFailed` when it
 * enters failed, degraded or unreachable; `node.resolverReady` when it is ready after one of them, directly or through
 * states in between (`NodeDoc.resolverFailedState`), with that failing state as `previousState`. A resolver that is
 * ready for the first time (a daemon start: starting → ready) records nothing.
 */
export function resolverTransitionEvent(
  node: Pick<NodeDoc, '_id' | 'name' | 'resolverFailedState'>,
  previous: NodeResolverDoc | null | undefined,
  next: NodeResolverDoc | null | undefined,
  at: Date,
): EventInput | null {
  if (!next) return null
  const before = previous?.state ?? null
  if (before === next.state) return null
  if (isFailing(next.state)) {
    return {
      type: 'node.resolverFailed',
      level: 'warning',
      nodeId: node._id,
      message: `the node resolver of node ${node.name} is ${next.state}${next.error ? ` (${next.error})` : ''}; new workers use Docker's DNS`,
      data: { state: next.state, previousState: before, mode: next.mode, error: next.error, ...(next.detail ? { detail: next.detail } : {}) },
      at,
    }
  }
  if (next.state !== 'ready') return null
  const failedState = isFailing(before) ? before : (node.resolverFailedState ?? null)
  if (!isFailing(failedState)) return null
  return {
    type: 'node.resolverReady',
    level: 'info',
    nodeId: node._id,
    message: `the node resolver of node ${node.name} is ready again; new workers use it`,
    data: { state: next.state, previousState: failedState, mode: next.mode },
    at,
  }
}
