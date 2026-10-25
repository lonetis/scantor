import { useDebounceFn } from '@vueuse/core'

// Per-browser UI preferences in the single localStorage key `scantor-ui` (docs/ui.md §14). Module singleton;
// storage failures (private mode, quota) only lose preferences, never break the UI. Never stored: tokens, keys,
// passwords, writeOnly values, results.

const WRITE_DELAY_MS = 500

const prefs = shallowRef<UiPrefs>(emptyUiPrefs())
let initialized = false

function readStorage(): UiPrefs {
  try {
    const raw = window.localStorage.getItem(UI_PREFS_STORAGE_KEY)
    return raw ? sanitizeUiPrefs(JSON.parse(raw)) : emptyUiPrefs()
  } catch (error) {
    console.warn('[ui-prefs] stored preferences are unreadable and were reset', error)
    return emptyUiPrefs()
  }
}

function writeStorage(): void {
  try {
    window.localStorage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(prefs.value))
  } catch (error) {
    console.warn('[ui-prefs] preferences could not be saved', error)
  }
}

const scheduleWrite = useDebounceFn(writeStorage, WRITE_DELAY_MS)

function update(mutator: (current: UiPrefs) => UiPrefs): void {
  prefs.value = mutator(prefs.value)
  void scheduleWrite()
}

export function useUiPrefs() {
  if (!initialized && import.meta.client) {
    initialized = true
    prefs.value = readStorage()
    window.addEventListener('beforeunload', writeStorage)
  }

  return {
    prefs: readonly(prefs),

    getFilters: <T extends Record<string, unknown>>(page: string): Partial<T> => (prefs.value.filters[page] ?? {}) as Partial<T>,
    setFilters: (page: string, value: Record<string, unknown>) =>
      update((current) => ({ ...current, filters: { ...current.filters, [page]: value } })),

    getResultColumns: (taskId: string): string[] | null => prefs.value.resultColumns[taskId]?.value ?? null,
    setResultColumns: (taskId: string, columns: string[]) =>
      update((current) => ({ ...current, resultColumns: touchLru(current.resultColumns, taskId, columns, UI_PREFS_LIMITS.resultColumnTasks) })),

    getQueries: (scanId: string): unknown[] => prefs.value.queries[scanId]?.value ?? [],
    /** Prepends a query (most recent first), deduplicated, at most 20 per scan. */
    pushQuery: (scanId: string, query: unknown) =>
      update((current) => {
        const serialized = JSON.stringify(query)
        const previous = (current.queries[scanId]?.value ?? []).filter((entry) => JSON.stringify(entry) !== serialized)
        const next = [query, ...previous].slice(0, UI_PREFS_LIMITS.queriesPerScan)
        return { ...current, queries: touchLru(current.queries, scanId, next, UI_PREFS_LIMITS.queryScans) }
      }),

    getTestRunDraft: (taskId: string): Record<string, unknown> | null => prefs.value.testRunDrafts[taskId]?.value ?? null,
    /** Stores test-run inputs; the values at `secretPointers` (writeOnly fields) are removed first. */
    setTestRunDraft: (taskId: string, draft: Record<string, unknown>, secretPointers: readonly string[]) =>
      update((current) => ({
        ...current,
        testRunDrafts: touchLru(current.testRunDrafts, taskId, stripPaths(draft, secretPointers) as Record<string, unknown>, UI_PREFS_LIMITS.testRunDraftTasks),
      })),
  }
}
