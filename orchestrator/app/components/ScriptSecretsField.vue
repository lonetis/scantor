<script setup lang="ts">
import { SCRIPT_RUN_MAX_SECRETS, SCRIPT_SECRET_NAME_PATTERN } from '#shared/schemas/scripts'

// Secrets of a script run (`ctx.secrets`): name and value rows, values in password inputs with a reveal button. The
// values live only in this form: they are sent with the start request, never stored in the UI prefs and never shown
// again (the API returns only the names).
const props = withDefaults(defineProps<{ disabled?: boolean }>(), { disabled: false })
const model = defineModel<Record<string, string>>({ default: () => ({}) })

interface Row {
  id: number
  name: string
  value: string
  revealed: boolean
}

let nextId = 0
const rows = ref<Row[]>([])

function modelFromRows(): Record<string, string> {
  const result: Record<string, string> = {}
  for (const row of rows.value) {
    const name = row.name.trim()
    if (name && !Object.hasOwn(result, name)) result[name] = row.value
  }
  return result
}

// The parent resets the model after a start; rows follow it then (they never come from stored data).
watch(model, (value) => {
  if (JSON.stringify(value ?? {}) !== JSON.stringify(modelFromRows())) {
    rows.value = Object.entries(value ?? {}).map(([name, secret]) => ({ id: nextId++, name, value: secret, revealed: false }))
  }
}, { immediate: true, deep: true })

function sync(): void {
  model.value = modelFromRows()
}

function addRow(): void {
  rows.value = [...rows.value, { id: nextId++, name: '', value: '', revealed: false }]
}

function removeRow(id: number): void {
  rows.value = rows.value.filter((row) => row.id !== id)
  sync()
}

function setName(row: Row, name: string): void {
  row.name = name.toUpperCase()
  sync()
}

function setValue(row: Row, value: string): void {
  row.value = value
  sync()
}

function nameProblem(row: Row): string | null {
  const name = row.name.trim()
  if (!name) return row.value !== '' ? 'Name is required' : null
  if (rows.value.filter((other) => other.name.trim() === name).length > 1) return 'Duplicate name'
  if (!SCRIPT_SECRET_NAME_PATTERN.test(name)) return 'Use an uppercase name such as API_TOKEN'
  return null
}

function rowName(row: Row, index: number): string {
  return row.name.trim() || `secret ${index + 1}`
}
</script>

<template>
  <div class="space-y-1.5">
    <div v-for="(row, index) in rows" :key="row.id" class="space-y-0.5">
      <div class="flex items-center gap-1.5">
        <UInput
          :model-value="row.name"
          placeholder="API_TOKEN"
          :aria-label="`Name of secret ${index + 1}`"
          :disabled="props.disabled"
          autocomplete="off"
          size="sm"
          class="w-2/5 font-mono"
          :color="nameProblem(row) ? 'error' : undefined"
          :highlight="Boolean(nameProblem(row))"
          @update:model-value="setName(row, String($event ?? ''))"
        />
        <UInput
          :model-value="row.value"
          :type="row.revealed ? 'text' : 'password'"
          placeholder="value"
          :aria-label="`Value of ${rowName(row, index)}`"
          :disabled="props.disabled"
          autocomplete="new-password"
          size="sm"
          class="flex-1 font-mono"
          @update:model-value="setValue(row, String($event ?? ''))"
        />
        <UTooltip :text="`${row.revealed ? 'Hide value of' : 'Show value of'} ${rowName(row, index)}`">
          <UButton
            :icon="row.revealed ? 'i-lucide-eye-off' : 'i-lucide-eye'"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="`${row.revealed ? 'Hide value of' : 'Show value of'} ${rowName(row, index)}`"
            :aria-pressed="row.revealed"
            @click="row.revealed = !row.revealed"
          />
        </UTooltip>
        <UTooltip :text="`Remove ${rowName(row, index)}`">
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="`Remove ${rowName(row, index)}`"
            :disabled="props.disabled"
            @click="removeRow(row.id)"
          />
        </UTooltip>
      </div>
      <p v-if="nameProblem(row)" class="text-xs text-error">{{ nameProblem(row) }}</p>
    </div>
    <UButton
      label="Add secret"
      icon="i-lucide-plus"
      color="neutral"
      variant="link"
      size="xs"
      :disabled="props.disabled || rows.length >= SCRIPT_RUN_MAX_SECRETS"
      @click="addRow"
    />
  </div>
</template>
