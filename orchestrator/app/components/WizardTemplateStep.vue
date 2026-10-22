<script setup lang="ts">
// Template cards of the new-task wizard (docs/ui.md §5.6): every template the language's scaffold supports, with
// its example analysis config and a "pins inputs" badge, plus "Custom schedule" (a generator stub).
defineProps<{ templates: Template[]; allowCustom: boolean }>()
const model = defineModel<string | null>({ default: null })
const emit = defineEmits<{ next: [] }>()

function choose(template: string): void {
  model.value = template
  emit('next')
}
</script>

<template>
  <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3" role="list" aria-label="Templates">
    <div
      v-for="template in templates"
      :key="template.name"
      role="listitem"
      class="flex flex-col gap-2 rounded-lg border p-4"
      :class="model === template.name ? 'border-primary bg-elevated' : 'border-default'"
    >
      <div class="flex items-start justify-between gap-2">
        <div>
          <p class="font-medium">{{ template.title }}</p>
          <p class="font-mono text-[11px] text-muted">{{ template.name }}</p>
        </div>
        <UBadge v-if="template.resolves" label="pins inputs" color="info" variant="subtle" size="xs" />
      </div>
      <p class="text-xs text-muted">{{ template.description }}</p>
      <JsonView :value="template.example.analysisConfig" :collapsed-depth="1" :copyable="false" />
      <UButton :label="`Use ${template.title}`" size="xs" variant="outline" class="mt-auto self-start" @click="choose(template.name)" />
    </div>
    <div
      v-if="allowCustom"
      role="listitem"
      class="flex flex-col gap-2 rounded-lg border p-4"
      :class="model === 'custom' ? 'border-primary bg-elevated' : 'border-default'"
    >
      <p class="font-medium">Custom schedule</p>
      <p class="text-xs text-muted">A generator stub that yields analysis configs from a scan config field; write your own schedule.</p>
      <UButton label="Use a custom schedule" size="xs" variant="outline" class="mt-auto self-start" @click="choose('custom')" />
    </div>
  </div>
</template>
