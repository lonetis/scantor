// Shape and sanitising of the single localStorage key `scantor-ui` (docs/ui.md §14). Pure functions; the
// reactive store lives in composables/useUiPrefs.ts.

export const UI_PREFS_STORAGE_KEY = 'scantor-ui'
export const UI_PREFS_VERSION = 1

export const UI_PREFS_LIMITS = {
  resultColumnTasks: 200,
  queryScans: 50,
  queriesPerScan: 20,
  testRunDraftTasks: 50,
} as const

/** An entry of an LRU map: the value plus its last-use time. */
export interface LruEntry<T> {
  at: number
  value: T
}

export interface UiPrefs {
  v: typeof UI_PREFS_VERSION
  resultColumns: Record<string, LruEntry<string[]>>
  queries: Record<string, LruEntry<unknown[]>>
  testRunDrafts: Record<string, LruEntry<Record<string, unknown>>>
  filters: Record<string, Record<string, unknown>>
}

export function emptyUiPrefs(): UiPrefs {
  return { v: UI_PREFS_VERSION, resultColumns: {}, queries: {}, testRunDrafts: {}, filters: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const SAFE_KEY = /^[\w.:@-]{1,200}$/

function safeEntries(value: unknown): [string, unknown][] {
  return isRecord(value) ? Object.entries(value).filter(([key]) => SAFE_KEY.test(key) && key !== '__proto__') : []
}

function sanitizeLru<T>(value: unknown, limit: number, check: (candidate: unknown) => candidate is T): Record<string, LruEntry<T>> {
  const entries = safeEntries(value)
    .filter((pair): pair is [string, LruEntry<T>] => isRecord(pair[1]) && typeof pair[1].at === 'number' && check(pair[1].value))
    .map(([key, entry]) => [key, { at: entry.at, value: entry.value }] as const)
  return Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, limit))
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

/** Parses stored JSON defensively: unknown versions and malformed parts are discarded. */
export function sanitizeUiPrefs(raw: unknown): UiPrefs {
  if (!isRecord(raw) || raw.v !== UI_PREFS_VERSION) return emptyUiPrefs()
  return {
    v: UI_PREFS_VERSION,
    resultColumns: sanitizeLru(raw.resultColumns, UI_PREFS_LIMITS.resultColumnTasks, isStringArray),
    queries: Object.fromEntries(
      Object.entries(sanitizeLru(raw.queries, UI_PREFS_LIMITS.queryScans, isArray)).map(([key, entry]) => [
        key,
        { at: entry.at, value: entry.value.slice(0, UI_PREFS_LIMITS.queriesPerScan) },
      ]),
    ),
    testRunDrafts: sanitizeLru(raw.testRunDrafts, UI_PREFS_LIMITS.testRunDraftTasks, isRecord),
    filters: Object.fromEntries(safeEntries(raw.filters).filter((pair): pair is [string, Record<string, unknown>] => isRecord(pair[1]))),
  }
}

/** Inserts or refreshes an LRU entry and evicts the least recently used entries above `limit`. */
export function touchLru<T>(map: Record<string, LruEntry<T>>, key: string, value: T, limit: number, now = Date.now()): Record<string, LruEntry<T>> {
  const next = { ...map, [key]: { at: now, value } }
  const keys = Object.keys(next)
  if (keys.length <= limit) return next
  const keep = keys.sort((a, b) => next[b]!.at - next[a]!.at).slice(0, limit)
  return Object.fromEntries(keep.map((name) => [name, next[name]!]))
}

/** Removes the values at the given JSON-pointer-like paths (`/a/b`, `*` matches any key or index). */
export function stripPaths(value: unknown, pointers: readonly string[]): unknown {
  let result = cloneJson(value)
  for (const pointer of pointers) {
    if (!pointer.startsWith('/')) continue
    const segments = pointer.slice(1).split('/').map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'))
    result = stripSegments(result, segments)
  }
  return result
}

function cloneJson(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function stripSegments(value: unknown, segments: string[]): unknown {
  if (segments.length === 0 || typeof value !== 'object' || value === null) return value
  const [head, ...rest] = segments as [string, ...string[]]
  if (Array.isArray(value)) {
    if (head === '*') return value.map((item) => (rest.length === 0 ? undefined : stripSegments(item, rest))).filter((item) => item !== undefined)
    const index = Number(head)
    if (!Number.isInteger(index)) return value
    const copy = [...value]
    if (rest.length === 0) copy.splice(index, 1)
    else copy[index] = stripSegments(copy[index], rest)
    return copy
  }
  const record = value as Record<string, unknown>
  const matches = (key: string): boolean => head === '*' || key === head
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => rest.length > 0 || !matches(key))
      .map(([key, child]) => [key, matches(key) ? stripSegments(child, rest) : child]),
  )
}
