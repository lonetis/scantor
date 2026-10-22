<script setup lang="ts">
// Icon-only copy button; the accessible name doubles as tooltip (docs/ui.md §11).
withDefaults(defineProps<{
  value: string
  label?: string
  size?: 'xs' | 'sm' | 'md'
}>(), { label: 'Copy to clipboard', size: 'xs' })

const { copy } = useCopy()
const done = ref(false)
let resetTimer: ReturnType<typeof setTimeout> | undefined

async function onClick(value: string): Promise<void> {
  if (!(await copy(value))) return
  done.value = true
  clearTimeout(resetTimer)
  resetTimer = setTimeout(() => (done.value = false), 1500)
}

onBeforeUnmount(() => clearTimeout(resetTimer))
</script>

<template>
  <UTooltip :text="label">
    <UButton
      :icon="done ? 'i-lucide-check' : 'i-lucide-copy'"
      color="neutral"
      variant="ghost"
      :size="size"
      :aria-label="label"
      @click.stop="onClick(value)"
    />
  </UTooltip>
</template>
