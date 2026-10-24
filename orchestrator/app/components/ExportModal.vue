<script setup lang="ts">
import { DEFAULT_CSV_COLUMNS } from '#shared/schemas/analyses'
import type { Export } from '#shared/types/exports'
import type { Scan } from '#shared/types/scans'
import { ANALYSIS_STATUSES, type AnalysisStatus, type ExportFormat } from '#shared/utils/enums'

// Starts a background export of a scan (docs/ui.md §5.13.6): format, a status quick filter or a JSON filter, and
// optional fields (comma-separated dot paths) → exportScan (never the inline export). The created export is followed
// by useExports until it is ready (then a toast offers the download). Use it with `v-model:open` or through
// useExports().openExportModal (useOverlay); it emits `close` with the created export, or null when cancelled.
const props = withDefaults(defineProps<{
  scan: Pick<Scan, 'id' | 'name'>
  filter?: Record<string, unknown>
  status?: AnalysisStatus[]
}>(), { filter: undefined, status: undefined })

const open = defineModel<boolean>('open', { default: true })
const emit = defineEmits<{ close: [created: Export | null] }>()

const exports = useExports(() => props.scan.id)
const toast = useToast()

function finish(created: Export | null): void {
  open.value = false
  emit('close', created)
}

const format = ref<ExportFormat>('jsonl')
const formatItems = [
  { label: 'JSON Lines (.jsonl)', value: 'jsonl', description: 'One masked analysis document per line, or only the chosen fields.' },
  { label: 'CSV (.csv)', value: 'csv', description: 'One row per analysis; nested values JSON-encoded.' },
]
const filterMode = ref<'status' | 'json'>(props.filter ? 'json' : 'status')
const filterModeItems = [
  { label: 'Status', value: 'status' },
  { label: 'JSON filter', value: 'json' },
]
const statuses = ref<AnalysisStatus[]>(props.status ?? [])
const statusItems = ANALYSIS_STATUSES.map((status) => ({ label: status, value: status }))
const filterText = ref(props.filter ? JSON.stringify(props.filter, null, 2) : '{}')
const fieldsText = ref('')
const submitting = ref(false)
const apiError = shallowRef<ApiError | null>(null)

const filterParse = computed(() => (filterMode.value === 'json' ? parseEditor(filterText.value, 'object', false) : {}))
const fields = computed(() => fieldsText.value.split(',').map((field) => field.trim()).filter((field) => field.length > 0))
const fieldsError = computed(() => {
  if (fields.value.length > 64) return 'At most 64 fields.'
  const bad = fields.value.find((field) => field.split('.').some((segment) => segment === '' || segment.startsWith('$')))
  return bad ? `"${bad}" is not a dot path such as result.title.` : null
})

/** API errors shown at the filter or fields input, the rest as an alert. */
const filterError = computed(() => {
  if (filterParse.value.error) return filterParse.value.error
  const path = apiError.value?.details.path
  return typeof path === 'string' && path.startsWith('filter') ? `${apiError.value!.message} (at ${path})` : undefined
})
const fieldsApiError = computed(() => {
  const issue = apiError.value ? errorIssues(apiError.value).find((entry) => entry.path.startsWith('fields')) : undefined
  return fieldsError.value ?? issue?.message
})
const generalError = computed(() => (apiError.value && !filterError.value && !fieldsApiError.value ? apiError.value : null))
const canSubmit = computed(() => !filterParse.value.error && !fieldsError.value && !submitting.value)

function selection(): Record<string, unknown> | undefined {
  if (filterMode.value === 'json') return filterParse.value.value as Record<string, unknown>
  return statuses.value.length > 0 ? { status: { $in: statuses.value } } : undefined
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  submitting.value = true
  apiError.value = null
  try {
    const filter = selection()
    const created = await exports.create(props.scan.id, {
      format: format.value,
      ...(filter ? { filter } : {}),
      ...(fields.value.length > 0 ? { fields: fields.value } : {}),
    })
    toast.add({ title: 'Export started', description: 'You get a notification when it is ready.', color: 'info', icon: 'i-lucide-file-down' })
    finish(created)
  } catch (cause) {
    apiError.value = toApiError(cause)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="`Export results of ${scan.name || shortId(scan.id)}`"
    description="A background export writes a file you can download for the retention period."
    :ui="{ content: 'sm:max-w-xl' }"
  >
    <template #close="{ ui }">
      <CloseButton :class="ui.close()" @click="finish(null)" />
    </template>
    <template #body>
      <form id="export-modal-form" class="space-y-4" @submit.prevent="submit">
        <UFormField label="Format" name="format">
          <URadioGroup v-model="format" :items="formatItems" />
        </UFormField>
        <UFormField label="Analyses" name="selection">
          <UTabs v-model="filterMode" :items="filterModeItems" :content="false" size="xs" aria-label="Selection mode" class="mb-2" />
          <USelectMenu
            v-if="filterMode === 'status'"
            v-model="statuses"
            :items="statusItems"
            value-key="value"
            multiple
            placeholder="All statuses"
            aria-label="Statuses to export"
            class="w-full"
          />
        </UFormField>
        <UFormField v-if="filterMode === 'json'" label="Filter" name="filter" :error="filterError" description="A MongoDB filter (queryAnalyses rules).">
          <UTextarea v-model="filterText" :rows="4" autoresize class="w-full font-mono text-xs" spellcheck="false" />
        </UFormField>
        <UFormField
          label="Fields"
          name="fields"
          :error="fieldsApiError"
          :hint="format === 'csv' ? 'optional; the CSV columns' : 'optional'"
          :description="format === 'csv' ? `Comma-separated dot paths. Default columns: ${DEFAULT_CSV_COLUMNS.join(', ')}.` : 'Comma-separated dot paths, for example seq, status, result.title. Empty exports whole documents.'"
        >
          <UInput v-model="fieldsText" class="w-full font-mono text-xs" placeholder="seq, status, result.title" autocomplete="off" />
        </UFormField>
        <UAlert
          v-if="generalError"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="errorTitle(generalError.code)"
          :description="generalError.message"
        />
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="finish(null)" />
        <UButton type="submit" form="export-modal-form" label="Start export" icon="i-lucide-file-down" :loading="submitting" :disabled="!canSubmit" />
      </div>
    </template>
  </UModal>
</template>
