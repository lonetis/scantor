<script setup lang="ts">
// Bytes in binary units ("1.5 GiB"); the exact count is the tooltip.
const props = defineProps<{ bytes: number | null | undefined }>()
const text = computed(() => formatBytes(props.bytes))
</script>

<template>
  <span class="whitespace-nowrap tabular-nums" :title="bytes == null ? undefined : `${formatCount(bytes)} bytes`">{{ text }}</span>
</template>
