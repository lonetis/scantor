<script setup lang="ts">
import type { ResolvedField } from '~/utils/schema-subset'

// Raw JSON editor for a subtree outside the renderable subset (docs/ui.md §6.2). Parsed on blur; an empty text
// removes the key. The form's validator checks the parsed value.
const props = defineProps<{
  field: ResolvedField
  modelValue: unknown
  label: string
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: unknown] }>()

function serialize(value: unknown): string {
  return value === undefined ? '' : JSON.stringify(value, null, 2)
}

const text = ref(serialize(props.modelValue))
const parseError = ref<string | null>(null)
const focused = ref(false)

watch(() => props.modelValue, (value) => {
  if (!focused.value && parseError.value === null) text.value = serialize(value)
})

function commit(): void {
  focused.value = false
  if (text.value.trim() === '') {
    parseError.value = null
    emit('update:modelValue', undefined)
    return
  }
  try {
    const parsed: unknown = JSON.parse(text.value)
    parseError.value = null
    emit('update:modelValue', parsed)
  } catch (error) {
    parseError.value = error instanceof Error ? error.message : String(error)
  }
}
</script>

<template>
  <div class="space-y-1">
    <UTextarea
      v-model="text"
      :rows="Math.min(12, Math.max(3, text.split('\n').length))"
      autoresize
      class="w-full font-mono text-xs"
      spellcheck="false"
      :placeholder="field.hasDefault ? JSON.stringify(field.default) : 'JSON value'"
      :disabled="disabled"
      :aria-label="`${label} (JSON)`"
      @focus="focused = true"
      @blur="commit"
    />
    <p v-if="parseError" class="text-xs text-error">Invalid JSON: {{ parseError }}</p>
    <p v-else class="text-xs text-dimmed">Edited as JSON<template v-if="field.fallbackReason"> ({{ field.fallbackReason }})</template>.</p>
  </div>
</template>
