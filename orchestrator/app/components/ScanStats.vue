<script setup lang="ts">
// Analysis counts by status (docs/ui.md §5.13.1): one tile per status linking to the results tab filtered by it,
// with "exact as of <recountedAt>" after a recount and "live estimate" otherwise.
const props = defineProps<{ scanId: string, stats: ScanStats }>()

const TILES = [
  { status: 'pending', label: 'Pending' },
  { status: 'retrying', label: 'Retrying' },
  { status: 'succeeded', label: 'Succeeded' },
  { status: 'failed', label: 'Failed' },
  { status: 'lost', label: 'Lost' },
  { status: 'cancelled', label: 'Cancelled' },
] as const

// Literal class names, so Tailwind generates them (status colors come from utils/status.ts).
const TEXT_COLOR: Record<StatusColor, string> = {
  primary: 'text-primary',
  secondary: 'text-secondary',
  success: 'text-success',
  info: 'text-info',
  warning: 'text-warning',
  error: 'text-error',
  neutral: 'text-muted',
}

const tiles = computed(() => TILES.map((tile) => ({ ...tile, count: props.stats[tile.status], meta: statusMeta('analysis', tile.status) })))
</script>

<template>
  <section aria-labelledby="scan-stats-heading" class="space-y-2" data-testid="scan-stats">
    <div class="flex items-baseline justify-between gap-2">
      <h2 id="scan-stats-heading" class="section-label">Analyses</h2>
      <span class="text-xs text-dimmed">
        <template v-if="stats.recountedAt">exact as of <RelativeTime :value="stats.recountedAt" /></template>
        <template v-else>live estimate</template>
      </span>
    </div>
    <ul class="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
      <li v-for="tile in tiles" :key="tile.status">
        <NuxtLink
          :to="{ query: { tab: 'results', status: tile.status } }"
          class="block rounded-lg border border-default px-3 py-2 transition-colors hover:bg-elevated/60"
          :aria-label="`${formatCount(tile.count)} ${tile.label.toLowerCase()} analyses`"
        >
          <span class="flex items-center gap-1.5 text-xs text-muted">
            <UIcon :name="tile.meta.icon" class="size-3.5" :class="TEXT_COLOR[tile.meta.color]" aria-hidden="true" />
            {{ tile.label }}
          </span>
          <span class="block text-lg font-semibold text-highlighted tabular-nums">{{ formatCount(tile.count) }}</span>
        </NuxtLink>
      </li>
    </ul>
  </section>
</template>
