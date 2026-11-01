<script setup lang="ts">
import { useInfiniteScroll } from '@vueuse/core'
import type { TableColumn, TableRow } from '@nuxt/ui'
import type { Page } from '#shared/types/common'
import type { Scan } from '#shared/types/scans'
import type { AnalysisRow, ResultsFilters } from '~/composables/useAnalyses'
import type { PageRequest } from '~/composables/useCursorList'

// The results tab of a scan (docs/ui.md §5.13.2): ResultsFilterBar plus a sticky, virtualized table of projected
// analyses (seq order, 50 per page, "Load more" and infinite scroll, at most 5000 rows in memory). Only the fields of
// the row are loaded (`fields=` projection); the full analysis loads in the AnalysisSlideover, which a row click opens
// through `?analysis=<seq>`. Values come from task code and scanned targets and are rendered as text.
const props = defineProps<{
  scan: Pick<Scan, 'id' | 'state' | 'task' | 'revision'>
}>()

const REFRESH_MS = 10_000

const route = useRoute()
const router = useRouter()
const prefs = useUiPrefs()
const analyses = useAnalyses(() => props.scan.id)

const { data: revision, pending: revisionPending } = useApiFetch<Revision>(
  () => `/api/tasks/${props.scan.task.id}/revisions/${props.scan.revision.id}`,
  { toast: false },
)
const resultSchema = computed(() => revision.value?.description?.schemas.result ?? null)
const properties = computed(() => resultProperties(resultSchema.value))
const fileRefProperties = computed(() => {
  const pointers = revision.value?.description?.fileRefPaths ?? []
  return new Set(pointers.flatMap((pointer) => {
    const segments = parsePointer(pointer)
    return segments.length === 1 ? [segments[0]!] : []
  }))
})

const filters = ref<ResultsFilters>({
  statuses: analysisStatusesOf(route.query.status),
  advanced: null,
  columns: prefs.getResultColumns(props.scan.task.id) ?? [],
  autoRefresh: props.scan.state === 'running',
})
// The status filter and `?status=` stay in sync: ScanStats tiles link to `?tab=results&status=<status>`
// (docs/ui.md §5.13.1), and a filtered view survives tab switches and can be shared. Route changes of other
// pages are ignored: while navigating away, the route already points to the next page.
const pagePath = route.path
watch(() => route.query.status, (value) => {
  if (route.path !== pagePath) return
  const statuses = analysisStatusesOf(value)
  if (statuses.join(',') !== analysisStatusesOf(filters.value.statuses).join(',')) filters.value = { ...filters.value, statuses }
})
watch(() => filters.value.statuses, (statuses) => {
  const status = analysisStatusesOf(statuses).join(',')
  if (route.path !== pagePath || status === analysisStatusesOf(route.query.status).join(',')) return
  router.replace({ query: { ...route.query, status: status || undefined } })
    .catch((error: unknown) => console.error('[results] updating the status query failed', error))
})
/** Start after this seq ("Go to seq"). */
const startAfter = ref<number | null>(null)

// Columns, once the revision's Result schema is known: the user's choice for this task without the properties this
// revision's schema lacks (a later revision may rename or drop them), else the first four properties. Only a choice
// in the filter bar is stored, so the defaults follow each revision's schema. An explicit choice of no columns stays.
watch([properties, () => revision.value !== undefined], ([available, known]) => {
  if (!known) return
  const stored = prefs.getResultColumns(props.scan.task.id)
  const kept = stored?.filter((column) => available.includes(column)) ?? []
  const columns = stored !== null && (kept.length > 0 || stored.length === 0) ? kept : available.slice(0, MAX_RESULT_COLUMNS)
  if (JSON.stringify(columns) !== JSON.stringify(filters.value.columns)) filters.value = { ...filters.value, columns }
}, { immediate: true })

function chooseColumns(columns: string[]): void {
  prefs.setResultColumns(props.scan.task.id, columns)
}

const advancedFilter = computed(() => {
  if (filters.value.advanced === null) return null
  const parsed = parseEditor(filters.value.advanced, 'object', false)
  return parsed.error ? null : (parsed.value as Record<string, unknown>)
})
const loadError = shallowRef<ApiError | null>(null)

async function fetchPage(cursor: string | null, request: PageRequest): Promise<Page<AnalysisRow>> {
  const afterSeq = cursor !== null ? Number(cursor) : startAfter.value
  const fields = resultRowFields(filters.value.columns)
  // Poll re-reads and further pages never toast; a failed first page shows the inline alert and a toast.
  const background = request.background || cursor !== null
  try {
    let page: Page<AnalysisRow>
    if (advancedFilter.value) {
      const projection = Object.fromEntries(fields.filter((field) => field !== 'id').map((field) => [field, 1]))
      const result = await analyses.query({ filter: advancedFilter.value, projection, limit: RESULTS_PAGE_SIZE, ...(afterSeq === null ? {} : { afterSeq }) }, { background })
      page = { items: result.items as AnalysisRow[], nextCursor: result.nextCursor }
    } else {
      page = await analyses.list({ status: filters.value.statuses, afterSeq, limit: RESULTS_PAGE_SIZE, fields }, { background })
    }
    loadError.value = null
    return page
  } catch (cause) {
    loadError.value = toApiError(cause)
    throw cause
  }
}

const list = useCursorList<AnalysisRow>(fetchPage, {
  immediate: false,
  maxItems: RESULTS_MAX_ROWS,
  maxRefreshPages: Math.ceil(RESULTS_REFRESH_ROWS / RESULTS_PAGE_SIZE),
  // An advanced filter's projection may leave out the id; every row has its seq.
  key: (row) => row.seq,
})

function reload(): void {
  list.reset().catch((error: unknown) => console.error('[results] loading analyses failed', error))
}

// The first page waits for the default columns (from the revision) unless columns were saved for this task.
const columnsKnown = computed(() => prefs.getResultColumns(props.scan.task.id) !== null || !revisionPending.value)

watch(
  () => [props.scan.id, JSON.stringify(filters.value.statuses), filters.value.advanced, JSON.stringify(filters.value.columns), startAfter.value, columnsKnown.value],
  () => {
    if (columnsKnown.value) reload()
  },
  { immediate: true },
)

const live = computed(() => props.scan.state === 'running')
usePoll(async () => {
  if (list.loaded.value && !list.loading.value) await list.refresh({ background: true })
}, {
  intervalMs: REFRESH_MS,
  enabled: () => live.value && filters.value.autoRefresh,
  immediate: false,
})

function goToSeq(seq: number): void {
  startAfter.value = seq > 0 ? seq - 1 : null
}

function loadMore(): void {
  list.loadMore().catch((error: unknown) => console.error('[results] loading more analyses failed', error))
}

const table = useTemplateRef('table')
const getRowId = tableRowId((row: AnalysisRow) => row.seq)
useTableRowIds(table, getRowId)
const scrollElement = computed(() => (table.value?.$el as HTMLElement | undefined) ?? null)
useInfiniteScroll(scrollElement, loadMore, { distance: 200, canLoadMore: () => list.hasMore.value && !list.loading.value })

async function openAnalysis(_event: Event, row: TableRow<AnalysisRow>): Promise<void> {
  await router.replace({ query: { ...route.query, analysis: String(row.original.seq) } })
}

const showRound = computed(() => list.items.value.some((row) => (row.round ?? 1) > 1))

const columns = computed<TableColumn<AnalysisRow>[]>(() => [
  { accessorKey: 'seq', header: 'Seq' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'attempt', header: 'Attempt' },
  ...(showRound.value ? [{ accessorKey: 'round', header: 'Round' } satisfies TableColumn<AnalysisRow>] : []),
  { id: 'duration', header: 'Duration' },
  { id: 'error', header: 'Error' },
  ...filters.value.columns.map((column) => ({ id: `result.${column}`, header: column }) satisfies TableColumn<AnalysisRow>),
  { id: 'finishedAt', header: 'Finished' },
])

function resultValue(row: AnalysisRow, column: string): unknown {
  return row.result?.[column]
}

const limitMessage = computed(() => (list.limitReached.value ? `Showing the first ${formatCount(RESULTS_MAX_ROWS)} rows. Use the query console or an export for more.` : null))
</script>

<template>
  <div class="space-y-3">
    <ResultsFilterBar v-model="filters" :result-properties="properties" :live="live" @go-to-seq="goToSeq" @choose-columns="chooseColumns" />
    <div v-if="startAfter !== null" class="flex items-center gap-2 text-xs text-muted">
      <span>Starting at seq {{ formatCount(startAfter + 1) }}</span>
      <UButton label="Show from the start" color="neutral" variant="link" size="xs" @click="startAfter = null" />
    </div>
    <UAlert
      v-if="loadError && list.items.value.length === 0"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="errorTitle(loadError.code)"
      :description="loadError.details.path ? `${loadError.message} (at ${String(loadError.details.path)})` : loadError.message"
    />
    <UTable
      ref="table"
      :get-row-id="getRowId"
      :data="list.items.value"
      :columns="columns"
      :loading="list.loading.value"
      sticky
      :virtualize="{ estimateSize: 37, overscan: 20 }"
      aria-label="Analyses"
      empty="No analyses match."
      class="h-[60vh] min-h-80"
      :ui="{ td: 'py-2 text-xs', th: 'py-2 text-xs', tr: 'cursor-pointer' }"
      @select="openAnalysis"
    >
      <template #seq-cell="{ row }">
        <span class="font-mono tabular-nums">{{ row.original.seq }}</span>
      </template>
      <template #status-cell="{ row }">
        <StatusBadge kind="analysis" :state="row.original.status" />
      </template>
      <template #attempt-cell="{ row }">
        <span class="tabular-nums">{{ row.original.attempt ?? '–' }}</span>
      </template>
      <template #round-cell="{ row }">
        <span class="tabular-nums">{{ row.original.round ?? '–' }}</span>
      </template>
      <template #duration-cell="{ row }">
        <DurationText :ms="row.original.timings?.durationMs" />
      </template>
      <template #error-cell="{ row }">
        <div v-if="row.original.error" class="flex max-w-72 items-center gap-1.5">
          <code class="shrink-0 font-mono text-error">{{ row.original.error.type }}</code>
          <span class="truncate text-muted">{{ stripEscapes(row.original.error.message ?? '') }}</span>
        </div>
        <span v-else class="text-dimmed">–</span>
      </template>
      <template v-for="column in filters.columns" :key="column" #[`result.${column}-cell`]="{ row }">
        <FileChip
          v-if="fileRefProperties.has(column) && isFileRef(resultValue(row.original, column))"
          :file="resultValue(row.original, column) as never"
          :analysis-id="row.original.id"
          compact
        />
        <span v-else class="block max-w-56 truncate font-mono">{{ valuePreview(resultValue(row.original, column)) }}</span>
      </template>
      <template #finishedAt-cell="{ row }">
        <RelativeTime :value="row.original.timings?.finishedAt" />
      </template>
    </UTable>
    <LoadMoreButton :has-more="list.hasMore.value" :loading="list.loading.value" :limit-message="limitMessage" @load="loadMore" />
  </div>
</template>
