<script setup lang="ts">
import type { LocationQuery } from 'vue-router'
import type { Analysis } from '#shared/types/analyses'
import type { Scan } from '#shared/types/scans'

// The analysis detail drawer of a scan (docs/ui.md §5.13.3). It follows the route query `?analysis=<seq>`, so the
// results table, the in-flight table and links can open it by setting that parameter; closing removes it. Config,
// result, error, attempts, logs and file names come from scanned targets and task code: everything is rendered as
// text (JsonView, LogView), values that look like URLs are never linkified, secrets arrive masked as "***".
const props = defineProps<{
  scan: Pick<Scan, 'id' | 'task' | 'revision'>
}>()

const route = useRoute()
const router = useRouter()
const { isAdmin } = useAuth()
const analyses = useAnalyses(() => props.scan.id)

const seq = computed<number | null>(() => {
  const raw = route.query.analysis
  if (typeof raw !== 'string' || !/^\d{1,16}$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : null
})
const open = computed({
  get: () => seq.value !== null,
  set: (value: boolean) => {
    if (!value) void close()
  },
})

const analysis = shallowRef<Analysis | null>(null)
const loading = ref(false)
const loadError = shallowRef<ApiError | null>(null)
let generation = 0

async function load(): Promise<void> {
  const current = ++generation
  analysis.value = null
  loadError.value = null
  if (seq.value === null) return
  loading.value = true
  try {
    const result = await analyses.get(seq.value)
    if (current === generation) analysis.value = result
  } catch (cause) {
    if (current === generation) loadError.value = toApiError(cause)
  } finally {
    if (current === generation) loading.value = false
  }
}

watch(() => [props.scan.id, seq.value], () => void load(), { immediate: true })

// The describe output names where FileRefs live in the result (`fileRefPaths`).
const revisionPath = computed(() => (open.value ? `/api/tasks/${props.scan.task.id}/revisions/${props.scan.revision.id}` : null))
const { data: revision } = useApiFetch<Revision>(revisionPath, { toast: false })
const resultFiles = computed(() => {
  const result = analysis.value?.result
  const pointers = revision.value?.description?.fileRefPaths ?? []
  return result ? fileRefsAt(result, pointers) : []
})
const otherFiles = computed(() => {
  const inResult = new Set(resultFiles.value.map((entry) => entry.file.id))
  return (analysis.value?.files ?? []).filter((file) => !inResult.has(file.id))
})

const title = computed(() => (seq.value === null ? 'Analysis' : `Analysis ${formatCount(seq.value)}`))
const stackOpen = ref(false)

async function close(): Promise<void> {
  const query = { ...route.query }
  delete query.analysis
  await router.replace({ query })
}

const { copy } = useCopy()

function copyAsJson(): void {
  if (analysis.value) void copy(JSON.stringify(analysis.value, null, 2))
}

/** Opens the query tab with a filter that finds similar analyses. */
async function querySimilar(): Promise<void> {
  const current = analysis.value
  if (!current) return
  const filter = current.error ? { 'error.type': current.error.type } : { seq: current.seq }
  const query: LocationQuery = { ...route.query, tab: 'query', filter: JSON.stringify(filter) }
  delete query.analysis
  await router.replace({ query })
}
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="title"
    description="Configuration, result, error, attempts and logs of one analysis."
    side="right"
    :ui="{ content: 'sm:max-w-3xl' }"
    :content="dialogContent"
  >
    <template #close="{ ui }">
      <CloseButton :class="ui.close()" />
    </template>
    <template #body>
      <div data-testid="analysis-slideover" class="space-y-6">
        <div v-if="loading" class="space-y-2">
          <USkeleton class="h-5 w-1/2" />
          <USkeleton class="h-24 w-full" />
        </div>
        <UAlert
          v-else-if="loadError"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="loadError.status === 404 ? 'No such analysis yet' : errorTitle(loadError.code)"
          :description="loadError.status === 404 ? 'This seq has not produced an analysis document (it may still be queued).' : loadError.message"
        />

        <template v-else-if="analysis">
          <section class="space-y-2" aria-labelledby="analysis-header">
            <h3 id="analysis-header" class="sr-only">Summary</h3>
            <div class="flex flex-wrap items-center gap-2">
              <IdChip :id="analysis.id" :length="48" copy-label="Copy analysis id" />
              <StatusBadge kind="analysis" :state="analysis.status" size="sm" />
              <UBadge :label="`attempt ${analysis.attempt}`" color="neutral" variant="outline" size="xs" />
              <UBadge v-if="analysis.round > 1" :label="`round ${analysis.round}`" color="neutral" variant="outline" size="xs" />
            </div>
            <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <dt class="text-muted">Worker</dt>
              <dd><IdChip v-if="analysis.workerId" :id="analysis.workerId" copy-label="Copy worker id" /><span v-else class="text-dimmed">–</span></dd>
              <dt class="text-muted">Node</dt>
              <dd>
                <template v-if="analysis.nodeId">
                  <NuxtLink v-if="isAdmin" :to="`/admin/nodes/${analysis.nodeId}`" class="font-mono hover:underline">{{ shortId(analysis.nodeId) }}</NuxtLink>
                  <IdChip v-else :id="analysis.nodeId" copy-label="Copy node id" />
                </template>
                <span v-else class="text-dimmed">–</span>
              </dd>
              <dt class="text-muted">Scheduled</dt>
              <dd><RelativeTime :value="analysis.timings?.scheduledAt" /></dd>
              <dt class="text-muted">Started</dt>
              <dd><RelativeTime :value="analysis.timings?.startedAt" /></dd>
              <dt class="text-muted">Finished</dt>
              <dd><RelativeTime :value="analysis.timings?.finishedAt" /></dd>
              <dt class="text-muted">Duration</dt>
              <dd><DurationText :ms="analysis.timings?.durationMs" /></dd>
            </dl>
            <div class="flex flex-wrap gap-2 pt-1">
              <UButton label="Copy as JSON" icon="i-lucide-copy" color="neutral" variant="outline" size="xs" @click="copyAsJson" />
              <UButton label="Query similar" icon="i-lucide-search" color="neutral" variant="outline" size="xs" @click="querySimilar" />
            </div>
          </section>

          <section class="space-y-2" aria-labelledby="analysis-config">
            <h3 id="analysis-config" class="text-[10px] font-semibold uppercase tracking-wider text-dimmed">Config</h3>
            <JsonView v-if="analysis.config" :value="analysis.config" />
            <p v-else class="text-xs text-dimmed">No config was stored for this analysis.</p>
          </section>

          <section v-if="analysis.result" class="space-y-2" aria-labelledby="analysis-result">
            <h3 id="analysis-result" class="text-[10px] font-semibold uppercase tracking-wider text-dimmed">Result</h3>
            <JsonView :value="analysis.result" />
            <div v-if="resultFiles.length > 0" class="space-y-2">
              <div v-for="entry in resultFiles" :key="`${entry.pointer}-${entry.file.id}`" class="space-y-1">
                <p class="font-mono text-[11px] text-muted">{{ entry.pointer }}</p>
                <FileChip :file="entry.file" :analysis-id="analysis.id" preview />
              </div>
            </div>
          </section>

          <section v-if="analysis.error" class="space-y-2" aria-labelledby="analysis-error">
            <h3 id="analysis-error" class="text-[10px] font-semibold uppercase tracking-wider text-dimmed">Error</h3>
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <UBadge :label="analysis.error.type" color="error" variant="subtle" size="xs" class="font-mono" />
              <span class="text-muted">phase <code class="font-mono">{{ analysis.error.phase }}</code></span>
              <span class="text-muted">{{ analysis.error.retryable ? 'retryable' : 'not retryable' }}</span>
              <span class="text-muted">attempt {{ analysis.error.attempt }}</span>
              <RelativeTime :value="analysis.error.at" class="text-dimmed" />
            </div>
            <p class="whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 font-mono text-xs">{{ stripEscapes(analysis.error.message) }}</p>
            <JsonView v-if="analysis.error.details" :value="analysis.error.details" />
            <div v-if="analysis.error.stack">
              <UButton
                :label="stackOpen ? 'Hide stack trace' : 'Show stack trace'"
                :icon="stackOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
                color="neutral"
                variant="ghost"
                size="xs"
                :aria-expanded="stackOpen"
                @click="stackOpen = !stackOpen"
              />
              <pre v-if="stackOpen" class="code-surface mt-1 max-h-72 overflow-auto rounded-md px-3 py-2 font-mono text-xs whitespace-pre">{{ stripAnsi(analysis.error.stack) }}</pre>
            </div>
          </section>

          <section class="space-y-2" aria-labelledby="analysis-attempts">
            <h3 id="analysis-attempts" class="text-[10px] font-semibold uppercase tracking-wider text-dimmed">Attempts</h3>
            <AttemptsTable :attempts="analysis.attempts" :show-node-links="isAdmin" />
          </section>

          <section class="space-y-2" aria-labelledby="analysis-logs">
            <h3 id="analysis-logs" class="text-[10px] font-semibold uppercase tracking-wider text-dimmed">Logs</h3>
            <LogView :text="analysis.logTail ?? ''" max-height-class="max-h-72" empty-text="No output captured." />
          </section>

          <section v-if="otherFiles.length > 0" class="space-y-2" aria-labelledby="analysis-files">
            <h3 id="analysis-files" class="text-[10px] font-semibold uppercase tracking-wider text-dimmed">Files</h3>
            <div class="flex flex-col items-start gap-2">
              <FileChip v-for="file in otherFiles" :key="file.id" :file="file" :analysis-id="analysis.id" preview />
            </div>
          </section>
        </template>
      </div>
    </template>
  </USlideover>
</template>
