<script setup lang="ts">
// Description text (template and schema descriptions, often written for Markdown) with `code` spans rendered as
// <code>; everything else stays plain text, so untrusted descriptions cannot inject markup (docs/ui.md §13).
const props = defineProps<{ text: string }>()
const parts = computed(() => splitCodeSpans(props.text))
</script>

<template>
  <span><template v-for="(part, index) in parts" :key="index"><code v-if="part.code" class="rounded bg-elevated px-1 font-mono text-[0.9em]">{{ part.text }}</code><template v-else>{{ part.text }}</template></template></span>
</template>
