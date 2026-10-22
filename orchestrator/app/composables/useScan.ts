import { useNow } from '@vueuse/core'
import type { MaybeRefOrGetter } from 'vue'

// One scan (docs/ui.md §5.13, §9): getScan polled by state (3 s creating/running, 10 s paused, 15 s for 3 minutes
// after completedAt to pick up the final recount, then stop), and the lifecycle actions with their confirmations
// and toasts (docs/architecture.md §11.3). Action availability comes from scanActions() (shared with the server).

const FAST_POLL_MS = 3000
const PAUSED_POLL_MS = 10_000
const FINAL_POLL_MS = 15_000
const FINAL_WINDOW_MS = 3 * 60_000

export function scanPollInterval(scan: Pick<Scan, 'state' | 'completedAt'> | null, now: number): number | null {
  if (!scan) return null
  if (scan.state === 'creating' || scan.state === 'running') return FAST_POLL_MS
  if (scan.state === 'paused' || scan.state === 'deleting') return PAUSED_POLL_MS
  if (scan.completedAt && now - new Date(scan.completedAt).getTime() < FINAL_WINDOW_MS) return FINAL_POLL_MS
  return null
}

export function useScan(scanId: MaybeRefOrGetter<string>) {
  const api = useApi()
  const scan = shallowRef<Scan | null>(null)
  const error = shallowRef<ApiError | null>(null)
  const loaded = ref(false)
  const now = useNow({ interval: 30_000 })

  async function load(background: boolean): Promise<void> {
    const id = toValue(scanId)
    try {
      const result = await api<Scan>(`/api/scans/${encodeURIComponent(id)}`, { background, toast: !background })
      if (id !== toValue(scanId)) return
      scan.value = result
      error.value = null
    } catch (cause) {
      const apiError = toApiError(cause)
      if (!background) error.value = apiError
      throw apiError
    } finally {
      loaded.value = true
    }
  }

  const interval = computed(() => scanPollInterval(scan.value, now.value.getTime()))
  const poll = usePoll(() => load(true), {
    intervalMs: () => interval.value ?? FAST_POLL_MS,
    enabled: () => interval.value !== null,
    immediate: false,
  })

  watch(() => toValue(scanId), () => {
    scan.value = null
    loaded.value = false
    load(false).catch(() => {})
  }, { immediate: true })

  /** Replaces the scan with a fresher representation (the response of a lifecycle action). */
  function set(next: Scan): void {
    if (next.id === toValue(scanId)) scan.value = next
  }

  return { scan, error, loaded, polling: poll.running, refresh: () => load(false).catch(() => {}), set }
}

/**
 * The subject of scanActions(): a ScanSummary has no scheduling state, so retry-failed (which needs finished
 * scheduling) is never offered for it; the scan detail page has the full scan.
 */
export function scanActionSubject(scan: Scan | ScanSummary): ScanActionSubject {
  return 'scheduling' in scan ? scan : { state: scan.state, scheduling: { state: 'pending' } }
}

export interface ScanActionHandlers {
  /** called with the scan returned by an action */
  onChanged?: (scan: Scan) => void
}

/** Lifecycle actions of one scan with confirmations and toasts; errors are toasted by $api. */
export function useScanActions(scan: MaybeRefOrGetter<Scan | ScanSummary | null>, handlers: ScanActionHandlers = {}) {
  const api = useApi()
  const toast = useToast()
  const { confirm } = useConfirm()
  const busy = ref<ScanAction | null>(null)
  const available = computed(() => {
    const current = toValue(scan)
    return new Set(current ? scanActions(scanActionSubject(current)) : [])
  })

  function label(target: Scan | ScanSummary): string {
    return target.name || shortId(target.id)
  }

  async function run<T>(action: ScanAction, request: () => Promise<T>): Promise<T | null> {
    busy.value = action
    try {
      return await request()
    } catch (cause) {
      if (cause instanceof ApiError) return null
      throw cause
    } finally {
      busy.value = null
    }
  }

  function changed(next: Scan): Scan {
    handlers.onChanged?.(next)
    return next
  }

  async function post(target: Scan | ScanSummary, path: string, body?: Record<string, unknown>): Promise<Scan> {
    return api<Scan>(`/api/scans/${encodeURIComponent(target.id)}/${path}`, { method: 'POST', body })
  }

  async function pause(): Promise<Scan | null> {
    const target = toValue(scan)
    if (!target) return null
    return run('pause', async () => {
      const next = changed(await post(target, 'pause'))
      toast.add({ title: 'Scan paused', description: 'Workers finish their current analyses and stop.', color: 'success', icon: 'i-lucide-circle-pause' })
      return next
    })
  }

  async function resume(): Promise<Scan | null> {
    const target = toValue(scan)
    if (!target) return null
    return run('resume', async () => {
      const next = changed(await post(target, 'resume'))
      toast.add({ title: 'Scan resumed', color: 'success', icon: 'i-lucide-circle-play' })
      return next
    })
  }

  async function scale(values: { workers?: number, processes?: number }): Promise<Scan | null> {
    const target = toValue(scan)
    if (!target) return null
    return run('scale', async () => {
      const next = changed(await post(target, 'scale', values))
      toast.add({ title: 'Scan scaled', description: `${next.settings.workers} workers × ${next.settings.processes} processes`, color: 'success', icon: 'i-lucide-scaling' })
      return next
    })
  }

  async function cancel(): Promise<Scan | null> {
    const target = toValue(scan)
    if (!target) return null
    const confirmed = await confirm({
      title: `Cancel scan ${label(target)}?`,
      description: 'In-flight analyses are aborted; queued ones are dropped. Results already produced are kept.',
      confirmLabel: 'Cancel scan',
      confirmColor: 'error',
    })
    if (!confirmed) return null
    return run('cancel', async () => {
      const next = changed(await post(target, 'cancel'))
      toast.add({ title: 'Scan cancelled', color: 'success', icon: 'i-lucide-circle-stop' })
      return next
    })
  }

  async function retryFailed(): Promise<{ scan: Scan, job: JobRef } | null> {
    const target = toValue(scan)
    if (!target) return null
    const count = target.stats.failed + target.stats.lost
    const round = ('round' in target ? target.round : 1) + 1
    const confirmed = await confirm({
      title: 'Retry failed analyses?',
      description: `Retry up to ${formatCount(count)} failed or lost analyses in round ${round}. Lost analyses without a stored config and cancelled analyses are not retried; restart the scan for those.`,
      confirmLabel: 'Retry failed analyses',
      confirmColor: 'primary',
    })
    if (!confirmed) return null
    return run('retryFailed', async () => {
      const result = await api<{ scan: Scan, job: JobRef }>(`/api/scans/${encodeURIComponent(target.id)}/retry-failed`, { method: 'POST' })
      changed(result.scan)
      toast.add({ title: 'Retrying failed analyses', description: `Round ${result.scan.round} started.`, color: 'success', icon: 'i-lucide-rotate-ccw' })
      return result
    })
  }

  async function restart(values: { name?: string, settings?: { workers?: number, processes?: number } }): Promise<Scan | null> {
    const target = toValue(scan)
    if (!target) return null
    return run('restart', async () => {
      const clone = await api<Scan>(`/api/scans/${encodeURIComponent(target.id)}/restart`, { method: 'POST', body: values })
      toast.add({ title: 'Scan restarted', description: `New scan ${label(clone)}`, color: 'success', icon: 'i-lucide-refresh-cw' })
      await navigateTo(`/scans/${clone.id}`)
      return clone
    })
  }

  async function remove(): Promise<boolean> {
    const target = toValue(scan)
    if (!target) return false
    const typed = target.name || target.id
    const confirmed = await confirm({
      title: `Delete scan ${label(target)}?`,
      description: 'Its analyses, files, exports and events are deleted permanently. Type the scan name (or id) to confirm.',
      confirmLabel: 'Delete scan',
      confirmColor: 'error',
      typeToConfirm: typed,
    })
    if (!confirmed) return false
    const result = await run('delete', async () => {
      await api<{ scan: Scan, job: JobRef }>(`/api/scans/${encodeURIComponent(target.id)}`, { method: 'DELETE' })
      toast.add({ title: 'Scan deletion started', description: 'The scan is removed in the background.', color: 'success', icon: 'i-lucide-trash-2' })
      return true
    })
    return result === true
  }

  return { busy: readonly(busy), available, pause, resume, scale, cancel, retryFailed, restart, remove }
}
