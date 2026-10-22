<script setup lang="ts">
import { restartScanBody } from '#shared/schemas/scans'

// Restart a scan (docs/ui.md §5.13 "Restart"): a new scan with the same revision, configs (secrets are copied on the
// server) and settings; name, workers and processes can be changed.
const props = defineProps<{ scan: Scan | ScanSummary, saving?: boolean }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ submit: [values: { name?: string, settings?: { workers?: number, processes?: number } }] }>()

const { limits, loadInfo } = useInstance()
const state = reactive({ name: '', workers: 1, processes: 1 })

function defaultName(): string {
  return `${props.scan.name || `Scan ${shortId(props.scan.id)}`} (restart)`.slice(0, 100)
}

watch(open, (isOpen) => {
  if (!isOpen) return
  state.name = defaultName()
  state.workers = props.scan.settings.workers
  state.processes = props.scan.settings.processes
  loadInfo().catch(() => {})
}, { immediate: true })

const formState = computed(() => ({ name: state.name.trim() || undefined, settings: { workers: state.workers, processes: state.processes } }))

function submit(): void {
  const settings: { workers?: number, processes?: number } = {}
  if (state.workers !== props.scan.settings.workers) settings.workers = state.workers
  if (state.processes !== props.scan.settings.processes) settings.processes = state.processes
  emit('submit', {
    ...(state.name.trim() ? { name: state.name.trim() } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  })
}
</script>

<template>
  <UModal v-model:open="open" title="Restart scan" description="Creates a new scan of the same revision with the same configuration." :ui="{ content: 'sm:max-w-md' }">
    <template #body>
      <UForm id="restart-form" :schema="restartScanBody" :state="formState" class="space-y-3" @submit="submit">
        <UFormField label="Name" name="name" hint="at most 100 characters">
          <UInput v-model="state.name" :maxlength="100" class="w-full" />
        </UFormField>
        <UFormField label="Runner workers" name="settings.workers" :hint="limits ? `1–${limits.maxWorkersPerScan}` : undefined">
          <UInputNumber v-model="state.workers" :min="1" :max="limits?.maxWorkersPerScan" class="w-full" />
        </UFormField>
        <UFormField label="Processes per worker" name="settings.processes" :hint="limits ? `1–${limits.maxProcessesPerWorker}` : undefined">
          <UInputNumber v-model="state.processes" :min="1" :max="limits?.maxProcessesPerWorker" class="w-full" />
        </UFormField>
      </UForm>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
        <UButton type="submit" form="restart-form" label="Restart scan" :loading="saving" />
      </div>
    </template>
  </UModal>
</template>
