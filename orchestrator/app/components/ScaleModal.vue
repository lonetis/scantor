<script setup lang="ts">
import { scaleScanBody } from '#shared/schemas/scans'

// Scale a scan (docs/ui.md §5.13 "Scale"): runner workers and processes per worker within the instance limits, with
// the resulting resource totals.
const props = defineProps<{ scan: Scan, saving?: boolean }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ submit: [values: { workers?: number, processes?: number }] }>()

const { limits, loadInfo } = useInstance()
const state = reactive({ workers: props.scan.settings.workers, processes: props.scan.settings.processes })

watch(open, (isOpen) => {
  if (!isOpen) return
  state.workers = props.scan.settings.workers
  state.processes = props.scan.settings.processes
  loadInfo().catch(() => {})
})

const resources = computed(() => props.scan.settings.resources)
const perWorker = computed(() => `${formatCount(state.processes * resources.value.cpus)} CPUs, ${formatCount(state.processes * resources.value.memoryMiB + 256)} MiB memory`)

function submit(): void {
  const values: { workers?: number, processes?: number } = {}
  if (state.workers !== props.scan.settings.workers) values.workers = state.workers
  if (state.processes !== props.scan.settings.processes) values.processes = state.processes
  if (Object.keys(values).length === 0) {
    open.value = false
    return
  }
  emit('submit', values)
}
</script>

<template>
  <UModal v-model:open="open" title="Scale scan" :ui="{ content: 'sm:max-w-md' }">
    <template #body>
      <UForm id="scale-form" :schema="scaleScanBody" :state="state" class="space-y-3" @submit="submit">
        <UFormField label="Runner workers" name="workers" :hint="limits ? `1–${limits.maxWorkersPerScan}` : undefined">
          <UInputNumber v-model="state.workers" :min="1" :max="limits?.maxWorkersPerScan" class="w-full" />
        </UFormField>
        <UFormField label="Processes per worker" name="processes" :hint="limits ? `1–${limits.maxProcessesPerWorker}` : undefined">
          <UInputNumber v-model="state.processes" :min="1" :max="limits?.maxProcessesPerWorker" class="w-full" />
        </UFormField>
        <p class="text-xs text-muted tabular-nums">
          {{ formatCount(state.workers * state.processes) }} concurrent analyses; per worker {{ perWorker }}
        </p>
      </UForm>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
        <UButton type="submit" form="scale-form" label="Scale scan" :loading="saving" />
      </div>
    </template>
  </UModal>
</template>
