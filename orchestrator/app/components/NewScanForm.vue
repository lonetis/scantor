<script setup lang="ts">
import { useDebounceFn } from '@vueuse/core'
import { startScanBody } from '#shared/schemas/scans'
import type { PointerIssue } from '~/utils/json-pointer'

// The new-scan form (docs/ui.md §5.12): revision, name, task and scan config (JSON-Schema forms), scaling and limits,
// the estimate with its confirmation for template schedules, then startScan. Static parts validate with
// startScanBody, configs in the browser with the revision's schemas; the server stays authoritative and its
// 422 configInvalid issues land on the config fields.
const props = defineProps<{ initialRevision?: string | null }>()

const ESTIMATE_DEBOUNCE_MS = 500
/** The request's settings: ScanSettings without `privileged` (copied from the revision by the server). */
type SettingsInput = Omit<ScanSettings, 'privileged'>
const FALLBACK_SETTINGS: SettingsInput = {
  workers: 1,
  processes: 1,
  timeoutMs: 300_000,
  maxAttempts: 3,
  backoff: { initialMs: 5000, factor: 2, maxMs: 600_000, jitter: true },
  resources: { cpus: 1, memoryMiB: 512 },
  maxAnalysesPerProcess: 1000,
  nodeSelector: { pool: 'shared', labels: {} },
}

const api = useApi()
const { limits, loadInfo } = useInstance()
const picker = useTemplateRef<{ blocked: boolean }>('picker')

const revision = shallowRef<Revision | null>(null)
const state = reactive<{
  revision: string
  name: string | undefined
  taskConfig: Record<string, unknown>
  scanConfig: Record<string, unknown>
  settings: SettingsInput
  confirm: boolean
}>({ revision: '', name: undefined, taskConfig: {}, scanConfig: {}, settings: structuredClone(FALLBACK_SETTINGS), confirm: false })

const issues = ref<PointerIssue[]>([])
const formError = ref<{ title: string, description: string } | null>(null)
const submitting = ref(false)

const estimate = shallowRef<TemplateEstimate | null>(null)
const estimating = ref(false)
const estimateError = ref<string | null>(null)
/** expectedTotal of a confirmationRequired answer of startScan (the estimate changed meanwhile) */
const confirmTotal = ref<number | null>(null)

const description = computed(() => revision.value?.description ?? null)
const scheduleKind = computed<ScheduleKind>(() => description.value?.schedule.kind ?? 'custom')
const defaults = computed<SettingsInput>(() => {
  const { privileged: _privileged, ...revisionDefaults } = structuredClone(revision.value?.settingsDefaults ?? { privileged: false })
  return { ...structuredClone(FALLBACK_SETTINGS), ...revisionDefaults, nodeSelector: { pool: 'shared', labels: {} } }
})

const nameModel = computed({
  get: () => state.name ?? '',
  set: (value: string) => (state.name = value.trim() === '' ? undefined : value),
})

function onRevision(next: Revision | null): void {
  revision.value = next
  state.revision = next?.id ?? ''
  state.taskConfig = {}
  state.scanConfig = {}
  state.settings = structuredClone(defaults.value)
  state.confirm = false
  issues.value = []
  formError.value = null
  estimate.value = null
  estimateError.value = null
  confirmTotal.value = null
}

// ── estimate (template schedules) ─────────────────────────────────────────────

async function runEstimate(): Promise<void> {
  const current = description.value
  if (!current || current.schedule.kind !== 'template' || !current.schedule.template) return
  if (validateAgainstSchema(current.schemas.scanConfig, state.scanConfig).length > 0) {
    estimate.value = null
    estimateError.value = null
    return
  }
  estimating.value = true
  const requested = JSON.stringify(state.scanConfig)
  try {
    const result = await api<TemplateEstimate>(`/api/templates/${encodeURIComponent(current.schedule.template)}/estimate`, {
      method: 'POST',
      body: { scanConfig: state.scanConfig },
      toast: false,
    })
    if (requested !== JSON.stringify(state.scanConfig)) return
    estimate.value = result
    estimateError.value = null
    if (!result.confirmationRequired) state.confirm = false
  } catch (cause) {
    const error = toApiError(cause)
    estimate.value = null
    const first = errorIssues(error)[0]
    estimateError.value = first ? `${first.path || 'scan config'}: ${first.message}` : error.message
  } finally {
    estimating.value = false
  }
}

const scheduleEstimate = useDebounceFn(() => void runEstimate(), ESTIMATE_DEBOUNCE_MS)
watch([() => JSON.stringify(state.scanConfig), () => revision.value?.id], () => {
  if (scheduleKind.value === 'template') scheduleEstimate()
})

const needsConfirmation = computed(() => estimate.value?.confirmationRequired === true || confirmTotal.value !== null)
const confirmCount = computed(() => confirmTotal.value ?? estimate.value?.expectedTotal ?? null)
const confirmLabel = computed(() => `I want to start about ${confirmCount.value === null ? 'this many' : formatCount(confirmCount.value)} analyses`)

const blocked = computed(() => picker.value?.blocked === true)
const canStart = computed(
  () => revision.value !== null && !blocked.value && estimate.value?.tooLarge !== true && (!needsConfirmation.value || state.confirm) && !submitting.value,
)

// ── submit ───────────────────────────────────────────────────────────────────

/** Settings that differ from the revision's defaults (docs/ui.md §5.12 step 6). */
function changedSettings(): Record<string, unknown> | undefined {
  const base = defaults.value
  const current = state.settings
  const result: Record<string, unknown> = {}
  for (const key of ['workers', 'processes', 'timeoutMs', 'maxAttempts', 'maxAnalysesPerProcess'] as const) {
    if (current[key] !== base[key]) result[key] = current[key]
  }
  const backoff = Object.fromEntries(Object.entries(current.backoff).filter(([key, value]) => base.backoff[key as keyof Backoff] !== value))
  if (Object.keys(backoff).length > 0) result.backoff = backoff
  const resources = Object.fromEntries(Object.entries(current.resources).filter(([key, value]) => base.resources[key as keyof ProcessResources] !== value))
  if (Object.keys(resources).length > 0) result.resources = resources
  const nodeSelector: Record<string, unknown> = {}
  if (current.nodeSelector.pool !== base.nodeSelector.pool) nodeSelector.pool = current.nodeSelector.pool
  if (Object.keys(current.nodeSelector.labels).length > 0) nodeSelector.labels = current.nodeSelector.labels
  if (Object.keys(nodeSelector).length > 0) result.nodeSelector = nodeSelector
  return Object.keys(result).length > 0 ? result : undefined
}

const FORM_LEVEL_TITLES: Record<string, string> = {
  scanTooLarge: 'The scan is too large',
  privilegedNotAllowed: 'Privileged revisions need permission',
  revisionNotReady: 'The revision is not ready',
  brokerAlarm: 'The message broker is out of resources',
}

/** Validation errors without a visible field still need to be seen. */
function onFormError(event: { errors: { name?: string, message: string }[] }): void {
  const first = event.errors[0]
  if (first) formError.value = { title: 'Check the highlighted fields', description: first.name ? `${first.name}: ${first.message}` : first.message }
}

async function submit(): Promise<void> {
  if (!canStart.value) return
  submitting.value = true
  issues.value = []
  formError.value = null
  try {
    const settings = changedSettings()
    const scan = await api<Scan>('/api/scans', {
      method: 'POST',
      toast: false,
      body: {
        revision: state.revision,
        ...(state.name ? { name: state.name.trim() } : {}),
        taskConfig: state.taskConfig,
        scanConfig: state.scanConfig,
        ...(settings ? { settings } : {}),
        ...(needsConfirmation.value ? { confirm: state.confirm } : {}),
      },
    })
    await navigateTo(`/scans/${scan.id}`)
  } catch (cause) {
    const error = toApiError(cause)
    if (error.code === 'configInvalid') {
      issues.value = errorIssues(error)
      await nextTick()
      document.querySelector('[data-config-issues] [aria-invalid="true"], [data-config-issues] [role="alert"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    } else if (error.code === 'confirmationRequired') {
      confirmTotal.value = typeof error.details.expectedTotal === 'number' ? error.details.expectedTotal : null
      state.confirm = false
    } else {
      formError.value = { title: FORM_LEVEL_TITLES[error.code] ?? errorTitle(error.code), description: error.message }
    }
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  loadInfo().catch(() => {})
})
</script>

<template>
  <UForm :schema="startScanBody" :state="state" class="space-y-6" @submit="submit" @error="onFormError">
    <section aria-labelledby="new-scan-revision" class="space-y-2">
      <h2 id="new-scan-revision" class="section-label">1 · Revision</h2>
      <RevisionPicker ref="picker" :initial-ref="props.initialRevision ?? null" @change="onRevision" />
    </section>

    <template v-if="revision && description">
      <section aria-labelledby="new-scan-name" class="space-y-2">
        <h2 id="new-scan-name" class="section-label">2 · Name</h2>
        <UFormField label="Name" name="name" hint="optional, at most 100 characters">
          <UInput v-model="nameModel" :maxlength="100" placeholder="for example: tranco top 100k" class="w-full sm:max-w-md" />
        </UFormField>
      </section>

      <section aria-labelledby="new-scan-task-config" class="space-y-2" data-config-issues>
        <h2 id="new-scan-task-config" class="section-label">3 · Task config</h2>
        <SchemaForm
          v-model="state.taskConfig"
          :schema="description.schemas.taskConfig"
          name="taskConfig"
          :upload-paths="description.uploadPaths.taskConfig"
          :server-issues="issues"
        />
      </section>

      <section aria-labelledby="new-scan-scan-config" class="space-y-2" data-config-issues>
        <h2 id="new-scan-scan-config" class="section-label">4 · Scan config</h2>
        <SchemaForm
          v-model="state.scanConfig"
          :schema="description.schemas.scanConfig"
          name="scanConfig"
          :upload-paths="description.uploadPaths.scanConfig"
          :server-issues="issues"
        />
      </section>

      <section aria-labelledby="new-scan-scaling" class="space-y-2">
        <h2 id="new-scan-scaling" class="section-label">5 · Scaling and limits</h2>
        <SettingsFields v-model="state.settings" :limits="limits" />
      </section>

      <section aria-labelledby="new-scan-estimate" class="space-y-2">
        <h2 id="new-scan-estimate" class="section-label">6 · Size</h2>
        <EstimateBadge :schedule-kind="scheduleKind" :estimate="estimate" :loading="estimating" :error="estimateError" />
        <UFormField v-if="needsConfirmation" name="confirm">
          <UCheckbox v-model="state.confirm" :label="confirmLabel" :aria-label="confirmLabel" required />
        </UFormField>
      </section>

      <UAlert v-if="formError" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="formError.title" :description="formError.description" />

      <div class="flex flex-wrap items-center gap-3 border-t border-default pt-4">
        <UButton type="submit" label="Start scan" aria-label="Start scan" icon="i-lucide-play" :loading="submitting" :disabled="!canStart" />
        <span class="text-xs text-muted tabular-nums">
          {{ revision.ref }} · {{ state.settings.workers }} × {{ state.settings.processes }}
          <template v-if="estimate?.expectedTotal != null"> · {{ estimate.exact ? '' : '≈ ' }}{{ formatCount(estimate.expectedTotal) }} analyses</template>
        </span>
      </div>
    </template>
  </UForm>
</template>
