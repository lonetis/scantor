<script setup lang="ts">
import type { PathSegment } from '~/utils/json-pointer'
import type { ResolvedField } from '~/utils/schema-subset'

// Arrays (docs/ui.md §6.2): enum items as a multi-select, primitive items as rows with add/remove, object items
// as repeated sub-sections. minItems/maxItems/uniqueItems are checked by the validator.
const props = defineProps<{
  field: ResolvedField
  modelValue: unknown
  path: PathSegment[]
  depth: number
  label: string
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: unknown[] | undefined] }>()

const items = computed<unknown[]>(() => (Array.isArray(props.modelValue) ? props.modelValue : []))
const maxItems = computed(() => (typeof props.field.schema.maxItems === 'number' ? props.field.schema.maxItems : Number.POSITIVE_INFINITY))
const itemSchema = computed(() => props.field.itemSchema ?? {})

// Stable row keys so editing one row does not re-create the others.
let nextKey = 0
const keys = ref<number[]>([])
watch(() => items.value.length, (length) => {
  while (keys.value.length < length) keys.value.push(nextKey++)
  if (keys.value.length > length) keys.value = keys.value.slice(0, length)
}, { immediate: true })

function emptyItem(): unknown {
  if (props.field.kind === 'objectArray') return {}
  switch (props.field.valueType) {
    case 'number':
    case 'integer':
      return 0
    case 'boolean':
      return false
    default:
      return ''
  }
}

function add(): void {
  keys.value = [...keys.value, nextKey++]
  emit('update:modelValue', [...items.value, emptyItem()])
}

function remove(index: number): void {
  keys.value = keys.value.filter((_, position) => position !== index)
  const next = items.value.filter((_, position) => position !== index)
  emit('update:modelValue', next.length === 0 && props.modelValue === undefined ? undefined : next)
}

function updateItem(index: number, value: unknown): void {
  const next = [...items.value]
  next[index] = value === undefined ? emptyItem() : value
  emit('update:modelValue', next)
}

// Enum arrays.
const enumItems = computed(() => props.field.options.map((option, index) => ({ label: option.label, value: String(index) })))
const enumSelection = computed(() =>
  items.value
    .map((item) => props.field.options.findIndex((option) => JSON.stringify(option.value) === JSON.stringify(item)))
    .filter((index) => index !== -1)
    .map(String),
)

function onEnumSelection(selection: unknown): void {
  const indexes = Array.isArray(selection) ? selection.map(Number) : []
  emit('update:modelValue', indexes.map((index) => props.field.options[index]?.value).filter((value) => value !== undefined))
}
</script>

<template>
  <USelectMenu
    v-if="field.kind === 'enumArray'"
    :model-value="enumSelection"
    :items="enumItems"
    value-key="value"
    multiple
    :disabled="disabled"
    :aria-label="label"
    placeholder="Select…"
    class="w-full max-w-md"
    @update:model-value="onEnumSelection"
  />

  <div v-else class="space-y-2">
    <div v-for="(item, index) in items" :key="keys[index]" class="flex items-start gap-2">
      <div class="min-w-0 flex-1" :class="field.kind === 'objectArray' ? 'rounded-md border border-default p-3' : ''">
        <p v-if="field.kind === 'objectArray'" class="section-label mb-2">Item {{ index + 1 }}</p>
        <ObjectField
          v-if="field.kind === 'objectArray'"
          :schema="itemSchema"
          :model-value="item"
          :path="[...path, index]"
          :depth="depth + 1"
          :ref-stack="field.refStack"
          @update:model-value="updateItem(index, $event)"
        />
        <SchemaField
          v-else
          :schema="itemSchema"
          :path="[...path, index]"
          :model-value="item"
          :depth="depth + 1"
          :ref-stack="field.refStack"
          :label="`${label} item ${index + 1}`"
          hide-label
          @update:model-value="updateItem(index, $event)"
        />
      </div>
      <UTooltip :text="`Remove item ${index + 1}`">
        <UButton
          icon="i-lucide-trash-2"
          color="neutral"
          variant="ghost"
          size="xs"
          class="mt-1"
          :aria-label="`Remove item ${index + 1} from ${label}`"
          :disabled="disabled"
          @click="remove(index)"
        />
      </UTooltip>
    </div>
    <p v-if="items.length === 0" class="text-xs text-dimmed">No items.</p>
    <UButton
      label="Add item"
      icon="i-lucide-plus"
      color="neutral"
      variant="outline"
      size="xs"
      :aria-label="`Add item to ${label}`"
      :disabled="disabled || items.length >= maxItems"
      @click="add"
    />
  </div>
</template>
