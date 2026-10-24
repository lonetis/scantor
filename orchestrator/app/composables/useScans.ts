import type { MaybeRefOrGetter } from 'vue'
import { SCAN_STATES, type ScanState } from '#shared/utils/enums'

// The scans list (docs/ui.md §5.11): listScans with cursor paging ("Load more") and a 10 s poll of the loaded
// pages while the page is visible. A filter change reloads from the first page.

const SCANS_POLL_MS = 10_000

/** The filters of the scans list that the UI prefs remember (docs/ui.md §14). */
export interface StoredScanFilters extends Record<string, unknown> {
  state: ScanState[]
  task: string | null
  onlyMine: boolean
}

type QueryValue = string | null | (string | null)[] | undefined

function firstQueryValue(value: QueryValue): string | null {
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' && first !== '' ? first : null
}

function scanStatesOf(value: unknown): ScanState[] {
  const values = Array.isArray(value) ? value : [value]
  const requested = new Set(values.flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : [])))
  return SCAN_STATES.filter((state) => requested.has(state))
}

/**
 * The filters the scans list opens with: `?task=<taskId>` and `?state=<state,…>` (links such as the taskInUse
 * toast's "Show active scans") take precedence over the remembered filters, which fill in the rest.
 */
export function initialScanFilters(query: { task?: QueryValue; state?: QueryValue }, stored: Partial<StoredScanFilters>): StoredScanFilters {
  const task = firstQueryValue(query.task)
  const states = query.state === undefined ? null : scanStatesOf(query.state)
  return {
    state: states ?? scanStatesOf(stored.state),
    task: task ?? (typeof stored.task === 'string' ? stored.task : null),
    onlyMine: stored.onlyMine === true,
  }
}

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
