<script lang="ts">
export type WizardSource = 'scaffold' | 'git' | 'upload'
</script>

<script setup lang="ts">
// Step 1 of the new-task wizard (docs/ui.md §5.6): where the task comes from.
const model = defineModel<WizardSource | null>({ default: null })
const emit = defineEmits<{ next: [] }>()

const SOURCES: { value: WizardSource; title: string; description: string; icon: string }[] = [
  { value: 'scaffold', title: 'From a scaffold', description: 'Start from a language starter and a schedule template.', icon: 'i-lucide-layout-template' },
  { value: 'git', title: 'Import from git', description: 'Import task folders from an https repository.', icon: 'i-lucide-git-branch' },
  { value: 'upload', title: 'Upload a folder', description: 'Upload a tar.gz of a task folder (what scantor push does).', icon: 'i-lucide-upload' },
]

function choose(source: WizardSource): void {
  model.value = source
  emit('next')
}
</script>

<template>
  <ul class="grid gap-3 md:grid-cols-3" aria-label="Task source">
    <li v-for="source in SOURCES" :key="source.value" class="flex">
      <button
        type="button"
        class="w-full rounded-lg border p-4 text-start transition hover:border-primary hover:bg-elevated"
        :class="model === source.value ? 'border-primary bg-elevated' : 'border-default'"
        :aria-pressed="model === source.value"
        @click="choose(source.value)"
      >
        <UIcon :name="source.icon" class="mb-2 size-6 text-primary" />
        <p class="font-medium">{{ source.title }}</p>
        <p class="text-xs text-muted">{{ source.description }}</p>
      </button>
    </li>
  </ul>
</template>
