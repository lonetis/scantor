import { toValue, watch, type MaybeRefOrGetter } from 'vue'

// Workers of a scan (docs/ui.md §5.13.5): listScanWorkers with a state filter and "Load more" while the workers tab
// is visible (`enabled`). The first load and every filter change read the list from the start; a 5 s poll re-reads
// it while the scan is `live` (not terminal, or its workers are still winding down), and it is read once more when
// that ends, since the last poll may predate the final stop. A finished scan has no poll, so reopening its tab
// re-reads it once.

const WORKERS_POLL_MS = 5000

export interface WorkersOptions {
  state: MaybeRefOrGetter<readonly WorkerState[]>
  /** The workers tab is visible. */
  enabled: MaybeRefOrGetter<boolean>
  /** The scan's workers still change (the scan is not terminal, or its workers have not all stopped): poll. */
  live: MaybeRefOrGetter<boolean>
}

export function useWorkers(scanId: MaybeRefOrGetter<string>, options: WorkersOptions) {
  const api = useApi()

  const list = useCursorList<ScanWorker>(
    (cursor, { background }) =>
      api<Page<ScanWorker>>(`/api/scans/${encodeURIComponent(toValue(scanId))}/workers`, {
        query: apiQuery({ state: toValue(options.state), cursor, limit: 50 }),
        background,
        toast: !background,
      }),
    { immediate: false },
  )

  async function backgroundRefresh(): Promise<void> {
    await list.refresh({ background: true })
  }

  // The scan and the filter the list was last reset for.
  let loadedFor: string | null = null
  const filterKey = () => `${toValue(scanId)} ${toValue(options.state).join(',')}`
  watch([filterKey, () => toValue(options.enabled)], ([key, enabled], previous) => {
    if (!enabled) return
    if (key !== loadedFor || !list.loaded.value) {
      loadedFor = key
      list.reset().catch((error: unknown) => console.error('[workers] loading failed', error))
    } else if (previous !== undefined && !previous[1] && !toValue(options.live)) {
      backgroundRefresh().catch((error: unknown) => console.error('[workers] refreshing failed', error))
    }
  }, { immediate: true })

  watch(() => toValue(options.live), (live, wasLive) => {
    if (wasLive && !live && toValue(options.enabled) && list.loaded.value) {
      backgroundRefresh().catch((error: unknown) => console.error('[workers] refreshing failed', error))
    }
  })

  const poll = usePoll(backgroundRefresh, {
    intervalMs: WORKERS_POLL_MS,
    enabled: () => toValue(options.enabled) && toValue(options.live) && list.loaded.value,
    immediate: false,
  })

  return { ...list, polling: poll.running, refresh: poll.refresh }
}
