import type { MaybeRefOrGetter } from 'vue'

// The event timeline of a scan (docs/ui.md §5.13.6): listScanEvents newest first with a type filter (an exact type
// or a prefix such as "scan." or "worker."), "Load more", and a 10 s poll of the first page while the events tab is
// visible. Once older pages were loaded the poll stops, so it never drops them.

const EVENTS_POLL_MS = 10_000

export function useEvents(scanId: MaybeRefOrGetter<string>, options: { type: MaybeRefOrGetter<string | null>, enabled: MaybeRefOrGetter<boolean> }) {
  const api = useApi()
  let background = false
  const loadedMore = ref(false)

  const list = useCursorList<ScantorEvent>(
    (cursor) =>
      api<Page<ScantorEvent>>(`/api/scans/${encodeURIComponent(toValue(scanId))}/events`, {
        query: apiQuery({ type: toValue(options.type), cursor, limit: 50 }),
        background,
        toast: !background,
      }),
    { immediate: false, maxRefreshPages: 1 },
  )

  watch([() => toValue(scanId), () => toValue(options.type), () => toValue(options.enabled)], ([, , enabled], previous) => {
    const filterChanged = !previous || previous[0] !== toValue(scanId) || previous[1] !== toValue(options.type)
    if (enabled && (filterChanged || !list.loaded.value)) {
      loadedMore.value = false
      list.reset().catch((error: unknown) => console.error('[events] loading failed', error))
    }
  }, { immediate: true })

  const poll = usePoll(async () => {
    background = true
    try {
      await list.refresh()
    } finally {
      background = false
    }
  }, { intervalMs: EVENTS_POLL_MS, enabled: () => toValue(options.enabled) && list.loaded.value && !loadedMore.value, immediate: false })

  async function loadMore(): Promise<void> {
    loadedMore.value = true
    await list.loadMore()
  }

  async function refresh(): Promise<void> {
    loadedMore.value = false
    await list.reset()
  }

  return { ...list, loadMore, refresh, polling: poll.running }
}
