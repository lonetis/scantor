<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { Scan } from '#shared/types/scans'
import type { QueryEditor, QueryInputs } from '~/composables/useQuery'

// The query console of a scan (docs/ui.md §5.13.4): queryAnalyses (filter, projection, sort, limit, afterSeq) or
// aggregateAnalyses (pipeline, limit), run with the button or Ctrl/⌘+Enter, output as JSON or a table of flat items,
// "Load more" for unsorted queries, errors inline (a rejected operator names its path), recent inputs per scan and
// "Export these results". `?filter=<json>` (set by the analysis slideover's "Query similar") prefills the filter.
// Items come from task code and scanned targets: rendered as text only.
const props = defineProps<{
  scan: Pick<Scan, 'id' | 'name'>
}>()

const route = useRoute()
const router = useRouter()
const queryState = useQuery(() => props.scan.id)
const { inputs, items, nextCursor, truncated, running, ranOnce, error, errorEditor, resultMode, parseErrors, valid, recent, currentFilter } = queryState
const exports = useExports(() => props.scan.id)

const modeItems = [
  { label: 'Query', value: 'query' },
  { label: 'Aggregate', value: 'aggregate' },
]
const outputItems = [
  { label: 'JSON', value: 'json' },
  { label: 'Table', value: 'table' },
]
const output = ref<'json' | 'table'>('json')
const flat = computed(() => isFlatItems(items.value))
const tableColumns = computed<TableColumn<Record<string, unknown>>[]>(() => {
  const keys = new Set<string>()
  for (const item of items.value) for (const key of Object.keys(item)) keys.add(key)
  return [...keys].map((key) => ({ id: key, accessorFn: (row: Record<string, unknown>) => row[key], header: key }))
})

function editorError(editor: QueryEditor): string | undefined {
  if (parseErrors.value[editor]) return parseErrors.value[editor]
  if (errorEditor.value === editor && error.value) {
    const path = error.value.details.path
    return typeof path === 'string' ? `${error.value.message} (at ${path})` : error.value.message
  }
  return undefined
}

/** Errors that no editor shows (timeouts, concurrency, other failures). */
const generalError = computed(() => (error.value && errorEditor.value === null ? error.value : null))

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    void queryState.run()
  }
}

function recentLabel(entry: QueryInputs): string {
  const text = entry.mode === 'query' ? entry.filter : entry.pipeline
  const compact = text.replace(/\s+/g, ' ')
  return `${entry.mode === 'query' ? 'Query' : 'Aggregate'}: ${compact.length > 80 ? `${compact.slice(0, 80)}…` : compact}`
}

const recentItems = computed(() => recent.value.map((entry, index) => ({ label: recentLabel(entry), value: index })))
const selectedRecent = ref<number | undefined>(undefined)
watch(selectedRecent, (index) => {
  if (index === undefined) return
  const entry = recent.value[index]
  if (entry) queryState.applyRecent(entry)
  selectedRecent.value = undefined
})

async function exportResults(): Promise<void> {
  const filter = currentFilter.value
  if (filter) await exports.openExportModal(props.scan, { filter })
}

// "Query similar" hands over a filter in the URL; take it once and remove it again.
watch(() => route.query.filter, async (raw) => {
  if (typeof raw !== 'string') return
  const parsed = parseEditor(raw, 'object', false)
  if (!parsed.error) queryState.prefillFilter(parsed.value as Record<string, unknown>)
  const query = { ...route.query }
  delete query.filter
  await router.replace({ query })
}, { immediate: true })
</script>

<template>
  <div class="space-y-4" @keydown="onKeydown">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <UTabs v-model="inputs.mode" :items="modeItems" :content="false" size="xs" aria-label="Query mode" />
      <USelectMenu
        v-if="recentItems.length > 0"
        v-model="selectedRecent"
        :items="recentItems"
        value-key="value"
        placeholder="Recent"
        aria-label="Recent queries"
        size="sm"
        class="w-72"
        icon="i-lucide-history"
      />
    </div>

    <template v-if="inputs.mode === 'query'">
      <UFormField label="Filter" name="filter" :error="editorError('filter')" description="A MongoDB filter over this scan's analyses, for example {&quot;status&quot;: &quot;failed&quot;}.">
        <UTextarea v-model="inputs.filter" :rows="3" autoresize class="w-full font-mono text-xs" spellcheck="false" />
      </UFormField>
      <div class="grid gap-3 md:grid-cols-2">
        <UFormField label="Projection" name="projection" :error="editorError('projection')" hint="optional">
          <UTextarea v-model="inputs.projection" :rows="2" autoresize placeholder="{&quot;seq&quot;: 1, &quot;error.type&quot;: 1}" class="w-full font-mono text-xs" spellcheck="false" />
        </UFormField>
        <UFormField label="Sort" name="sort" :error="editorError('sort')" hint="optional; disables Load more">
          <UTextarea v-model="inputs.sort" :rows="2" autoresize placeholder="{&quot;timings.durationMs&quot;: -1}" class="w-full font-mono text-xs" spellcheck="false" />
        </UFormField>
      </div>
      <div class="flex flex-wrap gap-3">
        <UFormField label="Limit" name="limit">
          <UInputNumber v-model="inputs.limit" :min="1" :max="QUERY_MAX_LIMIT" size="sm" class="w-32" />
        </UFormField>
        <UFormField label="After seq" name="afterSeq" hint="optional">
          <UInputNumber v-model="inputs.afterSeq" :min="-1" size="sm" class="w-36" placeholder="–" />
        </UFormField>
      </div>
    </template>
    <template v-else>
      <UFormField label="Pipeline" name="pipeline" :error="editorError('pipeline')" description="Aggregation stages; the scan scope is added in front automatically.">
        <UTextarea v-model="inputs.pipeline" :rows="5" autoresize class="w-full font-mono text-xs" spellcheck="false" />
      </UFormField>
      <UFormField label="Limit" name="aggregateLimit" hint="optional">
        <UInputNumber v-model="inputs.aggregateLimit" :min="1" size="sm" class="w-32" placeholder="max" />
      </UFormField>
    </template>

    <div class="flex flex-wrap items-center gap-2">
      <UButton label="Run" icon="i-lucide-play" :loading="running" :disabled="!valid" aria-label="Run query" @click="queryState.run()" />
      <span class="text-xs text-dimmed">Ctrl/⌘ + Enter</span>
      <UButton
        v-if="inputs.mode === 'query'"
        label="Export these results"
        icon="i-lucide-file-down"
        color="neutral"
        variant="outline"
        :disabled="currentFilter === null"
        @click="exportResults"
      />
    </div>

    <UAlert
      v-if="generalError"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="errorTitle(generalError.code)"
      :description="generalError.message"
    />

    <section v-if="ranOnce" class="space-y-2" aria-labelledby="query-output">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 id="query-output" class="text-[10px] font-semibold uppercase tracking-wider text-dimmed">
          {{ formatCount(items.length) }} {{ items.length === 1 ? 'item' : 'items' }}
        </h3>
        <UTabs v-model="output" :items="outputItems" :content="false" size="xs" aria-label="Output format" :disabled="!flat" />
      </div>
      <UAlert
        v-if="resultMode === 'aggregate' && truncated"
        color="warning"
        variant="subtle"
        icon="i-lucide-scissors"
        title="Output truncated"
        description="The pipeline produced more items than the limit (or the response size cap); add $limit or narrow the $match."
      />
      <UTable
        v-if="output === 'table' && flat"
        :data="items"
        :columns="tableColumns"
        aria-label="Query results"
        sticky
        class="max-h-[60vh]"
        :ui="{ td: 'py-1.5 font-mono text-xs', th: 'py-1.5 text-xs' }"
      />
      <JsonView v-else :value="items" :collapsed-depth="2" />
      <LoadMoreButton
        v-if="resultMode === 'query'"
        :has-more="nextCursor !== null"
        :loading="running"
        @load="queryState.loadMore()"
      />
    </section>
  </div>
</template>
