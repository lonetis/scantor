<script setup lang="ts">
// "Load more" for cursor lists (docs/ui.md §15 decision 2: no page numbers).
withDefaults(defineProps<{
  hasMore: boolean
  loading?: boolean
  label?: string
  /** Shown instead of the button when an in-memory cap stops loading. */
  limitMessage?: string | null
}>(), { loading: false, label: 'Load more', limitMessage: null })

defineEmits<{ load: [] }>()
</script>

<template>
  <div v-if="hasMore || limitMessage" class="flex justify-center py-2">
    <p v-if="limitMessage" class="text-xs text-dimmed">{{ limitMessage }}</p>
    <UButton
      v-else
      :label="label"
      icon="i-lucide-chevron-down"
      color="neutral"
      variant="outline"
      size="sm"
      :loading="loading"
      @click="$emit('load')"
    />
  </div>
</template>
