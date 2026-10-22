<script setup lang="ts">
import type { PathSegment } from '~/utils/json-pointer'
import type { ResolvedField } from '~/utils/schema-subset'

// Discriminated unions (docs/ui.md §6.2): a select over the discriminator values, then the chosen branch's
// fields. Switching branches keeps only the discriminator.
const props = defineProps<{
  field: ResolvedField
  modelValue: unknown
  path: PathSegment[]
  depth: number
  label: string
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: Record<string, unknown> | undefined] }>()

const discriminator = computed(() => props.field.discriminator ?? '')
const branches = computed(() => props.field.branches ?? [])
const value = computed<Record<string, unknown>>(() =>
  typeof props.modelValue === 'object' && props.modelValue !== null && !Array.isArray(props.modelValue)
    ? (props.modelValue as Record<string, unknown>)
    : {},
)

const selectedIndex = computed(() => {
  if (props.modelValue === undefined) return -1
  return branches.value.findIndex((branch) => branch.value === value.value[discriminator.value])
})
const selectedBranch = computed(() => branches.value[selectedIndex.value] ?? null)
const items = computed(() => branches.value.map((branch, index) => ({ label: branch.label, value: String(index) })))

const defaultBranchLabel = computed(() => {
  const fallback = props.field.default as Record<string, unknown> | undefined
  const branch = fallback ? branches.value.find((candidate) => candidate.value === fallback[discriminator.value]) : undefined
  return branch ? `default: ${branch.label}` : 'Select…'
})

function selectBranch(index: unknown): void {
  const branch = branches.value[Number(index)]
  if (!branch) return
  if (selectedBranch.value?.value === branch.value) return
  emit('update:modelValue', { [discriminator.value]: branch.value })
}

function updateBranch(next: Record<string, unknown>): void {
  if (!selectedBranch.value) return
  emit('update:modelValue', { ...next, [discriminator.value]: selectedBranch.value.value })
}
</script>

<template>
  <div class="space-y-3">
    <USelect
      :model-value="selectedIndex === -1 ? undefined : String(selectedIndex)"
      :items="items"
      :placeholder="defaultBranchLabel"
      :disabled="disabled"
      :aria-label="`${label}: ${discriminator}`"
      class="w-full max-w-sm"
      @update:model-value="selectBranch"
    />
    <ObjectField
      v-if="selectedBranch"
      :schema="selectedBranch.schema"
      :model-value="value"
      :path="path"
      :depth="depth"
      :ref-stack="field.refStack"
      :omit="[discriminator]"
      @update:model-value="updateBranch"
    />
  </div>
</template>
