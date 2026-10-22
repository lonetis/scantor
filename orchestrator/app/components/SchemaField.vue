<script setup lang="ts">
import type { PathSegment } from '~/utils/json-pointer'
import type { JsonSchema } from '~/utils/schema-subset'

// Dispatcher of the JSON-Schema form (docs/ui.md §6.2): classifies one schema node and renders its widget in a
// UFormField whose name is the field's dot path, plus the shared affordances (null checkbox, default hint,
// Reset, deprecated badge). Emitting `undefined` removes the key from the parent value.

const props = withDefaults(defineProps<{
  schema: JsonSchema
  path: PathSegment[]
  modelValue: unknown
  required?: boolean
  depth: number
  refStack: string[]
  /** Overrides the label (array items). */
  label?: string
  hideLabel?: boolean
}>(), { required: false, label: undefined, hideLabel: false })

const emit = defineEmits<{ 'update:modelValue': [value: unknown] }>()

const context = useSchemaFormContext()
const name = useRegisteredPath(() => props.path)

const field = computed(() => {
  const resolved = resolveField(props.schema, { root: context.root.value, depth: props.depth, refStack: props.refStack })
  const isUploadPath = context.uploadPaths.value.includes(wildcardPointer(props.path))
  return isUploadPath && (resolved.kind === 'string' || resolved.kind === 'secret') ? { ...resolved, kind: 'upload' as const } : resolved
})

const lastSegment = computed(() => props.path.at(-1))
const labelText = computed(() => props.label ?? field.value.title ?? (lastSegment.value === undefined ? '' : String(lastSegment.value)))
const disabled = computed(() => context.disabled.value || field.value.readOnly)
const isNull = computed(() => field.value.nullable && props.modelValue === null)
const isSet = computed(() => props.modelValue !== undefined)

const defaultText = computed(() => {
  if (!field.value.hasDefault || field.value.writeOnly) return null
  const value = field.value.default
  return typeof value === 'string' ? value : JSON.stringify(value)
})

const hint = computed(() => (defaultText.value !== null ? `default: ${defaultText.value}` : undefined))

const isContainer = computed(() => ['object', 'objectArray', 'union', 'map'].includes(field.value.kind))

function update(value: unknown): void {
  if (field.value.readOnly) return
  emit('update:modelValue', value)
}

function setNull(checked: boolean | 'indeterminate'): void {
  update(checked === true ? null : undefined)
}
</script>

<template>
  <UFormField
    :name="name"
    :label="hideLabel ? undefined : labelText"
    :description="hideLabel ? undefined : field.description"
    :hint="hideLabel ? undefined : hint"
    :required="required"
    :ui="{ root: isContainer ? 'rounded-md border border-default p-3' : undefined, label: 'text-sm' }"
    :data-field-path="name"
  >
    <template v-if="!hideLabel && field.description" #description>
      <InlineCodeText :text="field.description" />
    </template>
    <template v-if="!hideLabel" #label>
      <span class="inline-flex flex-wrap items-center gap-1.5">
        <span>{{ labelText }}</span>
        <UBadge v-if="field.deprecated" label="deprecated" color="warning" variant="subtle" size="xs" />
        <UBadge v-if="field.writeOnly" label="secret" color="neutral" variant="subtle" size="xs" icon="i-lucide-lock" />
        <UBadge v-if="field.readOnly" label="read-only" color="neutral" variant="subtle" size="xs" />
      </span>
    </template>

    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1">
        <p v-if="isNull" class="py-1 font-mono text-xs text-muted">null</p>
        <template v-else>
          <ObjectField
            v-if="field.kind === 'object'"
            :schema="field.schema"
            :model-value="modelValue"
            :path="path"
            :depth="depth"
            :ref-stack="field.refStack"
            :collapsible="depth >= 2"
            :title="labelText"
            @update:model-value="update"
          />
          <MapField
            v-else-if="field.kind === 'map'"
            :field="field"
            :model-value="modelValue"
            :label="labelText"
            :disabled="disabled"
            @update:model-value="update"
          />
          <StringField
            v-else-if="field.kind === 'string' || field.kind === 'secret'"
            :field="field"
            :model-value="modelValue"
            :label="labelText"
            :disabled="disabled"
            @update:model-value="update"
          />
          <UploadField
            v-else-if="field.kind === 'upload'"
            :field="field"
            :model-value="modelValue"
            :label="labelText"
            :disabled="disabled"
            @update:model-value="update"
          />
          <EnumField
            v-else-if="field.kind === 'enum'"
            :field="field"
            :model-value="modelValue"
            :label="labelText"
            :required="required"
            :disabled="disabled"
            @update:model-value="update"
          />
          <NumberField
            v-else-if="field.kind === 'number' || field.kind === 'integer'"
            :field="field"
            :model-value="modelValue"
            :label="labelText"
            :disabled="disabled"
            @update:model-value="update"
          />
          <BooleanField
            v-else-if="field.kind === 'boolean'"
            :field="field"
            :model-value="modelValue"
            :label="labelText"
            :disabled="disabled"
            @update:model-value="update"
          />
          <ArrayField
            v-else-if="field.kind === 'array' || field.kind === 'enumArray' || field.kind === 'objectArray'"
            :field="field"
            :model-value="modelValue"
            :path="path"
            :depth="depth"
            :label="labelText"
            :disabled="disabled"
            @update:model-value="update"
          />
          <UnionField
            v-else-if="field.kind === 'union'"
            :field="field"
            :model-value="modelValue"
            :path="path"
            :depth="depth"
            :label="labelText"
            :disabled="disabled"
            @update:model-value="update"
          />
          <p v-else-if="field.kind === 'const'" class="py-1 font-mono text-xs text-muted">
            {{ JSON.stringify(field.schema.const) }}
          </p>
          <JsonField
            v-else
            :field="field"
            :model-value="modelValue"
            :label="labelText"
            :disabled="disabled"
            @update:model-value="update"
          />
        </template>
      </div>

      <div v-if="!field.readOnly && (field.nullable || (isSet && field.hasDefault))" class="flex shrink-0 items-center gap-1 pt-1">
        <UCheckbox
          v-if="field.nullable"
          :model-value="isNull"
          label="null"
          :aria-label="`Set ${labelText} to null`"
          size="sm"
          :disabled="disabled"
          @update:model-value="setNull"
        />
        <UTooltip v-if="isSet && field.hasDefault" :text="`Reset ${labelText} to its default`">
          <UButton
            icon="i-lucide-rotate-ccw"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="`Reset ${labelText}`"
            :disabled="disabled"
            @click="update(undefined)"
          />
        </UTooltip>
      </div>
    </div>
  </UFormField>
</template>
