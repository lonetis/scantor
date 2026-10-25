import { computed, ref, shallowRef, type Ref } from 'vue'

// "Load more" over cursor-paginated lists (docs/api.md §1.8, docs/ui.md §7). Filter changes call reset();
// an epoch guard drops responses that belong to an older filter. `loading` covers reset() and loadMore();
// `refreshing` covers refresh(), which polls and "Refresh" buttons use. A refresh re-reads the pages that were
// loaded when it started, so it is dropped when a "Load more" page arrived meanwhile: swapping it in would remove
// that page (the next poll re-reads all of them). A refresh re-reads at most `maxRefreshPages` pages; the items
// loaded beyond them stay (with their last loaded values) behind the re-read ones, and so does the cursor.

export interface CursorPage<T> {
  items: T[]
  nextCursor?: string | null
}

/** How a page is requested: `background` is set for the re-reads of polls, which must never toast (docs/ui.md §8). */
export interface PageRequest {
  background: boolean
}

export interface CursorListOptions<T> {
  /** Load the first page right away (default true). */
  immediate?: boolean
  /** Keep at most this many items in memory; loading stops there. */
  maxItems?: number
  /** At most this many pages are re-read by refresh() (default 5). */
  maxRefreshPages?: number
  /** The identity of an item, to join a bounded refresh with the items loaded beyond it (default: its `id`, else the item). */
  key?: (item: T) => unknown
}

function defaultKey(item: unknown): unknown {
  return typeof item === 'object' && item !== null && 'id' in item ? (item as { id: unknown }).id : item
}

export function useCursorList<T>(
  fetchPage: (cursor: string | null, request: PageRequest) => Promise<CursorPage<T>>,
  options: CursorListOptions<T> = {},
) {
  const key = options.key ?? defaultKey
  const items = shallowRef<T[]>([]) as Ref<T[]>
  const nextCursor = ref<string | null>(null)
  const loading = ref(false)
  const loaded = ref(false)
  const error = shallowRef<unknown>(null)
  const pages = ref(0)
  // A counter, so overlapping refreshes (a poll tick and a click) keep `refreshing` until the last one ends.
  const refreshesInFlight = ref(0)
  const refreshing = computed(() => refreshesInFlight.value > 0)
  let epoch = 0
  /** Pages appended by loadMore(); a refresh that saw fewer is stale. */
  let appended = 0

  const limitReached = computed(() => options.maxItems !== undefined && items.value.length >= options.maxItems)
  const hasMore = computed(() => nextCursor.value !== null && !limitReached.value)

  async function load(cursor: string | null, mode: 'replace' | 'append'): Promise<void> {
    const started = epoch
    loading.value = true
    try {
      const page = await fetchPage(cursor, { background: false })
      if (started !== epoch) return
      items.value = cap(mode === 'append' ? [...items.value, ...page.items] : page.items)
      nextCursor.value = page.nextCursor ?? null
      pages.value = mode === 'append' ? pages.value + 1 : 1
      if (mode === 'append') appended++
      error.value = null
      loaded.value = true
    } catch (cause) {
      if (started === epoch) error.value = cause
      throw cause
    } finally {
      if (started === epoch) loading.value = false
    }
  }

  /** Drops everything and loads the first page (after a filter change). */
  async function reset(): Promise<void> {
    epoch++
    items.value = []
    nextCursor.value = null
    pages.value = 0
    loaded.value = false
    await load(null, 'replace')
  }

  async function loadMore(): Promise<void> {
    if (loading.value || !hasMore.value) return
    await load(nextCursor.value, 'append')
  }

  /**
   * Re-reads the loaded pages (at most `maxRefreshPages`) and swaps them in atomically; used by polls and "Refresh".
   * When more pages are loaded than it re-reads, the items after the last re-read one stay, and so do the cursor and
   * the page count, so a poll never truncates what the user scrolled through. Polls pass `background: true`.
   */
  async function refresh({ background = false }: { background?: boolean } = {}): Promise<void> {
    const request: PageRequest = { background }
    const started = epoch
    const appendedBefore = appended
    const loadedPages = pages.value
    const pageCount = Math.max(1, Math.min(loadedPages, options.maxRefreshPages ?? 5))
    const collected: T[] = []
    let cursor: string | null = null
    refreshesInFlight.value++
    try {
      for (let page = 0; page < pageCount; page++) {
        const result = await fetchPage(cursor, request)
        if (started !== epoch || appended !== appendedBefore) return
        collected.push(...result.items)
        cursor = result.nextCursor ?? null
        if (cursor === null) break
      }
    } finally {
      refreshesInFlight.value--
    }
    if (cursor !== null && loadedPages > pageCount) {
      items.value = cap([...collected, ...tailAfter(items.value, collected)])
    } else {
      items.value = cap(collected)
      nextCursor.value = cursor
      pages.value = pageCount
    }
    error.value = null
    loaded.value = true
  }

  /** The loaded items after the last re-read one (or after as many items as were re-read), without the re-read ones. */
  function tailAfter(current: readonly T[], reread: readonly T[]): T[] {
    const seen = new Set(reread.map(key))
    const last = reread.at(-1)
    const boundary = last === undefined ? -1 : current.findIndex((item) => key(item) === key(last))
    const tail = boundary >= 0 ? current.slice(boundary + 1) : current.slice(reread.length)
    return tail.filter((item) => !seen.has(key(item)))
  }

  function cap(list: T[]): T[] {
    return options.maxItems === undefined ? list : list.slice(0, options.maxItems)
  }

  if (options.immediate !== false) {
    reset().catch((cause: unknown) => console.error('[list] loading the first page failed', cause))
  }

  return { items, nextCursor, hasMore, limitReached, loading, refreshing, loaded, error, reset, loadMore, refresh }
}
