<script setup lang="ts">
import { createReusableTemplate } from '@vueuse/core'
import { formBusInjectionKey } from '#ui/composables/useFormField'
import type { FormError } from '@nuxt/ui'
import type { PointerIssue } from '~/utils/json-pointer'
import type { JsonSchema } from '~/utils/schema-subset'

// JSON-Schema form for task, scan and analysis configs (docs/ui.md §6). Inside another UForm it is a nested
// form (`name` = path of its value in the parent state); standalone it is its own form. An untouched optional
// field stays absent so the server fills its default; "Edit as JSON" edits the whole value as text.

const props = withDefaults(defineProps<{
  schema: JsonSchema | null | undefined
  /** Field name prefix; server issues are read under `/<name>/…`. */
  name?: string
  /** describe's upload paths for this config (`description.uploadPaths.<config>`). */
  uploadPaths?: readonly string[]
  /** `configInvalid` issues of the whole request (JSON pointers); only this form's part is used. */
  serverIssues?: readonly PointerIssue[]
  disabled?: boolean
}>(), { name: undefined, uploadPaths: () => [], serverIssues: () => [], disabled: false })

const model = defineModel<Record<string, unknown>>({ default: () => ({}) })

const inParentForm = inject(formBusInjectionKey, undefined) !== undefined
const [DefineBody, ReuseBody] = createReusableTemplate()
const form = useTemplateRef<{ setErrors: (errors: FormError[], name?: string | RegExp) => void }>('form')

const rootSchema = computed<JsonSchema>(() => props.schema ?? true)
const { renderable, validate: validateValue } = useSchemaForm(rootSchema)
const jsonMode = ref(!renderable.value)
/** The user pressed "Edit as JSON"; JSON mode forced by a non-renderable schema does not count. */
const jsonChosen = ref(false)
const jsonText = ref('')
const jsonParseError = ref<string | null>(null)
const formLevelIssues = ref<string[]>([])

// The schema often arrives after mounting (null until describe or a fetch finishes): render its fields then,
// unless the user chose JSON or is in the middle of typing text that does not parse.
watch(renderable, (value) => {
  if (!value) jsonMode.value = true
  else if (!jsonChosen.value && !jsonParseError.value) jsonMode.value = false
})

// Field registry for mapping server issues onto the nearest rendered field.
const rendered = new Map<string, number>()
provideSchemaFormContext({
  root: rootSchema,
  uploadPaths: computed(() => props.uploadPaths),
  disabled: computed(() => props.disabled),
  register: (path) => rendered.set(path, (rendered.get(path) ?? 0) + 1),
  unregister: (path) => {
    const count = (rendered.get(path) ?? 1) - 1
    if (count <= 0) rendered.delete(path)
    else rendered.set(path, count)
  },
})

const valueObject = computed<Record<string, unknown>>(() =>
  typeof model.value === 'object' && model.value !== null && !Array.isArray(model.value) ? model.value : {},
)

function validate(): FormError[] {
  if (jsonMode.value && jsonParseError.value) return [{ name: undefined, message: `Invalid JSON: ${jsonParseError.value}` }]
  return validateValue(model.value)
}

const jsonErrors = computed(() => (jsonMode.value && !jsonParseError.value ? validateValue(model.value) : []))

function enterJsonMode(): void {
  jsonText.value = JSON.stringify(model.value ?? {}, null, 2)
  jsonParseError.value = null
  jsonMode.value = true
}

function toggleJsonMode(): void {
  if (!jsonMode.value) {
    jsonChosen.value = true
    enterJsonMode()
    return
  }
  if (jsonParseError.value || !renderable.value) return
  jsonChosen.value = false
  jsonMode.value = false
}

function onJsonInput(text: string): void {
  jsonText.value = text
  if (text.trim() === '') {
    jsonParseError.value = null
    model.value = {}
    return
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      jsonParseError.value = 'the value must be a JSON object'
      return
    }
    jsonParseError.value = null
    model.value = parsed as Record<string, unknown>
  } catch (error) {
    jsonParseError.value = error instanceof Error ? error.message : String(error)
  }
}

watch(jsonMode, (value) => {
  if (value) jsonText.value = JSON.stringify(model.value ?? {}, null, 2)
}, { immediate: true })

watch(() => props.serverIssues, async (issues) => {
  await nextTick()
  const { fieldErrors, formErrors } = mapIssuesToFields(issues, props.name, jsonMode.value ? new Set() : new Set(rendered.keys()))
  form.value?.setErrors(fieldErrors)
  formLevelIssues.value = formErrors
}, { deep: true })

function onRootUpdate(next: unknown): void {
  model.value = typeof next === 'object' && next !== null ? (next as Record<string, unknown>) : {}
}
</script>

<template>
  <DefineBody>
    <div class="flex items-center justify-end">
      <UButton
        :label="jsonMode ? 'Edit as form' : 'Edit as JSON'"
        :icon="jsonMode ? 'i-lucide-list' : 'i-lucide-braces'"
        aria-label="Edit as JSON"
        :aria-pressed="jsonMode"
        :disabled="jsonMode && (!renderable || Boolean(jsonParseError))"
        color="neutral"
        variant="ghost"
        size="xs"
        @click="toggleJsonMode"
      />
    </div>
    <UAlert v-if="formLevelIssues.length > 0" color="error" variant="subtle" icon="i-lucide-circle-alert" title="The server rejected this configuration">
      <template #description>
        <ul class="list-disc ps-4">
          <li v-for="issue in formLevelIssues" :key="issue">{{ issue }}</li>
        </ul>
      </template>
    </UAlert>
    <div v-if="jsonMode" class="space-y-1">
      <UTextarea
        :model-value="jsonText"
        :rows="Math.min(24, Math.max(6, jsonText.split('\n').length + 1))"
        autoresize
        class="w-full font-mono text-xs"
        :aria-label="`${name ?? 'Configuration'} as JSON`"
        :disabled="disabled"
        spellcheck="false"
        @update:model-value="onJsonInput(String($event ?? ''))"
      />
      <p v-if="jsonParseError" class="text-xs text-error">Invalid JSON: {{ jsonParseError }}</p>
      <p v-if="!renderable" class="text-xs text-dimmed">This schema can only be edited as JSON.</p>
      <ul v-if="jsonErrors.length > 0" class="space-y-0.5 text-xs text-error">
        <li v-for="error in jsonErrors" :key="`${error.name}:${error.message}`">
          <code>{{ error.name || '(root)' }}</code> {{ error.message }}
        </li>
      </ul>
    </div>
    <ObjectField
      v-else
      :schema="rootSchema"
      :model-value="valueObject"
      :path="[]"
      :depth="0"
      :ref-stack="[]"
      @update:model-value="onRootUpdate"
    />
  </DefineBody>

  <UForm
    v-if="inParentForm"
    ref="form"
    nested
    :name="name"
    :validate="validate"
    :disabled="disabled"
    class="space-y-3"
  >
    <ReuseBody />
  </UForm>
  <UForm
    v-else
    ref="form"
    :state="valueObject"
    :validate="validate"
    :disabled="disabled"
    class="space-y-3"
  >
    <ReuseBody />
  </UForm>
</template>
