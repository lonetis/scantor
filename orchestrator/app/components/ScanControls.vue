<script setup lang="ts">
// Lifecycle controls of a scan (docs/ui.md §5.13 "Controls"): availability from scanActions() (the server's own
// table); a disabled control explains why in its tooltip. Retry-failed follows its job inline.
const props = defineProps<{ scan: Scan }>()
const emit = defineEmits<{ changed: [scan: Scan] }>()

const scanRef = computed(() => props.scan)
const actions = useScanActions(scanRef, { onChanged: (next) => emit('changed', next) })

const scaleOpen = ref(false)
const restartOpen = ref(false)
const exportOpen = ref(false)
const retryJobId = ref<string | null>(null)
const { job: retryJob, percent: retryPercent, settled: retrySettled } = useJob(retryJobId)

const retryable = computed(() => props.scan.stats.failed + props.scan.stats.lost > 0)

const REASONS: Record<ScanAction | 'export', string> = {
  pause: 'Only running scans can be paused',
  resume: 'Only paused scans can be resumed',
  scale: 'Only creating, running or paused scans can be scaled',
  cancel: 'Only creating, running or paused scans can be cancelled',
  retryFailed: 'Needs finished scheduling and failed or lost analyses',
  restart: 'Deleted scans cannot be restarted',
  delete: 'Only completed, failed or cancelled scans can be deleted',
  export: 'Deleted scans have no results',
}

function allowed(action: ScanAction): boolean {
  if (action === 'retryFailed') return actions.available.value.has('retryFailed') && retryable.value
  return actions.available.value.has(action)
}

const exportAllowed = computed(() => props.scan.state !== 'deleting' && props.scan.state !== 'deleted')

interface Control {
  key: ScanAction | 'export'
  label: string
  icon: string
  color: 'neutral' | 'error' | 'primary' | 'warning'
  enabled: boolean
  run: () => void
}

const controls = computed<Control[]>(() => [
  { key: 'pause', label: 'Pause scan', icon: 'i-lucide-pause', color: 'neutral', enabled: allowed('pause'), run: () => void actions.pause() },
  { key: 'resume', label: 'Resume scan', icon: 'i-lucide-play', color: 'primary', enabled: allowed('resume'), run: () => void actions.resume() },
  { key: 'scale', label: 'Scale scan', icon: 'i-lucide-scaling', color: 'neutral', enabled: allowed('scale'), run: () => (scaleOpen.value = true) },
  { key: 'cancel', label: 'Cancel scan', icon: 'i-lucide-circle-stop', color: 'error', enabled: allowed('cancel'), run: () => void actions.cancel() },
  { key: 'retryFailed', label: 'Retry failed analyses', icon: 'i-lucide-rotate-ccw', color: 'neutral', enabled: allowed('retryFailed'), run: () => void retry() },
  { key: 'restart', label: 'Restart scan', icon: 'i-lucide-refresh-cw', color: 'neutral', enabled: allowed('restart'), run: () => (restartOpen.value = true) },
  { key: 'export', label: 'Export results', icon: 'i-lucide-download', color: 'neutral', enabled: exportAllowed.value, run: () => (exportOpen.value = true) },
  { key: 'delete', label: 'Delete scan', icon: 'i-lucide-trash-2', color: 'error', enabled: allowed('delete'), run: () => void remove() },
])

async function retry(): Promise<void> {
  const result = await actions.retryFailed()
  if (result) retryJobId.value = result.job.id
}

async function remove(): Promise<void> {
  if (await actions.remove()) await navigateTo('/scans')
}

async function scale(values: { workers?: number, processes?: number }): Promise<void> {
  if (await actions.scale(values)) scaleOpen.value = false
}

async function restart(values: { name?: string, settings?: { workers?: number, processes?: number } }): Promise<void> {
  if (await actions.restart(values)) restartOpen.value = false
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Scan controls">
      <UTooltip v-for="control in controls" :key="control.key" :text="control.enabled ? control.label : REASONS[control.key]">
        <span>
          <UButton
            :label="control.label"
            :aria-label="control.label"
            :icon="control.icon"
            :color="control.color"
            variant="outline"
            size="xs"
            :disabled="!control.enabled || actions.busy.value !== null"
            :loading="actions.busy.value === control.key"
            @click="control.run()"
          />
        </span>
      </UTooltip>
    </div>

    <div v-if="retryJob && !retrySettled" class="flex items-center gap-2 text-xs text-muted" role="status">
      <StatusBadge kind="job" :state="retryJob.state" />
      <span>Retrying failed analyses</span>
      <UProgress :model-value="retryPercent" size="xs" class="w-32" :get-value-label="() => 'Retry progress'" />
      <span class="tabular-nums">{{ formatCount(retryJob.progress.done) }}<template v-if="retryJob.progress.total"> / {{ formatCount(retryJob.progress.total) }}</template></span>
    </div>
    <p v-else-if="retryJob?.state === 'failed'" class="text-xs text-error" role="alert">Retrying failed analyses failed: {{ retryJob.error?.message }}</p>

    <ScaleModal v-model:open="scaleOpen" :scan="scan" :saving="actions.busy.value === 'scale'" @submit="scale" />
    <RestartModal v-model:open="restartOpen" :scan="scan" :saving="actions.busy.value === 'restart'" @submit="restart" />
    <ExportModal v-if="exportOpen" v-model:open="exportOpen" :scan="scan" />
  </div>
</template>
