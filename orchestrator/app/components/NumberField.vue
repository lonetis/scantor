<script setup lang="ts">
import type { ResolvedField } from '~/utils/schema-subset'

// Number and integer widget: bounds from minimum/maximum, step from multipleOf (integers: 1). Exclusive bounds
// are checked by the validator. Clearing removes the key.
const props = defineProps<{
  field: ResolvedField
  modelValue: unknown
  label: string
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: number | undefined] }>()

const isInteger = computed(() => props.field.kind === 'integer')
const numberOrUndefined = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const min = computed(() => numberOrUndefined(props.field.schema.minimum))
const max = computed(() => numberOrUndefined(props.field.schema.maximum))
const step = computed(() => numberOrUndefined(props.field.schema.multipleOf) ?? (isInteger.value ? 1 : undefined))
const placeholder = computed(() => {
  const example = props.field.examples?.[0] ?? props.field.default
  return typeof example === 'number' ? String(example) : undefined
})
const formatOptions = computed<Intl.NumberFormatOptions>(() => ({
  useGrouping: false,
  maximumFractionDigits: isInteger.value ? 0 : 20,
}))
const value = computed(() => numberOrUndefined(props.modelValue) ?? null)

function onUpdate(next: number | null | undefined): void {
  emit('update:modelValue', next === null || next === undefined || Number.isNaN(next) ? undefined : next)
}
</script>

<template>
  <UInputNumber
    :model-value="value"
    :min="min"
    :max="max"
    :step="step"
    :step-snapping="step !== undefined && (isInteger || field.schema.multipleOf !== undefined)"
    :format-options="formatOptions"
    :placeholder="placeholder"
    :disabled="disabled"
    class="w-full max-w-60"
    @update:model-value="onUpdate"
  />
</template>
