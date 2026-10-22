import { ACTIVE_WORKER_STATES, type WorkerState } from '#shared/utils/enums'
import { CONTAINER_OVERHEAD_BYTES, MIB, type PlacementNode, type PlacementWorker } from './types'

// The node view of docs/nodes.md §12.2: capacity, reserved usage and which images a node already has. Usage is
// reservation-based (declared per-process resources), never measured.

const ACTIVE = new Set<WorkerState>(ACTIVE_WORKER_STATES)
/** States in which a node has the worker's image locally (docs/nodes.md §12.2 `has`). */
const HAS_IMAGE = new Set<WorkerState>(['starting', 'running', 'backoff', 'draining'])

export interface Usage {
  slots: number
  cpu: number
  mem: number
}

export interface Capacity {
  slots: number
  cpu: number
  mem: number
}

export function isActive(worker: Pick<PlacementWorker, 'state'>): boolean {
  return ACTIVE.has(worker.state)
}

/** CPU and memory a worker with `processes` connector processes reserves. */
export function cost(resources: { cpus: number; memoryMiB: number }, processes: number): { cpu: number; mem: number } {
  return { cpu: processes * resources.cpus, mem: processes * resources.memoryMiB * MIB + CONTAINER_OVERHEAD_BYTES }
}

/** The processes a placed worker reserves: the higher of desired and assigned while a resize is in flight. */
export function reservedProcesses(worker: Pick<PlacementWorker, 'processes'>): number {
  return Math.max(worker.processes.desired, worker.processes.assigned)
}

export function capacityOf(node: PlacementNode): Capacity | null {
  if (!node.info) return null
  return {
    slots: Math.min(node.info.maxWorkers, node.maxWorkers ?? Number.POSITIVE_INFINITY),
    cpu: node.info.cpus,
    mem: node.info.memoryBytes,
  }
}

/** Mutable bookkeeping of one placement pass. */
export class NodeView {
  readonly usage = new Map<string, Usage>()
  readonly capacity = new Map<string, Capacity>()
  /** digests present per node */
  private readonly images = new Map<string, Set<string>>()
  /** workers per (node, scan) */
  private readonly perScan = new Map<string, number>()
  /** in-flight pulls per digest: assigned/pulling workers on nodes without the image */
  private readonly pulls = new Map<string, number>()

  constructor(nodes: readonly PlacementNode[], workers: readonly PlacementWorker[]) {
    for (const node of nodes) {
      const capacity = capacityOf(node)
      if (capacity) this.capacity.set(node.id, capacity)
      this.usage.set(node.id, { slots: 0, cpu: 0, mem: 0 })
      this.images.set(node.id, new Set())
    }
    // Sorted, so floating-point sums (fractional CPUs) never depend on the input order.
    const placed = workers.filter((worker) => worker.nodeId !== null && isActive(worker)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    for (const worker of placed) {
      if (HAS_IMAGE.has(worker.state)) this.images.get(worker.nodeId!)?.add(worker.digest)
    }
    for (const worker of placed) this.reserve(worker.nodeId!, worker, reservedProcesses(worker), worker.state === 'assigned' || worker.state === 'pulling')
  }

  has(nodeId: string, digest: string): boolean {
    return this.images.get(nodeId)?.has(digest) ?? false
  }

  pullsInFlight(digest: string): number {
    return this.pulls.get(digest) ?? 0
  }

  sameScanCount(nodeId: string, scanId: string): number {
    return this.perScan.get(`${nodeId}\n${scanId}`) ?? 0
  }

  /** Adds a worker's reservation to a node (and counts its pull while the node lacks the image). */
  reserve(nodeId: string, worker: Pick<PlacementWorker, 'scanId' | 'digest' | 'resources'>, processes: number, pulling = true): void {
    const usage = this.usage.get(nodeId)
    if (!usage) return
    const reserved = cost(worker.resources, processes)
    usage.slots += 1
    usage.cpu += reserved.cpu
    usage.mem += reserved.mem
    const key = `${nodeId}\n${worker.scanId}`
    this.perScan.set(key, (this.perScan.get(key) ?? 0) + 1)
    if (pulling && !this.has(nodeId, worker.digest)) this.pulls.set(worker.digest, this.pullsInFlight(worker.digest) + 1)
  }

  /** Changes a placed worker's reservation from `from` to `to` processes (live resize). */
  resize(nodeId: string, resources: { cpus: number; memoryMiB: number }, from: number, to: number): void {
    const usage = this.usage.get(nodeId)
    if (!usage) return
    const before = cost(resources, from)
    const after = cost(resources, to)
    usage.cpu += after.cpu - before.cpu
    usage.mem += after.mem - before.mem
  }

  /** True when adding `processes` of `resources` (and optionally a slot) stays within the node's capacity. */
  fits(nodeId: string, resources: { cpus: number; memoryMiB: number }, processes: number, slot: boolean, minus = { cpu: 0, mem: 0 }): boolean {
    const usage = this.usage.get(nodeId)
    const capacity = this.capacity.get(nodeId)
    if (!usage || !capacity) return false
    const extra = cost(resources, processes)
    return (
      (!slot || usage.slots + 1 <= capacity.slots) &&
      usage.cpu - minus.cpu + extra.cpu <= capacity.cpu + 1e-9 &&
      usage.mem - minus.mem + extra.mem <= capacity.mem
    )
  }

  /** docs/nodes.md §12.4: the most loaded dimension after adding the worker. */
  score(nodeId: string, resources: { cpus: number; memoryMiB: number }, processes: number): number {
    const usage = this.usage.get(nodeId)!
    const capacity = this.capacity.get(nodeId)!
    const extra = cost(resources, processes)
    return Math.max((usage.cpu + extra.cpu) / capacity.cpu, (usage.mem + extra.mem) / capacity.mem, (usage.slots + 1) / capacity.slots)
  }

  /** The current load of a node (victim ordering of scale-in). */
  load(nodeId: string): number {
    const usage = this.usage.get(nodeId)
    const capacity = this.capacity.get(nodeId)
    if (!usage || !capacity) return 0
    return Math.max(usage.cpu / capacity.cpu, usage.mem / capacity.mem, usage.slots / capacity.slots)
  }
}
