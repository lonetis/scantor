<script setup lang="ts">
import type { PathSegment } from '~/utils/json-pointer'
import type { JsonSchema } from '~/utils/schema-subset'

// The properties of an object schema as a field group. Nested objects below depth 1 are collapsible
// (docs/ui.md §6.2). Untouched optional properties stay absent from the value.

const props = withDefaults(defineProps<{
  schema: JsonSchema
  modelValue: unknown
  path: PathSegment[]
  depth: number
  refStack: string[]
  collapsible?: boolean
  title?: string
  /** Properties not to render (the discriminator of a union branch). */
  omit?: readonly string[]
}>(), { collapsible: false, title: undefined, omit: () => [] })

const emit = defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>()

const context = useSchemaFormContext()

const resolved = computed(() => {
  const deref = dereference(props.schema, context.root.value, props.refStack)
  return { schema: isSchemaObject(deref.schema) ? deref.schema : {}, refStack: deref.refStack }
})

const properties = computed(() => objectProperties(resolved.value.schema).filter((property) => !props.omit.includes(property.name)))

const value = computed<Record<string, unknown>>(() =>
  typeof props.modelValue === 'object' && props.modelValue !== null && !Array.isArray(props.modelValue)
    ? (props.modelValue as Record<string, unknown>)
    : {},
)

const open = ref(true)

function updateProperty(key: string, next: unknown): void {
  const { [key]: _previous, ...rest } = value.value
  emit('update:modelValue', next === undefined ? rest : { ...rest, [key]: next })
}
</script>

<template>
  <div v-if="properties.length === 0" class="text-xs text-dimmed">No options.</div>
  <UCollapsible v-else-if="collapsible" v-model:open="open">
    <UButton
      :label="open ? `Hide ${title ?? 'fields'}` : `Show ${title ?? 'fields'}`"
      :icon="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
      color="neutral"
      variant="link"
      size="xs"
      class="px-0"
    />
    <template #content>
      <div class="mt-2 space-y-4">
        <SchemaField
          v-for="property in properties"
          :key="property.name"
          :schema="property.schema"
          :path="[...path, property.name]"
          :model-value="value[property.name]"
          :required="property.required"
          :depth="depth + 1"
          :ref-stack="resolved.refStack"
          @update:model-value="updateProperty(property.name, $event)"
        />
      </div>
    </template>
  </UCollapsible>
  <div v-else class="space-y-4">
    <SchemaField
      v-for="property in properties"
      :key="property.name"
      :schema="property.schema"
      :path="[...path, property.name]"
      :model-value="value[property.name]"
      :required="property.required"
      :depth="depth + 1"
      :ref-stack="resolved.refStack"
      @update:model-value="updateProperty(property.name, $event)"
    />
  </div>
</template>
