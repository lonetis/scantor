import { computed, ref, shallowRef, type Ref } from 'vue'

// "Load more" over cursor-paginated lists (docs/api.md §1.8, docs/ui.md §7). Filter changes call reset();
// an epoch guard drops responses that belong to an older filter. `loading` covers reset() and loadMore();
// `refreshing` covers refresh(), which polls and "Refresh" buttons use. A refresh re-reads the pages that were
// loaded when it started, so it is dropped when a "Load more" page arrived meanwhile: swapping it in would remove
// that page (the next poll re-reads all of them).

export interface CursorPage<T> {
  items: T[]
  nextCursor?: string | null
}

export interface CursorListOptions {
  /** Load the first page right away (default true). */
  immediate?: boolean
  /** Keep at most this many items in memory; loading stops there. */
  maxItems?: number
  /** At most this many pages are re-read by refresh() (default 5). */
  maxRefreshPages?: number
}

export function useCursorList<T>(fetchPage: (cursor: string | null) => Promise<CursorPage<T>>, options: CursorListOptions = {}) {
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
      const page = await fetchPage(cursor)
      if (started !== epoch) return
      const merged = mode === 'append' ? [...items.value, ...page.items] : page.items
      items.value = options.maxItems === undefined ? merged : merged.slice(0, options.maxItems)
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

  /** Re-reads the loaded pages (bounded) and swaps them in atomically; used by polls and "Refresh". */
  async function refresh(): Promise<void> {
    const started = epoch
    const appendedBefore = appended
    const pageCount = Math.max(1, Math.min(pages.value, options.maxRefreshPages ?? 5))
    const collected: T[] = []
    let cursor: string | null = null
    refreshesInFlight.value++
    try {
      for (let page = 0; page < pageCount; page++) {
        const result = await fetchPage(cursor)
        if (started !== epoch || appended !== appendedBefore) return
        collected.push(...result.items)
        cursor = result.nextCursor ?? null
        if (cursor === null) break
      }
    } finally {
      refreshesInFlight.value--
    }
    items.value = options.maxItems === undefined ? collected : collected.slice(0, options.maxItems)
    nextCursor.value = cursor
    pages.value = pageCount
    error.value = null
    loaded.value = true
  }

  if (options.immediate !== false) {
    reset().catch((cause: unknown) => console.error('[list] loading the first page failed', cause))
  }

  return { items, nextCursor, hasMore, limitReached, loading, refreshing, loaded, error, reset, loadMore, refresh }
}
