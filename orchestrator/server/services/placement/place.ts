import type { PendingReason } from '#shared/utils/enums'
import { cost, isActive, NodeView, reservedProcesses } from './node-view'
import type { PlacementNode, PlacementPlan, PlacementScan, PlacementSnapshot, PlacementWorker } from './types'

/*
 * Phase 2 of placement (docs/nodes.md §12.2–§12.6): place pending workers on nodes with hard filters in a fixed
 * order and a stable spread score, record why unplaceable workers stay pending, and resize the process limits of
 * placed runners. Pure and deterministic: the same snapshot gives the same plan.
 *
 * Interpretation of §12.6: the node view already reserves max(desired, assigned) processes for every placed worker,
 * so a scale-up fits when the node's usage without the worker's own reservation plus cost(p) stays within capacity.
 */

interface Filter {
  reason: PendingReason
  accepts: (node: PlacementNode, worker: PlacementWorker, scan: PlacementScan, view: NodeView, snapshot: PlacementSnapshot) => boolean
}

const FILTERS: readonly Filter[] = [
  { reason: 'noNodes', accepts: (node) => node.state === 'online' && !node.cordoned && node.hasToken && node.info !== null },
  { reason: 'archMismatch', accepts: (node, _worker, scan) => node.info!.os === scan.revision.platform.os && node.info!.arch === scan.revision.platform.arch },
  {
    reason: 'selectorMismatch',
    accepts: (node, _worker, scan) =>
      node.pool === scan.settings.nodeSelector.pool &&
      Object.entries(scan.settings.nodeSelector.labels).every(([key, value]) => node.labels[key] === value),
  },
  { reason: 'dindUnavailable', accepts: (node, worker) => !worker.privileged || node.info!.dindMode !== 'disabled' },
  { reason: 'diskLow', accepts: (node, _worker, _scan, _view, snapshot) => node.info!.diskFreeBytes >= snapshot.minFreeDiskBytes },
  { reason: 'insufficientCapacity', accepts: (node, worker, _scan, view) => view.fits(node.id, worker.resources, worker.processes.desired, true) },
  {
    reason: 'pullLimit',
    accepts: (node, worker, _scan, view, snapshot) => view.has(node.id, worker.digest) || view.pullsInFlight(worker.digest) < snapshot.maxConcurrentPulls,
  },
]

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** docs/nodes.md §12.4: the scheduler prefers the built-in node; otherwise argmin(score, same-scan workers, node id). */
export function chooseNode(candidates: readonly PlacementNode[], worker: PlacementWorker, view: NodeView): PlacementNode {
  if (worker.role === 'scheduler') {
    const builtIn = candidates.find((node) => node.builtIn)
    if (builtIn) return builtIn
  }
  let best: PlacementNode | null = null
  let bestKey: [number, number, string] | null = null
  for (const node of candidates) {
    const key: [number, number, string] = [view.score(node.id, worker.resources, worker.processes.desired), view.sameScanCount(node.id, worker.scanId), node.id]
    if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && compareIds(key[2], bestKey[2]) < 0)))) {
      best = node
      bestKey = key
    }
  }
  return best!
}

/** Pending workers in placement order: schedulers first, then by scan start, worker creation and id. */
export function placementOrder(workers: readonly PlacementWorker[], scans: ReadonlyMap<string, PlacementScan>): PlacementWorker[] {
  const startOf = (worker: PlacementWorker) => {
    const scan = scans.get(worker.scanId)
    return (scan?.startedAt ?? scan?.createdAt ?? worker.createdAt).getTime()
  }
  return [...workers].sort(
    (a, b) =>
      (a.role === 'scheduler' ? 0 : 1) - (b.role === 'scheduler' ? 0 : 1) ||
      startOf(a) - startOf(b) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      compareIds(a.id, b.id),
  )
}

export function planPlacement(snapshot: PlacementSnapshot): PlacementPlan {
  const plan: PlacementPlan = { placements: [], pending: [], resizes: [], conditions: {}, touchedNodes: [] }
  const scans = new Map(snapshot.scans.map((scan) => [scan.id, scan]))
  const view = new NodeView(snapshot.nodes, snapshot.workers)
  const nodes = [...snapshot.nodes].sort((a, b) => compareIds(a.id, b.id))
  const touched = new Set<string>()
  const pendingByScan = new Map<string, Partial<Record<PendingReason, number>>>()
  const notePending = (scanId: string, reason: PendingReason) => {
    const reasons = pendingByScan.get(scanId) ?? {}
    reasons[reason] = (reasons[reason] ?? 0) + 1
    pendingByScan.set(scanId, reasons)
  }

  const activeByUser = new Map<string, number>()
  for (const worker of snapshot.workers) {
    if (isActive(worker)) activeByUser.set(worker.userId, (activeByUser.get(worker.userId) ?? 0) + 1)
  }

  const pendingWorkers = snapshot.workers.filter((worker) => worker.state === 'pending' && scans.get(worker.scanId)?.state === 'running')
  for (const worker of placementOrder(pendingWorkers, scans)) {
    const scan = scans.get(worker.scanId)!
    let reason: PendingReason | null = null
    const limit = snapshot.userMaxWorkers[worker.userId] ?? 0
    if (limit > 0 && (activeByUser.get(worker.userId) ?? 0) >= limit) reason = 'userMaxWorkers'
    let candidates = nodes
    for (const filter of reason ? [] : FILTERS) {
      const next = candidates.filter((node) => filter.accepts(node, worker, scan, view, snapshot))
      if (next.length === 0) {
        reason = filter.reason
        break
      }
      candidates = next
    }
    if (reason) {
      notePending(worker.scanId, reason)
      if (worker.reason !== reason) plan.pending.push({ workerId: worker.id, scanId: worker.scanId, reason, previous: worker.reason })
      continue
    }
    const node = chooseNode(candidates, worker, view)
    plan.placements.push({
      workerId: worker.id,
      scanId: worker.scanId,
      nodeId: node.id,
      dindMode: worker.privileged ? (node.info!.dindMode === 'disabled' ? null : node.info!.dindMode) : null,
      assigned: worker.processes.desired,
    })
    touched.add(node.id)
    view.reserve(node.id, worker, worker.processes.desired)
    activeByUser.set(worker.userId, (activeByUser.get(worker.userId) ?? 0) + 1)
  }

  // Live resize of runner processes (docs/nodes.md §12.6), in id order so the result never depends on input order.
  for (const worker of [...snapshot.workers].sort((a, b) => compareIds(a.id, b.id))) {
    const scan = scans.get(worker.scanId)
    if (!scan || scan.state !== 'running' || worker.role !== 'runner' || worker.nodeId === null || !isActive(worker) || worker.state === 'draining') continue
    const { desired, assigned } = worker.processes
    if (desired === assigned) continue
    if (desired > assigned) {
      const own = cost(worker.resources, reservedProcesses(worker))
      let fit = assigned
      for (let processes = desired; processes > assigned; processes--) {
        if (view.fits(worker.nodeId, worker.resources, processes, false, own)) {
          fit = processes
          break
        }
      }
      if (fit > assigned) {
        plan.resizes.push({ workerId: worker.id, nodeId: worker.nodeId, assigned: fit })
        touched.add(worker.nodeId)
        view.resize(worker.nodeId, worker.resources, reservedProcesses(worker), Math.max(fit, desired))
      }
      if (fit < desired) notePending(worker.scanId, 'insufficientCapacity')
    } else if ((worker.processes.running ?? 0) <= desired) {
      plan.resizes.push({ workerId: worker.id, nodeId: worker.nodeId, assigned: desired })
      touched.add(worker.nodeId)
      view.resize(worker.nodeId, worker.resources, reservedProcesses(worker), desired)
    }
  }

  for (const scan of snapshot.scans) {
    const reasons = pendingByScan.get(scan.id)
    plan.conditions[scan.id] =
      scan.state === 'running' && reasons ? { count: Object.values(reasons).reduce((sum, n) => sum + (n ?? 0), 0), reasons } : null
  }
  plan.touchedNodes = [...touched].sort()
  return plan
}
