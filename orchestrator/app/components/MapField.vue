<script setup lang="ts">
import type { ResolvedField } from '~/utils/schema-subset'

// Map widget for `additionalProperties: <primitive schema>`; keys follow `propertyNames.pattern` when present.
const props = defineProps<{
  field: ResolvedField
  modelValue: unknown
  label: string
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: Record<string, string | number | boolean> | undefined] }>()

const keyPattern = computed(() => {
  const names = props.field.schema.propertyNames
  if (typeof names !== 'object' || names === null || typeof (names as Record<string, unknown>).pattern !== 'string') return null
  try {
    return new RegExp((names as { pattern: string }).pattern, 'u')
  } catch (error) {
    console.warn('[schema-form] propertyNames.pattern is not a valid browser regular expression', error)
    return null
  }
})

const value = computed<Record<string, string | number | boolean>>(() =>
  typeof props.modelValue === 'object' && props.modelValue !== null && !Array.isArray(props.modelValue)
    ? (props.modelValue as Record<string, string | number | boolean>)
    : {},
)

function onUpdate(next: Record<string, string | number | boolean>): void {
  emit('update:modelValue', Object.keys(next).length === 0 && props.modelValue === undefined ? undefined : next)
}
</script>

<template>
  <KeyValueEditor
    :model-value="value"
    :value-type="field.valueType ?? 'string'"
    :key-pattern="keyPattern"
    :key-hint="keyPattern ? `Keys must match ${keyPattern.source}` : undefined"
    :disabled="disabled"
    :entry-name="`${label} entry`"
    @update:model-value="onUpdate"
  />
</template>
