import type { WorkerRole, WorkerState } from '#shared/utils/enums'
import { NodeView } from './node-view'
import type { DesiredPlan, PlacementScan, PlacementSnapshot, PlacementWorker } from './types'

// Phase 1 of placement (docs/nodes.md §12.1): reconcile the worker count per (scan, role) with the desired set.
// Running scans want one scheduler while scheduling is pending or running, plus `settings.workers` runners; every
// other scan state (and a scan that no longer exists) wants none. Workers in pending … backoff count; draining,
// stopped and lost ones do not. Missing workers are inserted `pending` (by the applier, which also increments the
// scheduler epoch); surplus workers are picked as victims: pending ones stop, placed ones drain.

const COUNTED = new Set<WorkerState>(['pending', 'assigned', 'pulling', 'starting', 'running', 'backoff'])

export function wantedWorkers(scan: PlacementScan | undefined): Record<WorkerRole, number> {
  if (!scan || scan.state !== 'running') return { scheduler: 0, runner: 0 }
  return {
    scheduler: scan.schedulingState === 'pending' || scan.schedulingState === 'running' ? 1 : 0,
    runner: scan.settings.workers,
  }
}

function drainReason(scan: PlacementScan | undefined, role: WorkerRole): string {
  if (!scan) return 'scan deleted'
  switch (scan.state) {
    case 'running':
      return role === 'scheduler' ? 'scheduling finished' : 'scaled in'
    case 'paused':
      return 'scan paused'
    case 'cancelled':
      return 'scan cancelled'
    case 'completed':
    case 'failed':
      return `scan ${scan.state}`
    default:
      return `scan ${scan.state}`
  }
}

/**
 * Victim order for scale-in (docs/nodes.md §12.5): pending first, then the least busy (in-memory busy[] of state
 * polls), then workers on the most loaded node, then the newest.
 */
export function orderVictims(workers: readonly PlacementWorker[], busy: Readonly<Record<string, number>>, view: NodeView): PlacementWorker[] {
  return [...workers].sort((a, b) => {
    const pendingA = a.state === 'pending' ? 0 : 1
    const pendingB = b.state === 'pending' ? 0 : 1
    if (pendingA !== pendingB) return pendingA - pendingB
    const busyDiff = (busy[a.id] ?? 0) - (busy[b.id] ?? 0)
    if (busyDiff !== 0) return busyDiff
    const loadDiff = (b.nodeId ? view.load(b.nodeId) : 0) - (a.nodeId ? view.load(a.nodeId) : 0)
    if (loadDiff !== 0) return loadDiff
    const ageDiff = b.createdAt.getTime() - a.createdAt.getTime()
    if (ageDiff !== 0) return ageDiff
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
  })
}

/** Desired processes of a worker: the scan's settings for runners, always 1 for the scheduler. */
export function desiredProcesses(scan: PlacementScan, role: WorkerRole): number {
  return role === 'scheduler' ? 1 : scan.settings.processes
}

export function planDesiredWorkers(snapshot: PlacementSnapshot): DesiredPlan {
  const plan: DesiredPlan = { inserts: [], stops: [], drains: [], desiredUpdates: [] }
  const scans = new Map(snapshot.scans.map((scan) => [scan.id, scan]))
  const view = new NodeView(snapshot.nodes, snapshot.workers)
  const groups = new Map<string, PlacementWorker[]>()
  for (const worker of snapshot.workers) {
    if (!COUNTED.has(worker.state)) continue
    const key = `${worker.scanId}\n${worker.role}`
    groups.set(key, [...(groups.get(key) ?? []), worker])
  }
  const scanIds = new Set([...scans.keys(), ...snapshot.workers.map((worker) => worker.scanId)])
  for (const scanId of [...scanIds].sort()) {
    const scan = scans.get(scanId)
    const wanted = wantedWorkers(scan)
    for (const role of ['scheduler', 'runner'] as const) {
      const current = groups.get(`${scanId}\n${role}`) ?? []
      const want = wanted[role]
      const victims = new Set<string>()
      if (current.length < want) {
        plan.inserts.push({ scanId, role, count: want - current.length })
      } else if (current.length > want) {
        for (const victim of orderVictims(current, snapshot.busy, view).slice(0, current.length - want)) {
          victims.add(victim.id)
          if (victim.state === 'pending' || victim.nodeId === null) plan.stops.push({ workerId: victim.id, scanId })
          else plan.drains.push({ workerId: victim.id, scanId, nodeId: victim.nodeId, reason: drainReason(scan, role) })
        }
      }
      if (!scan) continue
      const desired = desiredProcesses(scan, role)
      for (const worker of current) {
        if (!victims.has(worker.id) && worker.processes.desired !== desired) plan.desiredUpdates.push({ workerId: worker.id, desired })
      }
    }
  }
  return plan
}
