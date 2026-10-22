<script setup lang="ts">
import type { ResolvedField } from '~/utils/schema-subset'

// String widget (docs/ui.md §6.2): the input type follows `format`, long strings get a textarea, writeOnly
// strings are password inputs with a reveal button and are never prefilled. Clearing removes the key.
const props = defineProps<{
  field: ResolvedField
  modelValue: unknown
  label: string
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string | undefined] }>()

const revealed = ref(false)
const isSecret = computed(() => props.field.kind === 'secret')
const maxLength = computed(() => (typeof props.field.schema.maxLength === 'number' ? props.field.schema.maxLength : null))
const multiline = computed(() => !isSecret.value && maxLength.value !== null && maxLength.value > 256)

const inputType = computed(() => {
  if (isSecret.value) return revealed.value ? 'text' : 'password'
  switch (props.field.schema.format) {
    case 'uri':
      return 'url'
    case 'email':
      return 'email'
    case 'date':
      return 'date'
    case 'date-time':
      return 'datetime-local'
    default:
      return 'text'
  }
})

const placeholder = computed(() => {
  const example = props.field.examples?.[0]
  if (typeof example === 'string') return example
  if (!isSecret.value && typeof props.field.default === 'string') return props.field.default
  return undefined
})

const text = computed(() => (typeof props.modelValue === 'string' ? props.modelValue : ''))

function onInput(value: unknown): void {
  const next = value === null || value === undefined ? '' : String(value)
  emit('update:modelValue', next === '' ? undefined : next)
}
</script>

<template>
  <UTextarea
    v-if="multiline"
    :model-value="text"
    :placeholder="placeholder"
    :maxlength="maxLength ?? undefined"
    :disabled="disabled"
    autoresize
    :rows="3"
    class="w-full"
    @update:model-value="onInput"
  />
  <UInput
    v-else
    :model-value="text"
    :type="inputType"
    :placeholder="placeholder"
    :maxlength="maxLength ?? undefined"
    :disabled="disabled"
    :autocomplete="isSecret ? 'new-password' : 'off'"
    class="w-full"
    :ui="isSecret ? { trailing: 'pe-1' } : undefined"
    @update:model-value="onInput"
  >
    <template v-if="isSecret" #trailing>
      <UTooltip :text="revealed ? 'Hide value' : 'Show value'">
        <UButton
          color="neutral"
          variant="link"
          size="sm"
          :icon="revealed ? 'i-lucide-eye-off' : 'i-lucide-eye'"
          :aria-label="revealed ? `Hide value of ${label}` : `Show value of ${label}`"
          :aria-pressed="revealed"
          @click="revealed = !revealed"
        />
      </UTooltip>
    </template>
  </UInput>
</template>
