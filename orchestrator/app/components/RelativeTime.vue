<script setup lang="ts">
import { useNow } from '@vueuse/core'

// "3 min ago" with the absolute ISO time as tooltip (docs/ui.md §10); re-renders every 30 s.
const props = defineProps<{ value: string | number | Date | null | undefined }>()

const now = useNow({ interval: 30_000 })
const relative = computed(() => formatRelativeTime(props.value, now.value.getTime()))
const absolute = computed(() => formatAbsoluteTime(props.value))
</script>

<template>
  <UTooltip v-if="absolute" :text="absolute">
    <time :datetime="absolute" class="whitespace-nowrap">{{ relative }}</time>
  </UTooltip>
  <span v-else class="text-dimmed">–</span>
</template>
