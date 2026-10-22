<script setup lang="ts">
// Scan progress (docs/ui.md §5.13.1): a bar (indeterminate while the total is unknown), terminal / total analyses,
// the scheduled count with the scheduling state, the completion rate and the ETA. `compact` is the table variant.
const props = withDefaults(defineProps<{
  progress: ScanProgress
  ratePerMin?: number
  scheduling?: Pick<Scheduling, 'state' | 'confirmed'> | null
  /** accessible name of the bar */
  label?: string
  compact?: boolean
}>(), { ratePerMin: 0, scheduling: null, label: 'Scan progress', compact: false })

const summary = computed(() => {
  const { terminal, total, percent } = props.progress
  if (total === null) return `${formatCount(terminal)} analyses`
  return `${formatCount(terminal)} / ${formatCount(total)} analyses (${formatPercent(percent)})`
})
const compactSummary = computed(() => {
  const { terminal, total, percent } = props.progress
  return total === null ? formatCount(terminal) : `${formatCount(terminal)} / ${formatCount(total)} · ${formatPercent(percent)}`
})
const eta = computed(() => formatEta(props.progress.etaSeconds))
</script>

<template>
  <div v-if="compact" class="flex min-w-44 items-center gap-2">
    <UProgress :model-value="progress.percent" size="xs" class="w-20 shrink-0" :get-value-label="() => label" :get-value-text="() => summary" />
    <span class="text-xs text-muted tabular-nums">{{ compactSummary }}</span>
  </div>
  <div v-else class="space-y-2" data-testid="scan-progress">
    <UProgress :model-value="progress.percent" size="sm" :get-value-label="() => label" :get-value-text="() => summary" />
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm tabular-nums">
      <span class="font-medium text-highlighted">{{ summary }}</span>
      <span v-if="scheduling" class="inline-flex items-center gap-1.5 text-muted">
        {{ formatCount(scheduling.confirmed) }} scheduled
        <StatusBadge kind="scheduling" :state="scheduling.state" />
      </span>
      <span class="text-muted">{{ formatRate(ratePerMin) }}</span>
      <span v-if="eta" class="text-muted">{{ eta }}</span>
    </div>
  </div>
</template>
