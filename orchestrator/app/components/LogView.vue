<script setup lang="ts">
// Log text with ANSI sequences stripped (docs/security.md HDR-5), a follow toggle that keeps the view at the
// bottom while new lines arrive, and a wrap toggle.
const props = withDefaults(defineProps<{
  text?: string
  lines?: readonly string[]
  /** Highlights lines that start with one of these prefixes as errors. */
  errorPattern?: RegExp | null
  maxHeightClass?: string
  testid?: string
  emptyText?: string
}>(), { text: undefined, lines: undefined, errorPattern: null, maxHeightClass: 'max-h-96', testid: undefined, emptyText: 'No output.' })

const container = useTemplateRef<HTMLElement>('container')
const wrap = ref(true)

const displayLines = computed(() => {
  if (props.lines) return props.lines.flatMap((line) => (line === '' ? [''] : toLogLines(line)))
  return toLogLines(props.text ?? '')
})

const { follow, onScroll, toggleFollow } = useFollowScroll(container, () => displayLines.value.length)
</script>

<template>
  <div class="code-surface relative rounded-md" :data-testid="testid">
    <div class="absolute end-1 top-1 z-10 flex items-center gap-0.5 rounded bg-[var(--code-bg)]/80">
      <UTooltip text="Wrap lines">
        <UButton
          icon="i-lucide-wrap-text"
          size="xs"
          color="neutral"
          :variant="wrap ? 'soft' : 'ghost'"
          aria-label="Wrap lines"
          :aria-pressed="wrap"
          @click="wrap = !wrap"
        />
      </UTooltip>
      <UTooltip text="Follow log">
        <UButton
          icon="i-lucide-arrow-down-to-line"
          size="xs"
          color="neutral"
          :variant="follow ? 'soft' : 'ghost'"
          aria-label="Follow log"
          :aria-pressed="follow"
          @click="toggleFollow"
        />
      </UTooltip>
    </div>
    <div ref="container" class="overflow-auto px-3 py-2 pe-16" :class="maxHeightClass" @scroll.passive="onScroll">
      <p v-if="displayLines.length === 0" class="text-[var(--code-dimmed)]">{{ emptyText }}</p>
      <div
        v-for="(line, index) in displayLines"
        :key="index"
        :class="[
          wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre',
          errorPattern && errorPattern.test(line) ? 'bg-[var(--code-error-bg)] text-[var(--code-error)]' : '',
        ]"
      >{{ line || ' ' }}</div>
    </div>
  </div>
</template>
