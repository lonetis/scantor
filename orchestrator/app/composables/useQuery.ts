import { computed, reactive, ref, shallowRef, toRaw, toValue, type MaybeRefOrGetter } from 'vue'
import { stripEscapes } from '../utils/ansi'

// State of the query console (docs/ui.md §5.13.4): JSON editors for queryAnalyses (filter, projection, sort, limit,
// afterSeq) and aggregateAnalyses (pipeline, limit), "Load more" over `nextCursor`, inline errors with the editor
// that `details.path` points at, and the last 20 inputs per scan in the UI preferences.

export type QueryMode = 'query' | 'aggregate'
export type QueryEditor = 'filter' | 'projection' | 'sort' | 'pipeline'

export interface QueryInputs {
  mode: QueryMode
  filter: string
  projection: string
  sort: string
  limit: number
  afterSeq: number | null
  pipeline: string
  aggregateLimit: number | null
}

/** The body of queryAnalyses. */
export interface QueryBody {
  filter: Record<string, unknown>
  projection?: Record<string, unknown>
  sort?: Record<string, unknown>
  limit: number
  afterSeq?: number
}

export const QUERY_DEFAULT_LIMIT = 20
export const QUERY_MAX_LIMIT = 1000
export const DEFAULT_QUERY_FILTER = '{"status": "failed"}'
export const DEFAULT_PIPELINE = '[{"$group": {"_id": "$error.type", "n": {"$sum": 1}}}]'

export function defaultQueryInputs(): QueryInputs {
  return {
    mode: 'query',
    filter: DEFAULT_QUERY_FILTER,
    projection: '',
    sort: '',
    limit: QUERY_DEFAULT_LIMIT,
    afterSeq: null,
    pipeline: DEFAULT_PIPELINE,
    aggregateLimit: null,
  }
}

/** Parses an editor: empty optional editors are undefined; anything else must be JSON of the expected shape. */
export function parseEditor(text: string, expect: 'object' | 'array', optional: boolean): { value?: unknown, error?: string } {
  if (text.trim() === '') return optional ? {} : { error: `Enter a JSON ${expect}.` }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Invalid JSON.' }
  }
  const isArray = Array.isArray(value)
  const isObject = value !== null && typeof value === 'object' && !isArray
  if (expect === 'array' ? !isArray : !isObject) return { error: `Must be a JSON ${expect}.` }
  return { value }
}

/** The editor an error of the API points at (`details.path` of queryRejected, issue paths of validationFailed). */
export function editorOfPath(path: unknown): QueryEditor | null {
  if (typeof path !== 'string') return null
  const head = path.split('.')[0]
  return head === 'filter' || head === 'projection' || head === 'sort' || head === 'pipeline' ? head : null
}

/** True when every item is a flat object (no nested objects or arrays), so a table can show it. */
export function isFlatItems(items: readonly Record<string, unknown>[]): boolean {
  return items.length > 0 && items.every((item) => Object.values(item).every((value) => value === null || typeof value !== 'object'))
}

/** The text of a query table cell: items are flat, so a cell is a scalar; strings lose escape sequences. */
export function queryCellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? stripEscapes(value) : String(value)
}

/**
 * `data-row-id` of a query result row (docs/ui.md §11 rule 3): the analysis `seq`, else an `id` or a scalar `_id`
 * (aggregate groups), else the row's position.
 */
export function queryRowId(row: Record<string, unknown>, index: number): string | number {
  for (const key of ['seq', 'id', '_id']) {
    const value = row[key]
    if (typeof value === 'number' || (typeof value === 'string' && value !== '')) return value
  }
  return index
}

function isQueryInputs(value: unknown): value is QueryInputs {
  const candidate = value as Partial<QueryInputs> | null
  return typeof candidate === 'object' && candidate !== null
    && (candidate.mode === 'query' || candidate.mode === 'aggregate')
    && typeof candidate.filter === 'string'
    && typeof candidate.pipeline === 'string'
}

export function useQuery(scanId: MaybeRefOrGetter<string>) {
  const analyses = useAnalyses(scanId)
  const prefs = useUiPrefs()

  const inputs = reactive<QueryInputs>(defaultQueryInputs())
  const items = shallowRef<Record<string, unknown>[]>([])
  const nextCursor = ref<string | null>(null)
  const truncated = ref(false)
  const running = ref(false)
  const ranOnce = ref(false)
  const error = shallowRef<ApiError | null>(null)
  /** The mode of the shown output (inputs may have switched since). */
  const resultMode = ref<QueryMode>('query')
  /** The query that produced the shown items: "Load more" continues it, whatever the editors hold now. */
  let shownQuery: QueryBody | null = null
  let generation = 0

  const parsed = computed(() => ({
    filter: parseEditor(inputs.filter, 'object', false),
    projection: parseEditor(inputs.projection, 'object', true),
    sort: parseEditor(inputs.sort, 'object', true),
    pipeline: parseEditor(inputs.pipeline, 'array', false),
  }))

  /** Local JSON errors per editor, for the editors of the current mode. */
  const parseErrors = computed<Partial<Record<QueryEditor, string>>>(() => {
    const editors: QueryEditor[] = inputs.mode === 'query' ? ['filter', 'projection', 'sort'] : ['pipeline']
    return Object.fromEntries(editors.flatMap((editor) => (parsed.value[editor].error ? [[editor, parsed.value[editor].error]] : [])))
  })
  const valid = computed(() => Object.keys(parseErrors.value).length === 0)

  /** The editor the last API error points at. */
  const errorEditor = computed<QueryEditor | null>(() => {
    if (!error.value) return null
    const fromPath = editorOfPath(error.value.details.path)
    if (fromPath) return fromPath
    const issues = errorIssues(error.value)
    return issues.length > 0 ? editorOfPath(issues[0]!.path) : null
  })

  const recent = computed(() => prefs.getQueries(toValue(scanId)).filter(isQueryInputs))

  function queryBody(afterSeq: number | null): QueryBody {
    const body: QueryBody = {
      filter: parsed.value.filter.value as Record<string, unknown>,
      limit: Math.min(Math.max(1, Math.trunc(inputs.limit) || QUERY_DEFAULT_LIMIT), QUERY_MAX_LIMIT),
    }
    if (parsed.value.projection.value) body.projection = parsed.value.projection.value as Record<string, unknown>
    if (parsed.value.sort.value) body.sort = parsed.value.sort.value as Record<string, unknown>
    if (afterSeq !== null) body.afterSeq = afterSeq
    return body
  }

  async function run(): Promise<void> {
    if (!valid.value || running.value) return
    const current = ++generation
    running.value = true
    error.value = null
    try {
      if (inputs.mode === 'query') {
        const body = queryBody(inputs.afterSeq)
        const result = await analyses.query(body)
        if (current !== generation) return
        items.value = result.items
        nextCursor.value = result.nextCursor
        truncated.value = false
        shownQuery = body
      } else {
        const body: { pipeline: Record<string, unknown>[], limit?: number } = { pipeline: parsed.value.pipeline.value as Record<string, unknown>[] }
        if (inputs.aggregateLimit) body.limit = inputs.aggregateLimit
        const result = await analyses.aggregate(body)
        if (current !== generation) return
        items.value = result.items
        nextCursor.value = null
        truncated.value = result.truncated
        shownQuery = null
      }
      resultMode.value = inputs.mode
      ranOnce.value = true
      prefs.pushQuery(toValue(scanId), { ...toRaw(inputs) })
    } catch (cause) {
      if (current === generation) error.value = toApiError(cause)
    } finally {
      if (current === generation) running.value = false
    }
  }

  /** Next page of the shown query (without sort; `nextCursor` is the last seq), even when the editors changed since. */
  async function loadMore(): Promise<void> {
    if (!nextCursor.value || running.value || resultMode.value !== 'query' || !shownQuery) return
    const current = ++generation
    running.value = true
    try {
      const result = await analyses.query({ ...shownQuery, afterSeq: Number(nextCursor.value) })
      if (current !== generation) return
      items.value = [...items.value, ...result.items]
      nextCursor.value = result.nextCursor
    } catch (cause) {
      if (current === generation) error.value = toApiError(cause)
    } finally {
      if (current === generation) running.value = false
    }
  }

  function applyRecent(entry: QueryInputs): void {
    Object.assign(inputs, { ...defaultQueryInputs(), ...entry })
  }

  /** Prefills a query filter (for example "Query similar" from the analysis slideover). */
  function prefillFilter(filter: Record<string, unknown>): void {
    Object.assign(inputs, { mode: 'query', filter: JSON.stringify(filter), projection: '', sort: '', afterSeq: null })
  }

  /** The current query filter, when it parses (for "Export these results"). */
  const currentFilter = computed(() => (parsed.value.filter.error ? null : (parsed.value.filter.value as Record<string, unknown>)))

  return {
    inputs,
    items,
    nextCursor,
    truncated,
    running,
    ranOnce,
    error,
    errorEditor,
    resultMode,
    parseErrors,
    valid,
    recent,
    currentFilter,
    run,
    loadMore,
    applyRecent,
    prefillFilter,
  }
}
