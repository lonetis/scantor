<script setup lang="ts">
// The scan header (docs/ui.md §5.13): name or id, the revision, state with its reason, round, privileged and
// restart markers, the owner (admins) and the lifecycle timestamps.
const props = defineProps<{ scan: Scan, ownerEmail?: string | null }>()

const REASONS: Record<string, string> = {
  user: 'by the user',
  failureRate: 'failure rate',
  schedulingFailed: 'scheduling failed',
  completed: 'all analyses finished',
  stalled: 'stalled',
  revisionUnavailable: 'revision unavailable',
  topologyReady: '',
}

const reason = computed(() => {
  const code = props.scan.stateReason?.code
  if (!code || props.scan.state === 'running' || props.scan.state === 'creating') return null
  return REASONS[code] ?? code
})
</script>

<template>
  <header class="space-y-2">
    <div class="flex flex-wrap items-center gap-2">
      <h2 class="text-lg font-semibold text-highlighted">{{ scan.name || `Scan ${shortId(scan.id)}` }}</h2>
      <IdChip :id="scan.id" copy-label="Copy scan id" />
      <StatusBadge kind="scan" :state="scan.state" :detail="reason" size="sm" />
      <UBadge v-if="scan.round > 1" :label="`round ${scan.round}`" color="neutral" variant="subtle" size="sm" />
      <UBadge v-if="scan.revision.privileged" label="privileged" color="warning" variant="subtle" size="sm" icon="i-lucide-shield-alert" />
    </div>
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
      <NuxtLink :to="`/tasks/${scan.task.id}/revisions/${scan.revision.number}`" class="font-mono hover:underline">{{ scan.revision.ref }}</NuxtLink>
      <span v-if="scan.revision.schedule.kind === 'template'">template <span class="font-mono">{{ scan.revision.schedule.template }}</span></span>
      <span v-if="scan.clonedFrom">Restarted from <NuxtLink :to="`/scans/${scan.clonedFrom}`" class="font-mono hover:underline">{{ shortId(scan.clonedFrom) }}</NuxtLink></span>
      <span v-if="ownerEmail !== undefined">Owner <span class="font-mono">{{ ownerEmail ?? shortId(scan.userId) }}</span></span>
      <span>Created <RelativeTime :value="scan.createdAt" /></span>
      <span v-if="scan.startedAt">Started <RelativeTime :value="scan.startedAt" /></span>
      <span v-if="scan.completedAt && scan.state !== 'running'">Finished <RelativeTime :value="scan.completedAt" /></span>
    </div>
    <p v-if="scan.stateReason?.message && reason && scan.stateReason.code !== 'user'" class="text-xs text-muted">{{ stripEscapes(scan.stateReason.message) }}</p>
  </header>
</template>
