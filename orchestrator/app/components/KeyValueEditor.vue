<script setup lang="ts">
// Editor for string-keyed maps (node labels, node selector labels, map-typed config fields). Rows keep their
// order while keys are edited; the model only contains rows with a non-empty key.
type MapValue = string | number | boolean

const props = withDefaults(defineProps<{
  valueType?: 'string' | 'number' | 'integer' | 'boolean'
  keyPattern?: RegExp | null
  keyHint?: string
  maxEntries?: number
  keyPlaceholder?: string
  valuePlaceholder?: string
  disabled?: boolean
  /** Prefix of the accessible names, for example "label". */
  entryName?: string
}>(), {
  valueType: 'string',
  keyPattern: null,
  keyHint: undefined,
  maxEntries: 64,
  keyPlaceholder: 'key',
  valuePlaceholder: 'value',
  disabled: false,
  entryName: 'entry',
})

const model = defineModel<Record<string, MapValue>>({ default: () => ({}) })

interface Row {
  id: number
  key: string
  value: MapValue | null
}

let nextId = 0
const rows = ref<Row[]>([])

function defaultValue(): MapValue | null {
  return props.valueType === 'boolean' ? false : props.valueType === 'string' ? '' : null
}

function rowsFromModel(value: Record<string, MapValue>): Row[] {
  return Object.entries(value).map(([key, entry]) => ({ id: nextId++, key, value: entry }))
}

function modelFromRows(): Record<string, MapValue> {
  const result: Record<string, MapValue> = {}
  for (const row of rows.value) {
    const key = row.key.trim()
    if (key && row.value !== null && !Object.hasOwn(result, key)) result[key] = row.value
  }
  return result
}

watch(model, (value) => {
  if (JSON.stringify(value ?? {}) !== JSON.stringify(modelFromRows())) rows.value = rowsFromModel(value ?? {})
}, { immediate: true, deep: true })

function sync(): void {
  model.value = modelFromRows()
}

function addRow(): void {
  rows.value = [...rows.value, { id: nextId++, key: '', value: defaultValue() }]
}

function removeRow(id: number): void {
  rows.value = rows.value.filter((row) => row.id !== id)
  sync()
}

function setKey(row: Row, key: string): void {
  row.key = key
  sync()
}

function setValue(row: Row, value: MapValue | null | undefined): void {
  row.value = value ?? defaultValue()
  sync()
}

function keyProblem(row: Row): string | null {
  const key = row.key.trim()
  if (!key) return row.value !== null && row.value !== '' ? 'Key is required' : null
  if (rows.value.filter((other) => other.key.trim() === key).length > 1) return 'Duplicate key'
  if (props.keyPattern && !props.keyPattern.test(key)) return props.keyHint ?? 'Invalid key'
  return null
}

function rowName(row: Row, index: number): string {
  return row.key.trim() || `${props.entryName} ${index + 1}`
}
</script>

<template>
  <div class="space-y-1.5">
    <div v-for="(row, index) in rows" :key="row.id" class="space-y-0.5">
      <div class="flex items-center gap-1.5">
        <UInput
          :model-value="row.key"
          :placeholder="keyPlaceholder"
          :aria-label="`Key of ${entryName} ${index + 1}`"
          :disabled="disabled"
          size="sm"
          class="w-2/5 font-mono"
          :color="keyProblem(row) ? 'error' : undefined"
          :highlight="Boolean(keyProblem(row))"
          @update:model-value="setKey(row, String($event ?? ''))"
        />
        <USwitch
          v-if="valueType === 'boolean'"
          :model-value="Boolean(row.value)"
          :aria-label="`Value of ${rowName(row, index)}`"
          :disabled="disabled"
          @update:model-value="setValue(row, $event)"
        />
        <UInputNumber
          v-else-if="valueType === 'number' || valueType === 'integer'"
          :model-value="typeof row.value === 'number' ? row.value : null"
          :step="valueType === 'integer' ? 1 : undefined"
          :aria-label="`Value of ${rowName(row, index)}`"
          :disabled="disabled"
          size="sm"
          class="flex-1"
          @update:model-value="setValue(row, $event ?? null)"
        />
        <UInput
          v-else
          :model-value="String(row.value ?? '')"
          :placeholder="valuePlaceholder"
          :aria-label="`Value of ${rowName(row, index)}`"
          :disabled="disabled"
          size="sm"
          class="flex-1"
          @update:model-value="setValue(row, String($event ?? ''))"
        />
        <UTooltip :text="`Remove ${rowName(row, index)}`">
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="`Remove ${rowName(row, index)}`"
            :disabled="disabled"
            @click="removeRow(row.id)"
          />
        </UTooltip>
      </div>
      <p v-if="keyProblem(row)" class="text-xs text-error">{{ keyProblem(row) }}</p>
    </div>
    <UButton
      :label="`Add ${entryName}`"
      icon="i-lucide-plus"
      color="neutral"
      variant="link"
      size="xs"
      :disabled="disabled || rows.length >= maxEntries"
      @click="addRow"
    />
  </div>
</template>
