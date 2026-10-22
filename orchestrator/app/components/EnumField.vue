<script setup lang="ts">
import type { ResolvedField } from '~/utils/schema-subset'

// Enum widget: `enum` values or titled `const` options (docs/ui.md §6.2). At most four options on a required
// field render as a radio group, otherwise a select. Option values travel as indexes, so non-string enum values
// (numbers, booleans) keep their JSON type.
const props = defineProps<{
  field: ResolvedField
  modelValue: unknown
  label: string
  required?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: unknown] }>()

const items = computed(() => props.field.options.map((option, index) => ({ label: option.label, value: String(index) })))
const asRadio = computed(() => props.required === true && items.value.length <= 4)

function indexOf(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const serialized = JSON.stringify(value)
  const index = props.field.options.findIndex((option) => JSON.stringify(option.value) === serialized)
  return index === -1 ? undefined : String(index)
}

const selected = computed(() => indexOf(props.modelValue))
// A radio group shows the default as selected while the value is absent.
const radioValue = computed(() => selected.value ?? (props.field.hasDefault ? indexOf(props.field.default) : undefined))
const placeholder = computed(() => {
  const defaultIndex = props.field.hasDefault ? indexOf(props.field.default) : undefined
  return defaultIndex === undefined ? 'Select…' : `default: ${props.field.options[Number(defaultIndex)]!.label}`
})

function onSelect(value: unknown): void {
  const option = props.field.options[Number(value)]
  emit('update:modelValue', option ? option.value : undefined)
}
</script>

<template>
  <URadioGroup
    v-if="asRadio"
    :model-value="radioValue"
    :items="items"
    orientation="horizontal"
    :disabled="disabled"
    :aria-label="label"
    @update:model-value="onSelect"
  />
  <USelect
    v-else
    :model-value="selected"
    :items="items"
    :placeholder="placeholder"
    :disabled="disabled"
    :aria-label="label"
    class="w-full max-w-sm"
    @update:model-value="onSelect"
  />
</template>
