<script setup lang="ts">
// Structured task-pipeline errors (docs/ui.md §5.9): phase badge, file:line:column and the message. Messages and file
// names come from the task's build (compiler output, often ANSI-colored): shown without escape sequences.
withDefaults(defineProps<{ errors: readonly BuildError[]; title?: string }>(), { title: 'Errors' })

function location(error: BuildError): string {
  if (!error.file) return ''
  return stripEscapes([error.file, error.line, error.column].filter((part) => part !== undefined && part !== null).join(':'))
}
</script>

<template>
  <section v-if="errors.length > 0" data-testid="build-errors" class="space-y-1.5">
    <p class="section-label">{{ title }}</p>
    <ul class="divide-y divide-default rounded-md border border-error/40">
      <li v-for="(error, index) in errors" :key="index" class="flex flex-wrap items-start gap-2 px-3 py-2 text-sm">
        <UBadge :label="error.phase" color="error" variant="subtle" size="xs" class="font-mono" />
        <span v-if="location(error)" class="font-mono text-xs text-muted">{{ location(error) }}</span>
        <span class="min-w-0 flex-1 whitespace-pre-wrap break-words">{{ stripEscapes(error.message) }}</span>
      </li>
    </ul>
  </section>
</template>
