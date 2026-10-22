<script setup lang="ts">
// Monospace text block with an optional copy button and line numbers. Content is always plain text.
const props = withDefaults(defineProps<{
  code: string
  lineNumbers?: boolean
  copyable?: boolean
  copyLabel?: string
  wrap?: boolean
  /** Accessible label of the block (for example the snippet's purpose). */
  label?: string
}>(), { lineNumbers: false, copyable: true, copyLabel: 'Copy to clipboard', wrap: false, label: undefined })

const lines = computed(() => props.code.replace(/\n$/, '').split('\n'))
const gutterWidth = computed(() => `${String(lines.value.length).length + 1}ch`)
</script>

<template>
  <div class="code-surface group relative rounded-md" :aria-label="label" :role="label ? 'region' : undefined">
    <div v-if="copyable" class="absolute end-1 top-1 opacity-70 group-hover:opacity-100">
      <CopyButton :value="code" :label="copyLabel" />
    </div>
    <pre
      class="overflow-x-auto px-3 py-2"
      :class="[wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre', copyable ? 'pe-9' : '']"
    ><code v-if="!lineNumbers">{{ code }}</code><code v-else class="grid" :style="{ gridTemplateColumns: `${gutterWidth} minmax(0, 1fr)` }"><template v-for="(line, index) in lines" :key="index"><span class="select-none pe-3 text-end text-[var(--code-line-number)]" aria-hidden="true">{{ index + 1 }}</span><span>{{ line || ' ' }}</span></template></code></pre>
  </div>
</template>
