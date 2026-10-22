<script setup lang="ts">
// Milliseconds as "1h 02m", "1m 23s", "850 ms".
const props = defineProps<{ ms: number | null | undefined }>()
const text = computed(() => formatDuration(props.ms))
</script>

<template>
  <span class="whitespace-nowrap tabular-nums" :title="ms == null ? undefined : `${ms} ms`">{{ text }}</span>
</template>
