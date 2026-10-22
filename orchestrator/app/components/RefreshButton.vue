<script setup lang="ts">
// The navbar "Refresh" button of every polled page (docs/ui.md §5).
withDefaults(defineProps<{ loading?: boolean, label?: string }>(), { loading: false, label: 'Refresh' })
defineEmits<{ click: [] }>()
</script>

<template>
  <UTooltip :text="label">
    <UButton
      icon="i-lucide-refresh-cw"
      color="neutral"
      variant="ghost"
      size="sm"
      :aria-label="label"
      :loading="loading"
      @click="$emit('click')"
    />
  </UTooltip>
</template>
