import type { Revision } from '#shared/types/revisions'
import type { Scan } from '#shared/types/scans'
import type { ScanState } from '#shared/utils/enums'
import { ApiError, ok, type ApiClient } from './api-client'

// Scan helpers (docs/testing.md §7.8, §9): start, wait for a state with diagnostics, exact counts. Counts always come
// from aggregateAnalyses, never from the `stats` hints (they only increase and may overshoot).

/**
 * Small scan settings for tests that do not test scaling: one runner with one process and a quarter CPU, so parallel
 * scans of all workers fit the built-in node (placement reserves cpus × processes, docs/nodes.md §12).
 */
export const SMALL_SETTINGS = { workers: 1, processes: 1, resources: { cpus: 0.25, memoryMiB: 256 } } as const

export const TERMINAL_STATES: readonly ScanState[] = ['completed', 'failed', 'cancelled']

export interface StartScanBody {
  revision: string
  name?: string
  taskConfig?: Record<string, unknown>
  scanConfig?: Record<string, unknown>
  settings?: Record<string, unknown>
  confirm?: boolean
}

export async function startScan(api: ApiClient, body: StartScanBody): Promise<Scan> {
  return ok(await api.startScan({ settings: SMALL_SETTINGS, ...body }), 'startScan')
}

function describeScan(scan: Scan): string {
  return JSON.stringify({
    state: scan.state,
    stateReason: scan.stateReason,
    conditions: scan.conditions,
    scheduling: scan.scheduling,
    progress: scan.progress,
    workers: scan.workers,
  })
}

/**
 * Long-polls getScan until the scan reaches one of `states`. Throws with the scan's state, reason, conditions and
 * workers when it settles in another terminal state or when the timeout passes.
 */
export async function waitForScanState(api: ApiClient, scanId: string, states: ScanState | readonly ScanState[], timeoutMs = 300_000): Promise<Scan> {
  const wanted: readonly ScanState[] = typeof states === 'string' ? [states] : states
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000)
    // getScan settles on any state other than creating/running; pause and other targets are polled.
    const wait = wanted.some((s) => s === 'creating' || s === 'running') ? 0 : Math.max(1, Math.min(50, remaining))
    const scan = ok(await api.getScan(scanId, wait), 'getScan')
    if (wanted.includes(scan.state)) return scan
    if (TERMINAL_STATES.includes(scan.state) || scan.state === 'deleted') {
      throw new Error(`scan ${scanId} ended ${scan.state} instead of ${wanted.join('|')}: ${describeScan(scan)}`)
    }
    if (Date.now() >= deadline) throw new Error(`scan ${scanId} did not reach ${wanted.join('|')} within ${timeoutMs / 1000} s: ${describeScan(scan)}`)
    if (wait === 0) await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

/** Starts a scan and waits until it completed; returns the final scan. */
export async function startScanAndWait(api: ApiClient, body: StartScanBody, timeoutMs = 300_000): Promise<Scan> {
  const scan = await startScan(api, body)
  return waitForScanState(api, scan.id, 'completed', timeoutMs)
}

/** Exact analysis counts by status (aggregateAnalyses). */
export async function scanCounts(api: ApiClient, scanId: string): Promise<Record<string, number>> {
  const result = ok(await api.aggregateAnalyses(scanId, [{ $group: { _id: '$status', n: { $sum: 1 } } }]), 'aggregateAnalyses')
  const counts: Record<string, number> = {}
  for (const row of result.items as { _id: string; n: number }[]) counts[row._id] = row.n
  return counts
}

/**
 * Cancels a scan unless it is terminal, then deletes it; a scan that is gone counts as deleted. With `waitForJob` it
 * waits for the scanDelete job, so the task is free (no 409 taskInUse) afterwards.
 */
export async function cancelAndDeleteScan(api: ApiClient, scanId: string, options: { waitForJob?: boolean } = {}): Promise<void> {
  const current = await api.getScan(scanId)
  if (current.status === 404) return
  const scan = ok(current, 'getScan')
  if (scan.state === 'deleting' || scan.state === 'deleted') return
  if (!TERMINAL_STATES.includes(scan.state)) {
    const cancelled = await api.cancelScan(scanId)
    if (cancelled.status !== 200 && cancelled.status !== 409) throw new ApiError(`cancelScan ${scanId}`, cancelled)
    await waitForScanState(api, scanId, TERMINAL_STATES, 60_000)
  }
  const deleted = await api.deleteScan(scanId)
  if (deleted.status === 404) return
  if (deleted.status !== 202) throw new ApiError(`deleteScan ${scanId}`, deleted)
  if (options.waitForJob) {
    const job = ok(await api.getJob(deleted.body.job.id, 120), 'getJob')
    if (job.state !== 'succeeded') throw new Error(`the scanDelete job of ${scanId} ended ${job.state}: ${JSON.stringify(job.error)}`)
  }
}

/** The revision reference startScan takes. */
export const revisionRef = (revision: Pick<Revision, 'ref'>) => revision.ref
