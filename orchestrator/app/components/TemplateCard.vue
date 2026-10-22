<script setup lang="ts">
import type { PointerIssue } from '~/utils/json-pointer'

// One schedule template of the catalog (docs/ui.md §5.14): description, "pins inputs at scan start", the scan and
// analysis config schemas (collapsible), the examples, and an estimate of the number of analyses for a scan config.
const props = defineProps<{ template: Template }>()

const { estimate } = useTemplates()
const scanConfig = ref<Record<string, unknown>>({ ...props.template.example.scanConfig })
const result = shallowRef<TemplateEstimate | null>(null)
const issues = ref<PointerIssue[]>([])
const error = ref<string | null>(null)
const estimating = ref(false)
const schemasOpen = ref(false)

async function run(): Promise<void> {
  estimating.value = true
  error.value = null
  issues.value = []
  result.value = null
  try {
    result.value = await estimate(props.template.name, scanConfig.value)
  } catch (cause) {
    const apiError = toApiError(cause)
    issues.value = errorIssues(apiError)
    error.value = apiError.message
  } finally {
    estimating.value = false
  }
}
</script>

<template>
  <UCard :ui="{ body: 'p-4 sm:p-4 space-y-3' }">
    <div class="flex items-start justify-between gap-2">
      <div>
        <h2 class="font-semibold">{{ template.title }}</h2>
        <p class="font-mono text-xs text-muted">{{ template.name }}</p>
      </div>
      <UBadge v-if="template.resolves" label="pins inputs at scan start" color="info" variant="subtle" size="xs" icon="i-lucide-pin" />
    </div>
    <p class="text-sm text-muted">{{ template.description }}</p>

    <div class="grid gap-3 md:grid-cols-2">
      <div class="space-y-1">
        <p class="section-label">Example scan config</p>
        <JsonView :value="template.example.scanConfig" :collapsed-depth="2" />
      </div>
      <div class="space-y-1">
        <p class="section-label">Example analysis config</p>
        <JsonView :value="template.example.analysisConfig" :collapsed-depth="2" />
      </div>
    </div>

    <UCollapsible v-model:open="schemasOpen">
      <UButton
        :label="schemasOpen ? 'Hide schemas' : 'Show schemas'"
        :aria-label="`${schemasOpen ? 'Hide' : 'Show'} schemas of ${template.title}`"
        :trailing-icon="schemasOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        color="neutral"
        variant="ghost"
        size="xs"
      />
      <template #content>
        <div class="mt-2 space-y-3">
          <SchemaTable :schema="template.scanConfigSchema" :label="`${template.title} scan config schema`" />
          <SchemaTable :schema="template.analysisConfigSchema" :label="`${template.title} analysis config schema`" />
        </div>
      </template>
    </UCollapsible>

    <div class="space-y-2 rounded-md border border-default p-3">
      <p class="section-label">Estimate</p>
      <SchemaForm v-model="scanConfig" :schema="template.scanConfigSchema" name="scanConfig" :server-issues="issues" />
      <div class="flex flex-wrap items-center gap-3">
        <UButton :label="`Estimate ${template.title}`" icon="i-lucide-calculator" size="xs" :loading="estimating" @click="run" />
        <template v-if="result">
          <span class="text-sm tabular-nums">
            {{ result.expectedTotal === null ? 'unknown' : formatCount(result.expectedTotal) }} analyses
            <span class="text-xs text-muted">({{ result.exact ? 'exact' : 'estimate' }})</span>
          </span>
          <UBadge v-if="result.confirmationRequired" label="needs confirmation" color="warning" variant="subtle" size="xs" />
          <UBadge v-if="result.tooLarge" label="too large" color="error" variant="subtle" size="xs" />
        </template>
      </div>
      <p v-if="error && issues.length === 0" class="text-xs text-error">{{ error }}</p>
    </div>
  </UCard>
</template>
