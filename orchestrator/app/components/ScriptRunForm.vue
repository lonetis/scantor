<script setup lang="ts">
import type { FormSubmitEvent } from '@nuxt/ui'
import {
  SCRIPT_RUN_MAX_CPUS,
  SCRIPT_RUN_MAX_MEMORY_MIB,
  SCRIPT_RUN_MAX_TIMEOUT_MS,
  SCRIPT_RUN_MIN_MEMORY_MIB,
  SCRIPT_RUN_MIN_TIMEOUT_MS,
  startScriptRunBody,
} from '#shared/schemas/scripts'
import type { PointerIssue } from '~/utils/json-pointer'

// The run form of a script: scans (searched by name, prefilled by `?scan=`), the config (a JSON-Schema form while the
// schema the code reported belongs to the folder's current code, JSON otherwise), secrets (never stored), timeout and
// resources (empty = the manifest defaults), then "Try on 100 analyses" (`settings.limit`) or "Run on all". The server
// stays authoritative: a 422 configInvalid lands on the config fields, other errors in a form-level alert.
const props = withDefaults(defineProps<{
  script: Script
  /** scan ids to preselect (`?scan=`) */
  initialScans?: readonly string[]
}>(), { initialScans: () => [] })
const emit = defineEmits<{ started: [run: ScriptRun] }>()

type Mode = 'sample' | 'all'

const actions = useScriptRunActions()

const state = reactive<{
  scans: string[]
  config: Record<string, unknown>
  secrets: Record<string, string>
  timeoutSeconds: number | null
  cpus: number | null
  memoryMiB: number | null
}>({ scans: [], config: {}, secrets: {}, timeoutSeconds: null, cpus: null, memoryMiB: null })

const mode = ref<Mode>('sample')
const submitting = ref<Mode | null>(null)
const issues = ref<PointerIssue[]>([])
const formError = ref<{ title: string; description: string; details?: string[] } | null>(null)

// The polled script arrives as a new object every few seconds: the form keeps its schema object while the schema stays
// the same, so the fields are not rebuilt under the user's typing.
const configSchema = shallowRef<Record<string, unknown> | null>(null)
watch(() => JSON.stringify(currentConfigSchema(props.script)), () => {
  configSchema.value = currentConfigSchema(props.script)
}, { immediate: true })
const describeStale = computed(() => props.script.describe !== null && configSchema.value === null && props.script.describe.configSchema !== null)

function settingsFor(target: Mode) {
  return scriptRunSettingsBody(
    { timeoutSeconds: state.timeoutSeconds, cpus: state.cpus, memoryMiB: state.memoryMiB },
    target === 'sample' ? SCRIPT_RUN_SAMPLE_LIMIT : null,
  )
}

/** The request body the form validates and sends. */
function bodyFor(target: Mode) {
  const settings = settingsFor(target)
  return {
    scans: state.scans,
    config: state.config,
    ...(Object.keys(state.secrets).length > 0 ? { secrets: state.secrets } : {}),
    ...(settings ? { settings } : {}),
  }
}
const formState = computed(() => bodyFor(mode.value))

const FORM_LEVEL_TITLES: Record<string, string> = {
  notFound: 'A selected scan or the script was not found',
  validationFailed: 'Check the run settings',
  confirmationRequired: 'The run needs a confirmation',
  tooManyRequests: 'Too many requests',
}

function onFormError(event: { errors: { name?: string; message: string }[] }): void {
  const first = event.errors[0]
  if (first) formError.value = { title: 'Check the highlighted fields', description: first.name ? `${first.name}: ${first.message}` : first.message }
}

async function submit(_event: FormSubmitEvent<unknown>): Promise<void> {
  if (submitting.value) return
  const target = mode.value
  submitting.value = target
  issues.value = []
  formError.value = null
  try {
    const run = await actions.startRun(props.script.id, bodyFor(target))
    state.secrets = {}
    emit('started', run)
  } catch (cause) {
    const error = toApiError(cause)
    if (error.code === 'configInvalid') {
      issues.value = errorIssues(error)
      await nextTick()
      document.querySelector('[data-config-issues] [aria-invalid="true"], [data-config-issues] [role="alert"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    } else {
      const details = errorIssues(error).map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
      formError.value = { title: FORM_LEVEL_TITLES[error.code] ?? errorTitle(error.code), description: error.message, ...(details.length > 0 ? { details } : {}) }
    }
  } finally {
    submitting.value = null
  }
}
</script>

<template>
  <UForm
    :schema="startScriptRunBody"
    :state="formState"
    class="space-y-5"
    aria-label="Script run inputs"
    data-testid="script-run-form"
    @submit="submit"
    @error="onFormError"
  >
    <section aria-labelledby="script-run-scans" class="space-y-2">
      <h3 id="script-run-scans" class="section-label">Scans</h3>
      <UFormField name="scans" required help="The scans whose results and files the script reads.">
        <ScriptScanPicker v-model="state.scans" :owner="script.userId" :initial="initialScans" :disabled="submitting !== null" />
      </UFormField>
    </section>

    <section aria-labelledby="script-run-config" class="space-y-2" data-config-issues>
      <h3 id="script-run-config" class="section-label">Config</h3>
      <UAlert
        v-if="!configSchema"
        color="neutral"
        variant="subtle"
        icon="i-lucide-info"
        :title="describeStale ? 'The code changed since its config schema was reported' : 'No config schema known yet'"
        description="Enter the config as JSON. The form fields appear after a run of the current code has reported its schema."
      />
      <SchemaForm v-model="state.config" :schema="configSchema" name="config" :server-issues="issues" :disabled="submitting !== null" />
    </section>

    <section aria-labelledby="script-run-secrets" class="space-y-2">
      <h3 id="script-run-secrets" class="section-label">Secrets</h3>
      <p class="text-xs text-dimmed">The script reads them as <code>ctx.secrets</code>. They are stored encrypted with the run and never shown again.</p>
      <UFormField name="secrets">
        <ScriptSecretsField v-model="state.secrets" :disabled="submitting !== null" />
      </UFormField>
    </section>

    <section aria-labelledby="script-run-settings" class="space-y-2">
      <h3 id="script-run-settings" class="section-label">Timeout and resources</h3>
      <p class="text-xs text-dimmed">Empty fields use the defaults of <code>scantor-script.yaml</code>.</p>
      <div class="flex flex-wrap gap-3">
        <UFormField label="Timeout (s)" name="settings.timeoutMs" :hint="`${SCRIPT_RUN_MIN_TIMEOUT_MS / 1000}–${SCRIPT_RUN_MAX_TIMEOUT_MS / 1000}`">
          <NumberInput v-model="state.timeoutSeconds" :min="SCRIPT_RUN_MIN_TIMEOUT_MS / 1000" :max="SCRIPT_RUN_MAX_TIMEOUT_MS / 1000" placeholder="default" class="w-36" />
        </UFormField>
        <UFormField label="CPUs" name="settings.resources.cpus">
          <NumberInput v-model="state.cpus" :min="0.1" :max="SCRIPT_RUN_MAX_CPUS" :step="0.1" placeholder="default" class="w-32" />
        </UFormField>
        <UFormField label="Memory (MiB)" name="settings.resources.memoryMiB" :hint="`≥ ${SCRIPT_RUN_MIN_MEMORY_MIB}`">
          <NumberInput v-model="state.memoryMiB" :min="SCRIPT_RUN_MIN_MEMORY_MIB" :max="SCRIPT_RUN_MAX_MEMORY_MIB" :step="256" placeholder="default" class="w-36" />
        </UFormField>
      </div>
    </section>

    <UAlert v-if="formError" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="formError.title" :description="formError.description">
      <template v-if="formError.details" #description>
        <p>{{ formError.description }}</p>
        <ul class="mt-1 list-disc ps-4">
          <li v-for="detail in formError.details" :key="detail">{{ detail }}</li>
        </ul>
      </template>
    </UAlert>

    <div class="flex flex-wrap items-center gap-2">
      <UButton
        type="submit"
        :label="`Try on ${SCRIPT_RUN_SAMPLE_LIMIT} analyses`"
        icon="i-lucide-flask-conical"
        color="neutral"
        variant="outline"
        :loading="submitting === 'sample'"
        :disabled="submitting !== null"
        @click="mode = 'sample'"
      />
      <UButton
        type="submit"
        label="Run on all"
        icon="i-lucide-play"
        :loading="submitting === 'all'"
        :disabled="submitting !== null"
        @click="mode = 'all'"
      />
      <span class="text-xs text-dimmed">A sample run stops every analysis stream after {{ SCRIPT_RUN_SAMPLE_LIMIT }} analyses.</span>
    </div>
  </UForm>
</template>
