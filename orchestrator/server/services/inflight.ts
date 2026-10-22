// In-memory in-flight analyses (docs/api.md §4.13 listInflightAnalyses, §8.2): every runtime state poll replaces
// its worker's `busy[]`; nothing is written to MongoDB. Entries older than INFLIGHT_STALE_MS (a worker that stopped
// polling) are ignored on read and pruned. Placement reads busy counts to pick the least busy runners on scale-in.

/** One busy slot as reported by `POST /api/runtime/state`. */
export interface BusyItem {
  seq: number
  round: number
  attempt: number
  executionId: string
  startedAt: string
  progress: unknown
}

/** One row of `listInflightAnalyses`. */
export interface InflightItem {
  analysisId: string
  seq: number
  round: number
  attempt: number
  startedAt: string
  workerId: string
  nodeId: string
  progress: unknown
}

export interface WorkerBusyInput {
  workerId: string
  scanId: string
  nodeId: string
  busy: BusyItem[]
  at: Date
}

/** Three missed state polls (5 s each): the worker's last report no longer describes reality. */
export const INFLIGHT_STALE_MS = 20_000

interface WorkerEntry {
  scanId: string
  nodeId: string
  busy: BusyItem[]
  at: Date
}

export class InflightStore {
  private readonly byWorker = new Map<string, WorkerEntry>()
  private readonly byScan = new Map<string, Set<string>>()

  constructor(private readonly staleMs = INFLIGHT_STALE_MS) {}

  record(input: WorkerBusyInput): void {
    const previous = this.byWorker.get(input.workerId)
    if (previous && previous.scanId !== input.scanId) this.byScan.get(previous.scanId)?.delete(input.workerId)
    this.byWorker.set(input.workerId, { scanId: input.scanId, nodeId: input.nodeId, busy: input.busy, at: input.at })
    let workers = this.byScan.get(input.scanId)
    if (!workers) {
      workers = new Set()
      this.byScan.set(input.scanId, workers)
    }
    workers.add(input.workerId)
  }

  forget(workerId: string): void {
    const entry = this.byWorker.get(workerId)
    if (!entry) return
    this.byWorker.delete(workerId)
    const workers = this.byScan.get(entry.scanId)
    workers?.delete(workerId)
    if (workers && workers.size === 0) this.byScan.delete(entry.scanId)
  }

  /** In-flight analyses of a scan, sorted by start time; `updatedAt` is the newest report (ISO) or null. */
  scan(scanId: string, now = Date.now()): { items: InflightItem[]; updatedAt: string | null } {
    const workers = this.byScan.get(scanId)
    if (!workers) return { items: [], updatedAt: null }
    const items: InflightItem[] = []
    let newest: Date | null = null
    for (const workerId of [...workers]) {
      const entry = this.byWorker.get(workerId)
      if (!entry || now - entry.at.getTime() > this.staleMs) {
        this.forget(workerId)
        continue
      }
      if (!newest || entry.at > newest) newest = entry.at
      for (const busy of entry.busy) {
        items.push({
          analysisId: `${scanId}-${busy.seq}`,
          seq: busy.seq,
          round: busy.round,
          attempt: busy.attempt,
          startedAt: busy.startedAt,
          workerId,
          nodeId: entry.nodeId,
          progress: busy.progress ?? null,
        })
      }
    }
    items.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.seq - b.seq)
    return { items, updatedAt: newest ? newest.toISOString() : null }
  }

  /** Busy slots of a worker per its latest fresh report (0 when unknown or stale). */
  busyCount(workerId: string, now = Date.now()): number {
    const entry = this.byWorker.get(workerId)
    if (!entry || now - entry.at.getTime() > this.staleMs) return 0
    return entry.busy.length
  }

  clear(): void {
    this.byWorker.clear()
    this.byScan.clear()
  }
}

const store = new InflightStore()

export function recordWorkerBusy(input: WorkerBusyInput): void {
  store.record(input)
}

export function getScanInflight(scanId: string): { items: InflightItem[]; updatedAt: string | null } {
  return store.scan(scanId)
}

export function forgetWorker(workerId: string): void {
  store.forget(workerId)
}

/** Busy slots of a worker from its latest state poll; placement uses it to drain the least busy runners first. */
export function getWorkerBusyCount(workerId: string): number {
  return store.busyCount(workerId)
}
