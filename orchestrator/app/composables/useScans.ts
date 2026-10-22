import type { MaybeRefOrGetter } from 'vue'

// The scans list (docs/ui.md §5.11): listScans with cursor paging ("Load more") and a 10 s poll of the loaded
// pages while the page is visible. A filter change reloads from the first page.

const SCANS_POLL_MS = 10_000

export interface ScanListFilters {
  /** scan states; empty = every state except deleting/deleted (the server default) */
  state: readonly ScanState[]
  /** task id */
  task: string | null
  /** admins: restrict to this owner */
  userId: string | null
}

export function useScans(filters: MaybeRefOrGetter<ScanListFilters>) {
  const api = useApi()
  let background = false

  const list = useCursorList<ScanSummary>(
    (cursor) => {
      const current = toValue(filters)
      return api<Page<ScanSummary>>('/api/scans', {
        query: apiQuery({ state: current.state, task: current.task, userId: current.userId, cursor, limit: 50 }),
        background,
        toast: !background,
      })
    },
    { immediate: false },
  )

  watch(() => JSON.stringify(toValue(filters)), () => {
    list.reset().catch((error: unknown) => console.error('[scans] loading the scans failed', error))
  }, { immediate: true })

  const poll = usePoll(async () => {
    background = true
    try {
      await list.refresh()
    } finally {
      background = false
    }
  }, { intervalMs: SCANS_POLL_MS, immediate: false })

  return { ...list, polling: poll.running, refresh: poll.refresh }
}
