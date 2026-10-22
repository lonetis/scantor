<script setup lang="ts">
// The describe output of a ready revision or a test run's draft (docs/ui.md §5.9): a schema table per config type and
// the result (SchemaTable has its own "Raw JSON" toggle), then settings defaults, warnings and the normalised
// manifest.
const props = defineProps<{
  description: Description
  settingsDefaults?: Record<string, unknown> | null
  manifest?: Record<string, unknown> | null
}>()

const tabs = [
  { label: 'Task config', value: 'taskConfig' },
  { label: 'Scan config', value: 'scanConfig' },
  { label: 'Analysis config', value: 'analysisConfig' },
  { label: 'Result', value: 'result' },
] as const
type SchemaKey = (typeof tabs)[number]['value']

const active = ref<SchemaKey>('taskConfig')
const schema = computed(() => props.description.schemas[active.value] as Record<string, unknown>)
const activeLabel = computed(() => tabs.find((tab) => tab.value === active.value)?.label ?? '')
</script>

<template>
  <div class="space-y-4">
    <UTabs v-model="active" :items="[...tabs]" :content="false" size="xs" variant="link" />
    <SchemaTable :schema="schema" :label="`${activeLabel} schema`" />

    <div v-if="settingsDefaults" class="space-y-1">
      <p class="section-label">Settings defaults</p>
      <JsonView :value="settingsDefaults" :collapsed-depth="3" />
    </div>
    <div v-if="description.warnings.length > 0" class="space-y-1">
      <p class="section-label">Warnings</p>
      <ul class="list-inside list-disc text-sm text-warning">
        <li v-for="(warning, index) in description.warnings" :key="index">{{ warning }}</li>
      </ul>
    </div>
    <div v-if="manifest" class="space-y-1">
      <p class="section-label">Manifest</p>
      <JsonView :value="manifest" :collapsed-depth="3" />
    </div>
  </div>
</template>
