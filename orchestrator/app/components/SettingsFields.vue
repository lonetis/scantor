<script setup lang="ts">
import { NODE_LABEL_KEY_PATTERN } from '#shared/utils/slug'

// Scan settings of the new-scan form (docs/ui.md §5.12 steps 5–6): workers and processes with the resulting
// resources, and the advanced limits. Field names follow the request body (`settings.<field>`), so the form's zod
// errors land on them; the form sends only the fields that differ from the revision defaults.
defineProps<{ limits: InstanceLimits | null }>()
const settings = defineModel<Omit<ScanSettings, 'privileged'>>({ required: true })

const timeoutSeconds = computed({
  get: () => Math.round(settings.value.timeoutMs / 1000),
  set: (seconds: number | null | undefined) => (settings.value.timeoutMs = Math.round((seconds ?? 0) * 1000)),
})

const totals = computed(() => {
  const { workers, processes, resources } = settings.value
  return {
    concurrent: workers * processes,
    cpus: Math.round(processes * resources.cpus * 100) / 100,
    memoryMiB: processes * resources.memoryMiB + 256,
  }
})

const labels = computed({
  get: () => settings.value.nodeSelector.labels as Record<string, string | number | boolean>,
  set: (value: Record<string, string | number | boolean>) => {
    settings.value.nodeSelector.labels = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]))
  },
})
const advancedOpen = ref(false)
</script>

<template>
  <div class="space-y-3">
    <div class="grid gap-3 sm:grid-cols-2">
      <UFormField label="Runner workers" name="settings.workers" :hint="limits ? `1–${limits.maxWorkersPerScan}` : undefined">
        <NumberInput v-model="settings.workers" :min="1" :max="limits?.maxWorkersPerScan" class="w-full" />
      </UFormField>
      <UFormField label="Processes per worker" name="settings.processes" :hint="limits ? `1–${limits.maxProcessesPerWorker}` : undefined">
        <NumberInput v-model="settings.processes" :min="1" :max="limits?.maxProcessesPerWorker" class="w-full" />
      </UFormField>
    </div>
    <p class="text-xs text-muted tabular-nums">
      Total: {{ plural(settings.workers, 'runner worker') }} × {{ plural(settings.processes, 'process', 'processes') }} = {{ plural(totals.concurrent, 'concurrent analysis', 'concurrent analyses') }};
      per worker: {{ totals.cpus }} CPUs, {{ formatCount(totals.memoryMiB) }} MiB memory
    </p>

    <UCollapsible v-model:open="advancedOpen">
      <UButton
        label="Advanced settings"
        :trailing-icon="advancedOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        color="neutral"
        variant="ghost"
        size="xs"
        class="px-0"
      />
      <template #content>
        <div class="grid gap-3 pt-2 sm:grid-cols-2 xl:grid-cols-3">
          <UFormField label="Timeout per analysis (seconds)" name="settings.timeoutMs" hint="1–86400">
            <NumberInput v-model="timeoutSeconds" :min="1" :max="86400" class="w-full" />
          </UFormField>
          <UFormField label="Attempts per analysis" name="settings.maxAttempts" hint="1–20">
            <NumberInput v-model="settings.maxAttempts" :min="1" :max="20" class="w-full" />
          </UFormField>
          <UFormField label="Analyses per process before recycling" name="settings.maxAnalysesPerProcess">
            <NumberInput v-model="settings.maxAnalysesPerProcess" :min="1" :max="1000000" class="w-full" />
          </UFormField>
          <UFormField label="Backoff: first delay (ms)" name="settings.backoff.initialMs">
            <NumberInput v-model="settings.backoff.initialMs" :min="1000" :max="86400000" :step="1000" class="w-full" />
          </UFormField>
          <UFormField label="Backoff: factor" name="settings.backoff.factor" hint="1–10">
            <NumberInput v-model="settings.backoff.factor" :min="1" :max="10" :step="0.5" class="w-full" />
          </UFormField>
          <UFormField label="Backoff: longest delay (ms)" name="settings.backoff.maxMs">
            <NumberInput v-model="settings.backoff.maxMs" :min="1000" :max="86400000" :step="1000" class="w-full" />
          </UFormField>
          <UFormField label="Backoff jitter" name="settings.backoff.jitter">
            <USwitch v-model="settings.backoff.jitter" label="Randomize retry delays" />
          </UFormField>
          <UFormField label="CPUs per process" name="settings.resources.cpus" hint="0.1–64">
            <NumberInput v-model="settings.resources.cpus" :min="0.1" :max="64" :step="0.1" class="w-full" />
          </UFormField>
          <UFormField label="Memory per process (MiB)" name="settings.resources.memoryMiB" hint="64–65536">
            <NumberInput v-model="settings.resources.memoryMiB" :min="64" :max="65536" :step="64" class="w-full" />
          </UFormField>
          <UFormField label="Node pool" name="settings.nodeSelector.pool">
            <UInput v-model="settings.nodeSelector.pool" class="w-full font-mono" />
          </UFormField>
          <UFormField label="Node labels" name="settings.nodeSelector.labels" class="sm:col-span-2" hint="nodes must carry all of them">
            <KeyValueEditor v-model="labels" :key-pattern="NODE_LABEL_KEY_PATTERN" :max-entries="16" entry-name="label" />
          </UFormField>
        </div>
      </template>
    </UCollapsible>
  </div>
</template>
