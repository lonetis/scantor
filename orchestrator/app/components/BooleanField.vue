<script setup lang="ts">
import type { ResolvedField } from '~/utils/schema-subset'

// Boolean widget. An absent value shows the schema default; toggling stores an explicit value.
const props = defineProps<{
  field: ResolvedField
  modelValue: unknown
  label: string
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const checked = computed(() => (typeof props.modelValue === 'boolean' ? props.modelValue : props.field.default === true))
</script>

<template>
  <USwitch
    :model-value="checked"
    :disabled="disabled"
    :label="modelValue === undefined ? (checked ? 'on (default)' : 'off (default)') : (checked ? 'on' : 'off')"
    :aria-label="label"
    @update:model-value="emit('update:modelValue', Boolean($event))"
  />
</template>
