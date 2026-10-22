<script setup lang="ts">
// Language cards of the new-task wizard (docs/ui.md §5.6): title, base image, default entry, extensions.
defineProps<{ languages: Language[] }>()
const model = defineModel<string | null>({ default: null })
const emit = defineEmits<{ next: [] }>()

function choose(language: string): void {
  model.value = language
  emit('next')
}
</script>

<template>
  <ul class="grid gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label="Languages">
    <li v-for="language in languages" :key="language.language" class="flex">
      <button
        type="button"
        class="w-full rounded-lg border p-4 text-start transition hover:border-primary hover:bg-elevated"
        :class="model === language.language ? 'border-primary bg-elevated' : 'border-default'"
        :aria-pressed="model === language.language"
        @click="choose(language.language)"
      >
        <p class="font-medium">{{ language.title }}</p>
        <p class="mt-1 truncate font-mono text-[11px] text-muted" :title="language.baseImage">{{ language.baseImage }}</p>
        <p class="mt-1 text-xs text-muted">entry <span class="font-mono">{{ language.entry }}</span> · {{ language.extensions.join(' ') }}</p>
      </button>
    </li>
  </ul>
</template>
