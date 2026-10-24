<script lang="ts">
export interface SecretSnippet {
  title: string
  code: string
}
</script>

<script setup lang="ts">
// Shows a secret (API key, node token) exactly once with copy buttons and ready-to-paste snippets
// (docs/ui.md §5.15, §5.18). Nothing here is persisted.
withDefaults(defineProps<{
  title: string
  secret: string
  secretLabel?: string
  warning?: string
  snippets?: SecretSnippet[]
}>(), { secretLabel: 'Secret', warning: 'This value is shown only now. Store it somewhere safe.', snippets: () => [] })

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ close: [] }>()

function close(): void {
  open.value = false
  emit('close')
}
</script>

<template>
  <UModal v-model:open="open" :title="title" :dismissible="false" :ui="{ content: 'sm:max-w-2xl' }">
    <template #close="{ ui }">
      <CloseButton :class="ui.close()" @click="close" />
    </template>
    <template #body>
      <div class="space-y-4" data-testid="secret-reveal">
        <UAlert color="warning" variant="subtle" icon="i-lucide-triangle-alert" :description="warning" />
        <div class="space-y-1">
          <p class="section-label">{{ secretLabel }}</p>
          <div class="flex items-center gap-1">
            <code class="code-surface block min-w-0 flex-1 overflow-x-auto rounded-md px-3 py-2 whitespace-nowrap" data-testid="secret-value">{{ secret }}</code>
            <CopyButton :value="secret" :label="`Copy ${secretLabel.toLowerCase()}`" size="sm" />
          </div>
        </div>
        <div v-for="snippet in snippets" :key="snippet.title" class="space-y-1">
          <p class="section-label">{{ snippet.title }}</p>
          <CodeBlock :code="snippet.code" :copy-label="`Copy ${snippet.title.toLowerCase()}`" :label="snippet.title" wrap />
        </div>
        <slot />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end">
        <UButton label="Done" @click="close" />
      </div>
    </template>
  </UModal>
</template>
