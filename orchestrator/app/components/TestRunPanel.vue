<script setup lang="ts">
import type { TableColumn, TableRow } from '@nuxt/ui'

// The test-run panel of a task (docs/ui.md §5.8): inputs rendered from the latest known schemas (the latest
// revision's description, or a newer test run's), the live run over SSE (state, build and run logs, analyses,
// errors, summary, cancel) and the history of recent test runs. Unsent inputs are kept per task in the UI prefs
// without writeOnly values.
const props = defineProps<{
  task: Task
  /** description of the latest revision, when there is one */
  revisionDescription: Description | null
  manifestTimeoutMs: number | null
}>()

type Mode = 'schedule' | 'one'
const LIMIT_DEFAULT = 5

const actions = useTestRunActions()
const prefs = useUiPrefs()
const history = useTestRuns(() => props.task.id, 10)
const live = useTestRunStream()

const mode = ref<Mode>('schedule')
const taskConfig = ref<Record<string, unknown>>({})
const scanConfig = ref<Record<string, unknown>>({})
const analysisConfig = ref<Record<string, unknown>>({})
const limit = ref(LIMIT_DEFAULT)
const maxAttempts = ref(1)
const timeoutSeconds = ref<number | null>(null)
const starting = ref(false)
const startError = ref<string | null>(null)
const schemasChanged = ref(false)
const slideoverOpen = ref(false)
const selectedSeq = ref<number | null>(null)

/**
 * The schemas the forms start with: the latest revision's description, or the newest described test run of the
 * history when it is newer than the latest revision (or there is no revision yet).
 */
const baselineDescription = computed<Description | null>(() => {
  const described = history.items.value.find((item) => item.description)
  const revisionAt = props.task.latestRevision ? Date.parse(props.task.latestRevision.createdAt) : null
  if (described?.description && (!props.revisionDescription || revisionAt === null || Date.parse(described.createdAt) > revisionAt)) {
    return described.description
  }
  return props.revisionDescription
})
const formDescription = shallowRef<Description | null>(baselineDescription.value)
watch(baselineDescription, (description) => {
  // A followed run's own description (below) takes precedence over the baseline.
  if (description && !live.testRun.value?.description) formDescription.value = description
})
watch(() => live.testRun.value?.description, (description) => {
  if (!description) return
  if (formDescription.value && JSON.stringify(formDescription.value.schemas) !== JSON.stringify(description.schemas)) schemasChanged.value = true
  formDescription.value = description
})

const schemas = computed(() => formDescription.value?.schemas ?? null)
const uploadPaths = computed(() => formDescription.value?.uploadPaths ?? { taskConfig: [], scanConfig: [] })
const secretPointers = computed(() => {
  const paths = formDescription.value?.secretPaths
  if (!paths) return []
  return [
    ...paths.taskConfig.map((path) => `/taskConfig${path}`),
    ...paths.scanConfig.map((path) => `/scanConfig${path}`),
    ...paths.analysisConfig.map((path) => `/analysisConfig${path}`),
  ]
})

// Restore and keep the unsent inputs (without secrets) per task.
const draft = prefs.getTestRunDraft(props.task.id)
if (draft) {
  if (draft.mode === 'one' || draft.mode === 'schedule') mode.value = draft.mode
  if (isRecord(draft.taskConfig)) taskConfig.value = draft.taskConfig
  if (isRecord(draft.scanConfig)) scanConfig.value = draft.scanConfig
  if (isRecord(draft.analysisConfig)) analysisConfig.value = draft.analysisConfig
  if (typeof draft.limit === 'number') limit.value = draft.limit
  if (typeof draft.maxAttempts === 'number') maxAttempts.value = draft.maxAttempts
}
watch([mode, taskConfig, scanConfig, analysisConfig, limit, maxAttempts], () => {
  prefs.setTestRunDraft(
    props.task.id,
    { mode: mode.value, taskConfig: taskConfig.value, scanConfig: scanConfig.value, analysisConfig: analysisConfig.value, limit: limit.value, maxAttempts: maxAttempts.value },
    secretPointers.value,
  )
}, { deep: true })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const run = computed(() => live.testRun.value)
const active = computed(() => isTestRunActive(live.state.value))
const selected = computed(() => live.analyses.value.find((analysis) => analysis.seq === selectedSeq.value) ?? null)
const summary = computed(() => {
  if (run.value && !active.value) return run.value.summary
  const analyses = live.analyses.value
  return { analyses: analyses.length, succeeded: analyses.filter((a) => a.status === 'succeeded').length, failed: analyses.filter((a) => a.status === 'failed').length }
})
const durationMs = computed(() => {
  const current = run.value
  if (!current?.startedAt) return null
  return (current.finishedAt ? Date.parse(current.finishedAt) : Date.now()) - Date.parse(current.startedAt)
})

async function start(): Promise<void> {
  starting.value = true
  startError.value = null
  schemasChanged.value = false
  try {
    const body = {
      taskConfig: taskConfig.value,
      ...(mode.value === 'one' ? { analysisConfig: analysisConfig.value } : { scanConfig: scanConfig.value, limit: limit.value }),
      maxAttempts: maxAttempts.value,
      ...(timeoutSeconds.value ? { timeoutMs: Math.round(timeoutSeconds.value * 1000) } : {}),
    }
    const created = await actions.startTestRun(props.task.id, body)
    live.follow(created)
    await history.reset()
  } catch (cause) {
    startError.value = errorMessage(cause)
  } finally {
    starting.value = false
  }
}

async function cancel(): Promise<void> {
  const current = run.value
  if (!current) return
  try {
    const cancelled = await actions.cancelTestRun(current.id)
    live.state.value = cancelled.state
  } catch (cause) {
    console.error('[test-runs] cancel failed', cause)
  }
}

function load(_event: Event, row: TableRow<TestRun>): void {
  live.follow(row.original)
}

function openAnalysis(_event: Event, row: TableRow<TestRunAnalysis>): void {
  selectedSeq.value = row.original.seq
  slideoverOpen.value = true
}

watch(() => live.state.value, (state, previous) => {
  if (previous && isTestRunActive(previous) && state && !isTestRunActive(state)) void history.refresh()
})

const analysesTable = useTemplateRef('analysesTable')
useTableRowIds(analysesTable, (analysis: TestRunAnalysis) => analysis.seq)
const historyTable = useTemplateRef('historyTable')
useTableRowIds(historyTable, (testRun: TestRun) => testRun.id)

const analysisColumns: TableColumn<TestRunAnalysis>[] = [
  { accessorKey: 'seq', header: 'Seq' },
  { accessorKey: 'status', header: 'Status' },
  { id: 'duration', header: 'Duration' },
  { id: 'outcome', header: 'Result / error' },
]
const historyColumns: TableColumn<TestRun>[] = [
  { accessorKey: 'createdAt', header: 'Started' },
  { accessorKey: 'state', header: 'State' },
  { id: 'summary', header: 'Analyses' },
  { id: 'pack', header: 'Pack hash' },
]

function outcome(analysis: TestRunAnalysis): string {
  if (analysis.error) return `${analysis.error.type}: ${analysis.error.message}`
  return analysis.result ? JSON.stringify(analysis.result) : ''
}
</script>

<template>
  <div class="grid gap-4 xl:grid-cols-[minmax(20rem,28rem)_1fr]">
    <UCard :ui="{ body: 'p-4 sm:p-4' }">
      <form class="space-y-4" aria-label="Test run inputs" @submit.prevent="start">
        <UAlert
          v-if="schemasChanged"
          color="info"
          variant="subtle"
          icon="i-lucide-info"
          title="Schemas changed in your workspace; the form now uses the new schemas"
        />
        <UAlert
          v-if="!schemas"
          color="neutral"
          variant="subtle"
          icon="i-lucide-info"
          title="No schemas known yet"
          description="Inputs start as JSON; after the first test run or publish the forms use the described schemas."
        />
        <URadioGroup
          v-model="mode"
          orientation="horizontal"
          legend="Mode"
          :items="[{ label: 'Schedule + run', value: 'schedule' }, { label: 'One analysis', value: 'one' }]"
        />
        <div class="space-y-1">
          <p class="section-label">Task config</p>
          <SchemaForm v-model="taskConfig" :schema="schemas?.taskConfig ?? null" name="taskConfig" :upload-paths="uploadPaths.taskConfig" />
        </div>
        <div v-if="mode === 'schedule'" class="space-y-1">
          <p class="section-label">Scan config</p>
          <SchemaForm v-model="scanConfig" :schema="schemas?.scanConfig ?? null" name="scanConfig" :upload-paths="uploadPaths.scanConfig" />
        </div>
        <div v-else class="space-y-1">
          <p class="section-label">Analysis config</p>
          <SchemaForm v-model="analysisConfig" :schema="schemas?.analysisConfig ?? null" name="analysisConfig" />
        </div>
        <div class="flex flex-wrap gap-3">
          <UFormField v-if="mode === 'schedule'" label="Limit" name="limit" hint="1–50">
            <NumberInput v-model="limit" :min="1" :max="50" class="w-24" />
          </UFormField>
          <UFormField label="Max attempts" name="maxAttempts" hint="1–5">
            <NumberInput v-model="maxAttempts" :min="1" :max="5" class="w-24" />
          </UFormField>
          <UFormField label="Timeout (s)" name="timeout" :hint="manifestTimeoutMs ? `default ${Math.round(manifestTimeoutMs / 1000)}` : 'manifest default'">
            <NumberInput v-model="timeoutSeconds" :min="1" :max="86400" class="w-32" placeholder="default" />
          </UFormField>
        </div>
        <UAlert v-if="startError" color="error" variant="subtle" icon="i-lucide-circle-alert" title="The test run could not start" :description="startError" />
        <UButton type="submit" label="Start test run" icon="i-lucide-flask-conical" :loading="starting" :disabled="active" block />
      </form>
    </UCard>

    <div class="min-w-0 space-y-4">
      <UCard :ui="{ body: 'p-4 sm:p-4' }">
        <div v-if="run" class="space-y-3">
          <div class="flex flex-wrap items-center gap-2">
            <StatusBadge kind="testRun" :state="live.state.value" />
            <UBadge v-if="run.draftImage?.cached" label="draft image cached" color="neutral" variant="soft" size="xs" />
            <DurationText :ms="durationMs" />
            <span class="text-xs text-muted tabular-nums">
              {{ plural(summary.analyses, 'analysis', 'analyses') }} · {{ summary.succeeded }} succeeded · {{ summary.failed }} failed
            </span>
            <UButton
              v-if="active"
              label="Cancel test run"
              icon="i-lucide-square"
              size="xs"
              color="error"
              variant="outline"
              class="ms-auto"
              @click="cancel"
            />
          </div>
          <BuildErrors :errors="live.errors.value" />
          <div class="space-y-3" data-testid="test-run-log">
            <div class="space-y-1">
              <p class="section-label">Build</p>
              <LogView :lines="live.buildLines.value" empty-text="No build output yet." max-height-class="max-h-64" />
            </div>
            <div class="space-y-1">
              <p class="section-label">Run</p>
              <LogView :lines="live.runLines.value" empty-text="No run output yet." max-height-class="max-h-64" />
            </div>
          </div>
          <UTable
            ref="analysesTable"
            :data="live.analyses.value"
            :columns="analysisColumns"
            aria-label="Test run analyses"
            empty="No analyses yet."
            class="cursor-pointer"
            :ui="{ td: 'py-1.5 text-sm', th: 'py-1.5 text-xs' }"
            @select="openAnalysis"
          >
            <template #status-cell="{ row }">
              <StatusBadge kind="analysis" :state="row.original.status" />
            </template>
            <template #duration-cell="{ row }">
              <DurationText :ms="row.original.timings?.durationMs" />
            </template>
            <template #outcome-cell="{ row }">
              <span class="block max-w-xl truncate font-mono text-xs" :class="row.original.error ? 'text-error' : ''">{{ outcome(row.original) }}</span>
            </template>
          </UTable>
        </div>
        <EmptyState v-else icon="i-lucide-flask-conical" title="No test run selected" description="Start a test run or pick one from the history." />
      </UCard>

      <section class="space-y-2" aria-labelledby="test-run-history-heading">
        <h3 id="test-run-history-heading" class="section-label">History</h3>
        <UTable
          ref="historyTable"
          :data="history.items.value"
          :columns="historyColumns"
          :loading="history.loading.value && !history.loaded.value"
          aria-label="Test run history"
          empty="No test runs yet."
          class="cursor-pointer"
          :ui="{ td: 'py-1.5 text-sm', th: 'py-1.5 text-xs' }"
          @select="load"
        >
          <template #createdAt-cell="{ row }">
            <RelativeTime :value="row.original.createdAt" />
          </template>
          <template #state-cell="{ row }">
            <StatusBadge kind="testRun" :state="row.original.state" />
          </template>
          <template #summary-cell="{ row }">
            <span class="text-xs tabular-nums">{{ row.original.summary.succeeded }} / {{ row.original.summary.analyses }} succeeded</span>
          </template>
          <template #pack-cell="{ row }">
            <IdChip v-if="row.original.packSha256" :id="row.original.packSha256" :copy-label="`Copy pack hash of test run ${row.original.id}`" />
          </template>
        </UTable>
        <LoadMoreButton :has-more="history.hasMore.value" :loading="history.loading.value" @load="history.loadMore()" />
      </section>
    </div>

    <TestRunAnalysisSlideover v-if="run" v-model:open="slideoverOpen" :test-run-id="run.id" :analysis="selected" />
  </div>
</template>
