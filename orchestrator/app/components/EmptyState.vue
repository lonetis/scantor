<script setup lang="ts">
// Big faded icon, one line of text and an optional primary action (docs/ui.md §5).
const props = withDefaults(defineProps<{
  icon?: string
  title: string
  description?: string
  actionLabel?: string
  actionTo?: string
  actionIcon?: string
}>(), { icon: 'i-lucide-inbox', description: undefined, actionLabel: undefined, actionTo: undefined, actionIcon: undefined })

const emit = defineEmits<{ action: [] }>()

function onAction(): void {
  if (!props.actionTo) emit('action')
}
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-2 py-10 text-center">
    <UIcon :name="icon" class="size-12 text-dimmed opacity-60" aria-hidden="true" />
    <p class="text-sm font-medium text-muted">{{ title }}</p>
    <p v-if="description" class="max-w-md text-xs text-dimmed">{{ description }}</p>
    <slot />
    <UButton
      v-if="actionLabel"
      class="mt-2"
      :to="actionTo"
      :icon="actionIcon"
      :label="actionLabel"
      size="sm"
      @click="onAction"
    />
  </div>
</template>
