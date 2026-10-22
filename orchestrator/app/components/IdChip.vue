<script setup lang="ts">
// A shortened id or hash (8 characters, mono) with the full value as tooltip and a copy button.
const props = withDefaults(defineProps<{
  id: string
  length?: number
  copyLabel?: string
  copyable?: boolean
}>(), { length: 8, copyLabel: 'Copy to clipboard', copyable: true })

const short = computed(() => shortId(props.id, props.length))
</script>

<template>
  <span class="inline-flex items-center gap-0.5 align-middle">
    <UTooltip :text="id">
      <code class="font-mono text-xs text-muted" :data-id="id">{{ short }}</code>
    </UTooltip>
    <CopyButton v-if="copyable" :value="id" :label="copyLabel" />
  </span>
</template>
