<script setup lang="ts">
// The expected number of analyses of a template scan (docs/ui.md §5.12 step 7): "≈ N analyses" or "exactly N",
// "unknown" without an estimate, an error above the instance maximum; custom schedules learn it while scheduling.
withDefaults(defineProps<{
  scheduleKind: ScheduleKind
  estimate?: TemplateEstimate | null
  loading?: boolean
  error?: string | null
}>(), { estimate: null, loading: false, error: null })
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 text-sm" role="status" aria-live="polite">
    <template v-if="scheduleKind === 'custom'">
      <UIcon name="i-lucide-info" class="size-4 text-muted" aria-hidden="true" />
      <span class="text-muted">The number of analyses is known after scheduling starts.</span>
    </template>
    <template v-else-if="loading">
      <UIcon name="i-lucide-loader-circle" class="size-4 text-muted motion-safe:animate-spin" aria-hidden="true" />
      <span class="text-muted">Estimating…</span>
    </template>
    <template v-else-if="error">
      <UIcon name="i-lucide-circle-alert" class="size-4 text-error" aria-hidden="true" />
      <span class="text-error">{{ error }}</span>
    </template>
    <template v-else-if="estimate">
      <UBadge
        :label="estimate.expectedTotal === null ? 'unknown number of analyses' : `${estimate.exact ? 'exactly' : '≈'} ${formatCount(estimate.expectedTotal)} analyses`"
        :color="estimate.tooLarge ? 'error' : estimate.confirmationRequired ? 'warning' : 'neutral'"
        variant="subtle"
        size="md"
        icon="i-lucide-sigma"
      />
      <span v-if="estimate.tooLarge" class="text-error">Above the instance maximum</span>
      <span v-else-if="estimate.confirmationRequired" class="text-warning">Large scan: confirmation required</span>
    </template>
    <span v-else class="text-muted">The estimate appears once the scan config is valid.</span>
  </div>
</template>
