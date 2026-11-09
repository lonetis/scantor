<script setup lang="ts">
import { SCRIPT_RUN_MAX_SCANS } from '#shared/schemas/scripts'

// Scan selection of the script-run form: a multi-select searching the owner's scans by name (`listScans?q=`, debounced),
// the chosen scans kept while the search shows others. `initial` (the `?scan=` prefill) is loaded by id.
const props = withDefaults(defineProps<{
  /** owner of the script: a script run reads only that user's scans */
  owner: string
  initial?: readonly string[]
  disabled?: boolean
}>(), { initial: () => [], disabled: false })
const model = defineModel<string[]>({ default: () => [] })

const choices = useScanChoices(() => props.owner)

const items = computed(() => choices.items.value.map((item) => ({ label: item.label, value: item.id, description: item.description })))
const missing = ref<number>(0)

watch(model, (ids) => choices.keep(ids))

onMounted(async () => {
  void choices.load()
  if (props.initial.length === 0) return
  const existing = await choices.resolve(props.initial)
  missing.value = props.initial.length - existing.length
  model.value = [...new Set([...model.value, ...existing])].slice(0, SCRIPT_RUN_MAX_SCANS)
})
</script>

<template>
  <div class="space-y-1">
    <USelectMenu
      v-model="model"
      v-model:search-term="choices.search.value"
      :items="items"
      value-key="value"
      multiple
      ignore-filter
      :loading="choices.loading.value"
      :disabled="disabled"
      placeholder="Select scans"
      :search-input="{ placeholder: 'Search scans by name…' }"
      class="w-full"
      aria-label="Scans"
    />
    <p class="text-xs text-dimmed">{{ model.length }} of at most {{ SCRIPT_RUN_MAX_SCANS }} scans selected</p>
    <p v-if="missing > 0" class="text-xs text-warning">{{ plural(missing, 'linked scan was', 'linked scans were') }} not found.</p>
    <p v-if="choices.error.value" class="text-xs text-error">Scans could not be searched: {{ choices.error.value.message }}</p>
  </div>
</template>
