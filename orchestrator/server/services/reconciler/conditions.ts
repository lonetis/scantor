import type { Collection } from 'mongodb'
import { ACTIVE_WORKER_STATES } from '#shared/utils/enums'
import type { NodeDoc, ScanDoc, WorkerDoc } from '../../types/documents'
import { clearCondition, reconcileCondition } from '../scans/conditions'

/*
 * Condition housekeeping of the reconciler (docs/data-model.md §4.5.4). Conditions raised elsewhere are cleared
 * here when their clearing rule holds; the reconciler-owned ones are raised and cleared here:
 *
 *   brokerAlarm   raised on running scans while RabbitMQ reports a memory or disk alarm; cleared when gone
 *   clockSkew     raised when a node running the scan's workers reports |clockOffsetMs| > 2000; cleared below
 *   crashLoop     cleared when no worker of the scan was in `backoff` for 5 minutes
 *   workerErrors  cleared when no runtime error was reported for 10 minutes
 *
 * workersPending (placement), topologyFailed (topology), schedulerRestarting (scheduler supervision) are handled by
 * their own steps; breakerTripped clears on resume, stalled and schedulingFailed never clear.
 */

export const CLOCK_SKEW_LIMIT_MS = 2000
export const CRASH_LOOP_CLEAR_MS = 5 * 60_000
export const WORKER_ERRORS_CLEAR_MS = 10 * 60_000
const RECENT_MS = 60 * 60_000

export interface ConditionDeps {
  scans: Collection<ScanDoc>
  workers: Collection<WorkerDoc>
  nodes: Collection<NodeDoc>
  now?: () => Date
}

export async function reconcileHousekeepingConditions(deps: ConditionDeps, alarms: readonly string[] | null): Promise<void> {
  const now = deps.now?.() ?? new Date()
  // Non-running scans only need their conditions cleared, which happens within minutes of their last change.
  const scans = await deps.scans
    .find({
      $or: [
        { state: 'running' },
        {
          state: { $in: ['creating', 'paused', 'completed', 'failed', 'cancelled'] },
          updatedAt: { $gte: new Date(now.getTime() - RECENT_MS) },
          'conditions.0': { $exists: true },
        },
      ],
    })
    .toArray()
  if (scans.length === 0) return
  const active = await deps.workers
    .find({ scanId: { $in: scans.map((scan) => scan._id) }, state: { $in: [...ACTIVE_WORKER_STATES] } }, { projection: { scanId: 1, nodeId: 1, state: 1 } })
    .toArray()
  const nodeIds = [...new Set(active.map((worker) => worker.nodeId).filter((id): id is string => id !== null))]
  const nodes = nodeIds.length > 0 ? await deps.nodes.find({ _id: { $in: nodeIds } }, { projection: { _id: 1, info: 1 } }).toArray() : []
  const offsets = new Map(nodes.map((node) => [node._id, node.info?.clockOffsetMs ?? 0]))

  for (const scan of scans) {
    const workers = active.filter((worker) => worker.scanId === scan._id)
    if (alarms !== null) {
      await reconcileCondition(
        scan,
        'brokerAlarm',
        scan.state === 'running' && alarms.length > 0
          ? { reason: alarms.join(','), message: `RabbitMQ ${alarms.join(' and ')} alarm: publishers are blocked`, details: { alarms: [...alarms] } }
          : null,
        now,
        deps.scans,
      )
    }

    let skew: { nodeId: string; offsetMs: number } | null = null
    if (scan.state === 'running') {
      for (const worker of workers) {
        const offset = worker.nodeId ? (offsets.get(worker.nodeId) ?? 0) : 0
        if (Math.abs(offset) > CLOCK_SKEW_LIMIT_MS && (!skew || Math.abs(offset) > Math.abs(skew.offsetMs))) skew = { nodeId: worker.nodeId!, offsetMs: offset }
      }
    }
    await reconcileCondition(
      scan,
      'clockSkew',
      skew ? { reason: 'nodeClock', message: `node clock is off by ${skew.offsetMs} ms`, details: skew } : null,
      now,
      deps.scans,
    )

    const crashLoop = scan.conditions.find((condition) => condition.type === 'crashLoop')
    if (crashLoop && !workers.some((worker) => worker.state === 'backoff') && now.getTime() - crashLoop.updatedAt.getTime() >= CRASH_LOOP_CLEAR_MS) {
      await clearCondition(scan, 'crashLoop', deps.scans)
    }
    const workerErrors = scan.conditions.find((condition) => condition.type === 'workerErrors')
    if (workerErrors && now.getTime() - workerErrors.updatedAt.getTime() >= WORKER_ERRORS_CLEAR_MS) {
      await clearCondition(scan, 'workerErrors', deps.scans)
    }
  }
}
