import type { MaybeRefOrGetter } from 'vue'

// Workers of a scan (docs/ui.md §5.13.5): listScanWorkers with a state filter, "Load more", and a 5 s poll while
// the workers tab is visible and the scan is not terminal.

const WORKERS_POLL_MS = 5000

export function useWorkers(scanId: MaybeRefOrGetter<string>, options: { state: MaybeRefOrGetter<readonly WorkerState[]>, enabled: MaybeRefOrGetter<boolean> }) {
  const api = useApi()
  let background = false

  const list = useCursorList<ScanWorker>(
    (cursor) =>
      api<Page<ScanWorker>>(`/api/scans/${encodeURIComponent(toValue(scanId))}/workers`, {
        query: apiQuery({ state: toValue(options.state), cursor, limit: 50 }),
        background,
        toast: !background,
      }),
    { immediate: false },
  )

  watch([() => toValue(scanId), () => toValue(options.state).join(','), () => toValue(options.enabled)], ([, , enabled], previous) => {
    const filterChanged = !previous || previous[0] !== toValue(scanId) || previous[1] !== toValue(options.state).join(',')
    if (enabled && (filterChanged || !list.loaded.value)) list.reset().catch((error: unknown) => console.error('[workers] loading failed', error))
  }, { immediate: true })

  const poll = usePoll(async () => {
    background = true
    try {
      await list.refresh()
    } finally {
      background = false
    }
  }, { intervalMs: WORKERS_POLL_MS, enabled: () => toValue(options.enabled) && list.loaded.value, immediate: false })

  return { ...list, polling: poll.running, refresh: poll.refresh }
}
