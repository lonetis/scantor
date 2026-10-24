<script setup lang="ts">
// Effective settings, configs and template resolutions of a scan (docs/ui.md §5.13.1). Secret config values arrive
// masked ("***") and render as a lock.
const props = defineProps<{ scan: Scan }>()

const settings = computed(() => {
  const value = props.scan.settings
  const labels = Object.entries(value.nodeSelector.labels).map(([key, label]) => `${key}=${label}`)
  return [
    ['Workers', formatCount(value.workers)],
    ['Processes per worker', formatCount(value.processes)],
    ['Timeout per analysis', formatDuration(value.timeoutMs)],
    ['Attempts', formatCount(value.maxAttempts)],
    ['Backoff', `${formatDuration(value.backoff.initialMs)} × ${value.backoff.factor}, at most ${formatDuration(value.backoff.maxMs)}${value.backoff.jitter ? ', jitter' : ''}`],
    ['Resources per process', `${value.resources.cpus} CPU, ${formatCount(value.resources.memoryMiB)} MiB`],
    ['Analyses per process', formatCount(value.maxAnalysesPerProcess)],
    ['Node pool', value.nodeSelector.pool],
    ['Node labels', labels.length > 0 ? labels.join(', ') : '–'],
    ['Privileged', value.privileged ? 'yes (Docker-in-Docker)' : 'no'],
  ] as const
})

const resolutions = computed(() => Object.entries(props.scan.scheduling.resolved))

function provenanceEntries(provenance: Record<string, unknown>): [string, string][] {
  return Object.entries(provenance).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)])
}
</script>

<template>
  <section aria-labelledby="scan-settings-heading" class="space-y-3">
    <h2 id="scan-settings-heading" class="section-label">Settings and configuration</h2>
    <div class="grid gap-4 xl:grid-cols-3">
      <dl class="grid grid-cols-[auto_1fr] content-start gap-x-4 gap-y-1 rounded-lg border border-default p-3 text-sm">
        <template v-for="[label, value] in settings" :key="label">
          <dt class="text-muted">{{ label }}</dt>
          <dd class="tabular-nums">{{ value }}</dd>
        </template>
      </dl>
      <div class="space-y-1">
        <h3 class="text-xs font-medium text-muted">Task config</h3>
        <JsonView :value="scan.taskConfig" path="taskConfig" />
      </div>
      <div class="space-y-1">
        <h3 class="text-xs font-medium text-muted">Scan config</h3>
        <JsonView :value="scan.scanConfig" path="scanConfig" />
      </div>
    </div>

    <div v-if="resolutions.length > 0" class="space-y-2">
      <h3 class="text-xs font-medium text-muted">Template resolutions</h3>
      <div v-for="[key, resolution] in resolutions" :key="key" class="space-y-2 rounded-lg border border-default p-3">
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <span class="font-mono text-xs text-dimmed">{{ key }}</span>
          <span class="font-mono">{{ resolution.template }}</span>
          <span v-if="resolution.expectedTotal !== null" class="text-xs text-muted">{{ formatCount(resolution.expectedTotal) }} analyses expected</span>
          <span class="ms-auto text-xs text-dimmed">resolved <RelativeTime :value="resolution.at" /></span>
        </div>
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <template v-for="[name, value] in provenanceEntries(resolution.provenance)" :key="name">
            <dt class="text-muted">{{ name }}</dt>
            <dd class="break-all font-mono">{{ value }}</dd>
          </template>
        </dl>
        <JsonView :value="resolution.scanConfig" :path="`resolved.${key}.scanConfig`" :collapsed-depth="1" />
      </div>
    </div>

    <UAlert
      v-if="scan.scheduling.error"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-x"
      title="Scheduling failed"
      :description="`${scan.scheduling.error.type} in ${scan.scheduling.error.phase}: ${stripEscapes(scan.scheduling.error.message)}`"
    />
  </section>
</template>
