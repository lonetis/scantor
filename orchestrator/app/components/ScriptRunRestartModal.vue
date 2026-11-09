<script setup lang="ts">
import type { PointerIssue } from '~/utils/json-pointer'

// "Run again" and "Resume" of a script run: a new run of the script's current folder with the same scans, secrets and
// settings; the config and the sample limit are prefilled from the run and can be changed. With `resume` the new run
// receives the checkpoint and the outputs of this one.
const props = defineProps<{
  run: ScriptRun
  /** the run's script, for its config schema (null while it loads or when it is gone) */
  script: Script | null
  resume: boolean
}>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ restarted: [run: ScriptRun] }>()

const actions = useScriptRunActions()
const config = ref<Record<string, unknown>>({})
const limit = ref<number | null | undefined>(null)
const saving = ref(false)
const issues = ref<PointerIssue[]>([])
const problem = ref<string | null>(null)

const configSchema = computed(() => currentConfigSchema(props.script))
const title = computed(() => (props.resume ? 'Resume script run' : 'Run script again'))
const confirmLabel = computed(() => (props.resume ? 'Resume' : 'Run again'))
const formState = computed(() => ({ config: config.value, limit: limit.value }))

watch(open, (isOpen) => {
  if (!isOpen) return
  config.value = structuredClone(props.run.input.config)
  limit.value = props.run.input.settings.limit
  issues.value = []
  problem.value = null
}, { immediate: true })

async function submit(): Promise<void> {
  saving.value = true
  issues.value = []
  problem.value = null
  try {
    const configChanged = JSON.stringify(config.value) !== JSON.stringify(props.run.input.config)
    // A cleared input reports undefined: no limit.
    const newLimit = typeof limit.value === 'number' && Number.isFinite(limit.value) ? limit.value : null
    const limitChanged = newLimit !== props.run.input.settings.limit
    const restarted = await actions.restartRun(props.run.id, {
      resume: props.resume,
      ...(configChanged ? { config: config.value } : {}),
      ...(limitChanged ? { settings: { limit: newLimit } } : {}),
    })
    open.value = false
    emit('restarted', restarted)
  } catch (cause) {
    const error = toApiError(cause)
    if (error.code === 'configInvalid') issues.value = errorIssues(error)
    problem.value = error.code === 'configInvalid' ? 'The config does not match the script\'s config schema.' : error.message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="title"
    description="Starts a new run of the script's current code on the same scans, with the same secrets and settings."
    :ui="{ content: 'sm:max-w-xl' }"
    :content="dialogContent"
  >
    <template #close="{ ui }">
      <CloseButton :class="ui.close()" />
    </template>
    <template #body>
      <UForm id="script-run-restart-form" :state="formState" class="space-y-4" :aria-label="title" @submit="submit">
        <UAlert
          v-if="resume"
          color="info"
          variant="subtle"
          icon="i-lucide-info"
          title="The new run continues from this run's checkpoint"
          description="It receives the checkpoint and the stored output files of this run."
        />
        <div class="space-y-1" data-config-issues>
          <p class="section-label">Config</p>
          <SchemaForm v-model="config" :schema="configSchema" name="config" :server-issues="issues" :disabled="saving" />
        </div>
        <UFormField label="Sample limit" name="limit" help="Analyses per stream; empty runs on all analyses.">
          <NumberInput v-model="limit" :min="1" placeholder="all" class="w-40" />
        </UFormField>
        <UAlert v-if="problem" color="error" variant="subtle" icon="i-lucide-circle-alert" title="The run could not start" :description="problem" />
      </UForm>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
        <UButton type="submit" form="script-run-restart-form" :label="confirmLabel" :icon="resume ? 'i-lucide-step-forward' : 'i-lucide-rotate-ccw'" :loading="saving" />
      </div>
    </template>
  </UModal>
</template>
