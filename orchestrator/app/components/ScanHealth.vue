<script setup lang="ts">
// The conditions panel of a scan (docs/ui.md §5.13.1): "Healthy" without conditions, otherwise one item per
// condition, most severe first.
const props = defineProps<{ scanId: string, conditions: Condition[], canResume?: boolean }>()
defineEmits<{ resume: [] }>()

const sorted = computed(() => [...props.conditions].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.type.localeCompare(b.type)))
</script>

<template>
  <section aria-labelledby="scan-health-heading" class="space-y-2" data-testid="scan-health">
    <h2 id="scan-health-heading" class="section-label">Health</h2>
    <p v-if="sorted.length === 0" class="flex items-center gap-1.5 rounded-lg border border-default px-3 py-2 text-sm">
      <UIcon name="i-lucide-circle-check" class="size-4 text-success" aria-hidden="true" />
      Healthy
    </p>
    <ul v-else class="divide-y divide-default rounded-lg border border-default">
      <ConditionItem
        v-for="condition in sorted"
        :key="condition.type"
        :condition="condition"
        :scan-id="scanId"
        :can-resume="canResume"
        @resume="$emit('resume')"
      />
    </ul>
  </section>
</template>
