import { randomUUID } from 'node:crypto'
import type { Filter } from 'mongodb'
import { ACTIVE_SCAN_STATES, ACTIVE_WORKER_STATES, type PendingReason, type WorkerRole } from '#shared/utils/enums'
import type { ScanDoc, WorkerDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { getScanInflight } from '../inflight'
import { notifyAssignmentsChanged } from '../nodes/assignments'
import { reconcileCondition } from '../scans/conditions'
import { type EventInput, writeEvents } from '../scans/events'
import { desiredProcesses, planDesiredWorkers } from './desired'
import { planPlacement } from './place'
import { specHash } from './spec'
import type { DesiredPlan, PlacementPlan, PlacementScan, PlacementSnapshot, PlacementWorker } from './types'

/*
 * Placement (docs/nodes.md §12, docs/architecture.md §11.2 step 3): loads a snapshot, runs the pure planners of
 * ./desired.ts and ./place.ts and applies their plans with conditional writes. Workers are created `pending` (a new
 * scheduler gets `++scan.scheduling.epoch`), placed workers become `assigned` with `nodeId`, `spec.dindMode`,
 * `spec.specHash` and `processes.assigned`; nodes whose desired set changed get notifyAssignmentsChanged. Placement
 * mints nothing: worker tokens are derived when assignments are served. Runs under the reconciler lock.
 */

export const STOPPED_WORKER_TTL_MS = 7 * 86_400_000

export const PENDING_MESSAGES: Record<PendingReason, string> = {
  noNodes: 'no online node is available',
  archMismatch: 'no online node has the platform of the revision',
  selectorMismatch: 'no node matches the scan’s node selector',
  insufficientCapacity: 'no matching node has free capacity',
  userMaxWorkers: 'the owner’s worker limit is reached',
  dindUnavailable: 'no node allows Docker-in-Docker (privileged) workers',
  diskLow: 'the matching nodes are low on disk space',
  pullLimit: 'waiting for other image pulls to finish',
}

export interface PlacementDeps {
  config: Pick<Config, 'nodeMinFreeDiskBytes' | 'placementMaxConcurrentPulls' | 'workerCapAdd'>
  log: Logger
  now?: () => Date
}

function toPlacementScan(scan: ScanDoc): PlacementScan {
  return {
    id: scan._id,
    userId: scan.userId,
    state: scan.state,
    createdAt: scan.createdAt,
    startedAt: scan.startedAt,
    schedulingState: scan.scheduling.state,
    settings: {
      workers: scan.settings.workers,
      processes: scan.settings.processes,
      resources: scan.settings.resources,
      nodeSelector: scan.settings.nodeSelector,
    },
    revision: {
      repository: scan.revision.repository,
      digest: scan.revision.digest,
      platform: scan.revision.platform,
      privileged: scan.revision.privileged,
    },
  }
}

function toPlacementWorker(worker: WorkerDoc): PlacementWorker {
  return {
    id: worker._id,
    scanId: worker.scanId,
    userId: worker.userId,
    role: worker.role,
    state: worker.state,
    nodeId: worker.nodeId,
    createdAt: worker.createdAt,
    digest: worker.spec.digest,
    resources: worker.spec.resources,
    privileged: worker.spec.privileged,
    processes: { desired: worker.processes.desired, assigned: worker.processes.assigned, running: worker.processes.running },
    reason: worker.state === 'pending' ? (worker.stateReason?.code ?? null) : null,
  }
}

/** Loads the placement snapshot: non-terminal workers, the scans they or the desired set need, nodes and users. */
export async function loadSnapshot(deps: PlacementDeps): Promise<{ snapshot: PlacementSnapshot; scans: Map<string, ScanDoc> }> {
  const { scans, workers, nodes, authUsers } = useCollections()
  const now = deps.now?.() ?? new Date()
  const workerDocs = await workers.find({ state: { $nin: ['stopped', 'lost'] } }).toArray()
  // Scans that still carry workersPending are included so their condition is cleared once they stopped running.
  const scanDocs = await scans
    .find({
      $or: [
        { state: { $in: [...ACTIVE_SCAN_STATES] } },
        { _id: { $in: [...new Set(workerDocs.map((worker) => worker.scanId))] } },
        { 'conditions.type': 'workersPending' },
      ],
    })
    .toArray()
  const nodeDocs = await nodes.find({}).toArray()
  const userIds = [...new Set([...workerDocs.map((worker) => worker.userId), ...scanDocs.map((scan) => scan.userId)])]
  const users = await authUsers.find({ _id: { $in: userIds } }, { projection: { _id: 1, maxWorkers: 1 } }).toArray()
  const busy: Record<string, number> = {}
  for (const scan of scanDocs) {
    if (scan.state !== 'running') continue
    for (const item of getScanInflight(scan._id).items) busy[item.workerId] = (busy[item.workerId] ?? 0) + 1
  }
  return {
    scans: new Map(scanDocs.map((scan) => [scan._id, scan])),
    snapshot: {
      now,
      scans: scanDocs.map(toPlacementScan),
      workers: workerDocs.map(toPlacementWorker),
      nodes: nodeDocs.map((node) => ({
        id: node._id,
        builtIn: node.builtIn,
        state: node.state,
        cordoned: node.cordoned,
        hasToken: node.tokenHash !== null,
        pool: node.pool,
        labels: node.labels ?? {},
        maxWorkers: node.maxWorkers,
        info: node.info
          ? {
              os: node.info.os,
              arch: node.info.arch,
              cpus: node.info.cpus,
              memoryBytes: node.info.memoryBytes,
              diskFreeBytes: node.info.diskFreeBytes,
              dindMode: node.info.dindMode,
              maxWorkers: node.info.maxWorkers,
            }
          : null,
      })),
      userMaxWorkers: Object.fromEntries(users.map((user) => [user._id, typeof user.maxWorkers === 'number' ? user.maxWorkers : 0])),
      busy,
      minFreeDiskBytes: deps.config.nodeMinFreeDiskBytes,
      maxConcurrentPulls: deps.config.placementMaxConcurrentPulls,
    },
  }
}

function newWorker(scan: ScanDoc, role: WorkerRole, epoch: number, now: Date): WorkerDoc {
  return {
    _id: randomUUID(),
    userId: scan.userId,
    scanId: scan._id,
    role,
    nodeId: null,
    epoch,
    state: 'pending',
    stateReason: null,
    spec: {
      repository: scan.revision.repository,
      digest: scan.revision.digest,
      resources: { ...scan.settings.resources },
      privileged: scan.revision.privileged,
      dindMode: null,
      specHash: '',
    },
    processes: { desired: desiredProcesses(toPlacementScan(scan), role), assigned: 0, applied: null, running: null },
    container: null,
    runtime: null,
    logs: null,
    createdAt: now,
    assignedAt: null,
    startedAt: null,
    stoppedAt: null,
    updatedAt: now,
  }
}

const PLACED_STATES = ACTIVE_WORKER_STATES.filter((state) => state !== 'draining')

async function applyDesiredPlan(plan: DesiredPlan, scans: Map<string, ScanDoc>, workerDocs: Map<string, PlacementWorker>, now: Date): Promise<Set<string>> {
  const { scans: scanCollection, workers } = useCollections()
  const touched = new Set<string>()
  const events: EventInput[] = []
  for (const insert of plan.inserts) {
    const scan = scans.get(insert.scanId)
    if (!scan) continue
    if (insert.role === 'scheduler') {
      // A new scheduler fences every older one with a higher epoch (docs/data-model.md §7 invariant 4).
      const updated = await scanCollection.findOneAndUpdate(
        { _id: scan._id, state: 'running', 'scheduling.state': { $in: ['pending', 'running'] } },
        { $inc: { 'scheduling.epoch': 1 } },
        { returnDocument: 'after', projection: { scheduling: 1 } },
      )
      if (!updated) continue
      await workers.insertOne(newWorker(scan, 'scheduler', updated.scheduling.epoch, now))
    } else {
      await workers.insertMany(Array.from({ length: insert.count }, () => newWorker(scan, 'runner', 0, now)))
    }
  }
  for (const stop of plan.stops) {
    const result = await workers.updateOne(
      { _id: stop.workerId, state: 'pending' },
      {
        $set: {
          state: 'stopped',
          stoppedAt: now,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + STOPPED_WORKER_TTL_MS),
          stateReason: { code: 'notNeeded', message: 'no longer needed before placement', at: now },
        },
      },
    )
    const worker = workerDocs.get(stop.workerId)
    if (result.modifiedCount > 0 && worker) {
      events.push({ type: 'worker.stopped', level: 'info', userId: worker.userId, scanId: worker.scanId, workerId: worker.id, message: 'pending worker no longer needed', data: { reason: 'notNeeded' } })
    }
  }
  for (const drain of plan.drains) {
    const result = await workers.updateOne(
      { _id: drain.workerId, state: { $in: [...PLACED_STATES] } },
      { $set: { state: 'draining', updatedAt: now, stateReason: { code: 'drain', message: drain.reason, at: now } } },
    )
    if (result.modifiedCount > 0) touched.add(drain.nodeId)
  }
  for (const update of plan.desiredUpdates) {
    await workers.updateOne({ _id: update.workerId, state: { $nin: ['stopped', 'lost'] } }, { $set: { 'processes.desired': update.desired, updatedAt: now } })
  }
  await writeEvents(events)
  return touched
}

async function applyPlacementPlan(
  plan: PlacementPlan,
  scans: Map<string, ScanDoc>,
  workerDocs: Map<string, PlacementWorker>,
  deps: PlacementDeps,
  now: Date,
): Promise<Set<string>> {
  const { workers } = useCollections()
  const touched = new Set<string>()
  const events: EventInput[] = []
  for (const placement of plan.placements) {
    const scan = scans.get(placement.scanId)
    const worker = workerDocs.get(placement.workerId)
    if (!scan || !worker) continue
    const hash = specHash({
      repository: scan.revision.repository,
      digest: worker.digest,
      privileged: worker.privileged,
      dindMode: placement.dindMode,
      capAdd: deps.config.workerCapAdd,
    })
    const result = await workers.updateOne(
      { _id: placement.workerId, state: 'pending' } as Filter<WorkerDoc>,
      {
        $set: {
          state: 'assigned',
          nodeId: placement.nodeId,
          assignedAt: now,
          updatedAt: now,
          stateReason: null,
          'spec.dindMode': placement.dindMode,
          'spec.specHash': hash,
          'processes.assigned': placement.assigned,
        },
      },
    )
    if (result.modifiedCount === 0) continue
    touched.add(placement.nodeId)
    events.push({
      type: 'worker.placed',
      level: 'info',
      userId: worker.userId,
      scanId: worker.scanId,
      workerId: worker.id,
      nodeId: placement.nodeId,
      message: `${worker.role} placed`,
      data: { nodeId: placement.nodeId },
    })
  }
  for (const pending of plan.pending) {
    const worker = workerDocs.get(pending.workerId)
    const result = await workers.updateOne(
      { _id: pending.workerId, state: 'pending' },
      { $set: { stateReason: { code: pending.reason, message: PENDING_MESSAGES[pending.reason], at: now }, updatedAt: now } },
    )
    if (result.modifiedCount > 0 && worker) {
      events.push({
        type: 'worker.pending',
        level: 'warning',
        userId: worker.userId,
        scanId: worker.scanId,
        workerId: worker.id,
        message: `${worker.role} cannot be placed: ${PENDING_MESSAGES[pending.reason]}`,
        data: { reason: pending.reason },
      })
    }
  }
  for (const resize of plan.resizes) {
    const result = await workers.updateOne(
      { _id: resize.workerId, nodeId: resize.nodeId, state: { $in: [...PLACED_STATES] } },
      { $set: { 'processes.assigned': resize.assigned, updatedAt: now } },
    )
    if (result.modifiedCount > 0) touched.add(resize.nodeId)
  }
  for (const [scanId, details] of Object.entries(plan.conditions)) {
    const scan = scans.get(scanId)
    if (!scan) continue
    const top = details ? (Object.entries(details.reasons).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0]?.[0] as PendingReason | undefined) : undefined
    await reconcileCondition(
      scan,
      'workersPending',
      details && top
        ? { reason: top, message: `${details.count} worker${details.count === 1 ? '' : 's'} cannot be placed: ${PENDING_MESSAGES[top]}`, details }
        : null,
      now,
    )
  }
  await writeEvents(events)
  return touched
}

/** One placement pass (both phases). Returns the number of placements. */
export async function runPlacement(deps: PlacementDeps): Promise<number> {
  const now = deps.now?.() ?? new Date()
  const first = await loadSnapshot(deps)
  const desired = planDesiredWorkers(first.snapshot)
  const touched = await applyDesiredPlan(desired, first.scans, new Map(first.snapshot.workers.map((worker) => [worker.id, worker])), now)

  const second = await loadSnapshot(deps)
  const plan = planPlacement(second.snapshot)
  for (const nodeId of await applyPlacementPlan(plan, second.scans, new Map(second.snapshot.workers.map((worker) => [worker.id, worker])), deps, now)) {
    touched.add(nodeId)
  }
  for (const nodeId of [...touched].sort()) await notifyAssignmentsChanged(nodeId)
  if (plan.placements.length > 0 || desired.inserts.length > 0 || desired.drains.length > 0) {
    deps.log.debug('placement pass', {
      inserted: desired.inserts.reduce((sum, insert) => sum + insert.count, 0),
      stopped: desired.stops.length,
      draining: desired.drains.length,
      placed: plan.placements.length,
      resized: plan.resizes.length,
    })
  }
  return plan.placements.length
}
