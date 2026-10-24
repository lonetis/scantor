<script setup lang="ts">
// The close button of every modal and slideover, rendered in their #close slot: icon-only, so its name is also its
// tooltip (docs/ui.md §11 rule 1). The slot sits inside reka's DialogClose (as-child), which adds the closing click.
withDefaults(defineProps<{ label?: string }>(), { label: 'Close' })
</script>

<template>
  <UTooltip :text="label">
    <UButton icon="i-lucide-x" color="neutral" variant="ghost" :aria-label="label" />
  </UTooltip>
</template>
