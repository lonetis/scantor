<script setup lang="ts">
import { ANALYSIS_STATUSES, type AnalysisStatus } from '#shared/utils/enums'
import type { ResultsFilters } from '~/composables/useAnalyses'

// Filters of the results tab (docs/ui.md §5.13.2): status multi-select (listAnalyses?status=), "Go to seq", an
// advanced JSON filter that switches the table to queryAnalyses, the result-column picker (at most four columns,
// persisted per task by the table) and the auto-refresh switch.
const props = defineProps<{
  /** Top-level properties of the revision's Result schema. */
  resultProperties: readonly string[]
  /** Auto-refresh is offered while the scan is running. */
  live: boolean
}>()

const filters = defineModel<ResultsFilters>({ required: true })
const emit = defineEmits<{ goToSeq: [seq: number] }>()

const statusItems = ANALYSIS_STATUSES.map((status) => ({ label: status, value: status }))
const columnItems = computed(() => props.resultProperties.map((property) => ({ label: property, value: property })))

const statuses = computed({
  get: () => filters.value.statuses,
  set: (value: AnalysisStatus[]) => {
    filters.value = { ...filters.value, statuses: value }
  },
})
const columns = computed({
  get: () => filters.value.columns,
  set: (value: string[]) => {
    filters.value = { ...filters.value, columns: value.slice(0, MAX_RESULT_COLUMNS) }
  },
})
const autoRefresh = computed({
  get: () => filters.value.autoRefresh,
  set: (value: boolean) => {
    filters.value = { ...filters.value, autoRefresh: value }
  },
})

const seqInput = ref('')
const seqValid = computed(() => /^\d{1,16}$/.test(seqInput.value.trim()) && Number.isSafeInteger(Number(seqInput.value.trim())))

function goToSeq(): void {
  if (seqValid.value) emit('goToSeq', Number(seqInput.value.trim()))
}

const advancedOpen = ref(filters.value.advanced !== null)
const advancedText = ref(filters.value.advanced ?? '{"status": "failed"}')
const advancedError = computed(() => {
  const parsed = parseEditor(advancedText.value, 'object', false)
  return parsed.error ?? null
})

watch(() => filters.value.advanced, (value) => {
  if (value !== null) {
    advancedText.value = value
    advancedOpen.value = true
  }
})

function applyAdvanced(): void {
  if (advancedError.value) return
  filters.value = { ...filters.value, advanced: advancedText.value }
}

function toggleAdvanced(): void {
  advancedOpen.value = !advancedOpen.value
  if (!advancedOpen.value && filters.value.advanced !== null) filters.value = { ...filters.value, advanced: null }
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-wrap items-center gap-2">
      <USelectMenu
        v-model="statuses"
        :items="statusItems"
        value-key="value"
        multiple
        placeholder="All statuses"
        aria-label="Filter by status"
        size="sm"
        class="min-w-44"
        :disabled="filters.advanced !== null"
      />
      <form class="flex items-center gap-1" @submit.prevent="goToSeq">
        <UInput v-model="seqInput" inputmode="numeric" placeholder="seq" aria-label="Seq to go to" size="sm" class="w-28 font-mono" />
        <UButton type="submit" label="Go to seq" color="neutral" variant="outline" size="sm" :disabled="!seqValid" />
      </form>
      <UButton
        :label="advancedOpen ? 'Hide advanced filter' : 'Advanced filter'"
        icon="i-lucide-braces"
        color="neutral"
        :variant="filters.advanced !== null ? 'subtle' : 'outline'"
        size="sm"
        :aria-pressed="advancedOpen"
        @click="toggleAdvanced"
      />
      <USelectMenu
        v-model="columns"
        :items="columnItems"
        value-key="value"
        multiple
        placeholder="Result columns"
        aria-label="Result columns"
        size="sm"
        class="min-w-44"
        :disabled="columnItems.length === 0"
      />
      <USwitch v-if="live" v-model="autoRefresh" label="Auto-refresh" size="sm" />
    </div>
    <div v-if="advancedOpen" class="space-y-1">
      <UFormField
        label="Advanced filter"
        description="A MongoDB filter over this scan's analyses (queryAnalyses rules), for example {&quot;result.status&quot;: {&quot;$gte&quot;: 500}}."
        :error="advancedError ?? undefined"
        name="advancedFilter"
      >
        <UTextarea v-model="advancedText" :rows="3" autoresize class="w-full font-mono text-xs" spellcheck="false" />
      </UFormField>
      <div class="flex gap-2">
        <UButton label="Apply filter" icon="i-lucide-filter" size="sm" :disabled="advancedError !== null" @click="applyAdvanced" />
      </div>
    </div>
  </div>
</template>
