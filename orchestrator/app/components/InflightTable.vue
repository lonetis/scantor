<script setup lang="ts">
import { useNow } from '@vueuse/core'
import type { TableColumn } from '@nuxt/ui'

// Analyses the runners are processing right now (docs/ui.md §5.13.5), from their latest state polls. The analysis id
// opens the analysis drawer (?analysis=<seq>).
const props = defineProps<{ inflight: InflightList }>()

const now = useNow({ interval: 1000 })
const table = useTemplateRef('table')
useTableRowIds(table, (item: InflightAnalysis) => item.seq)

function runningFor(item: InflightAnalysis): string {
  return formatDuration(Math.max(0, now.value.getTime() - new Date(item.startedAt).getTime()))
}

function progressText(progress: unknown): string {
  if (progress === null || progress === undefined) return '–'
  const text = typeof progress === 'string' ? progress : JSON.stringify(progress)
  return text.length > 80 ? `${text.slice(0, 80)}…` : text
}

const columns: TableColumn<InflightAnalysis>[] = [
  { accessorKey: 'analysisId', header: 'Analysis' },
  { accessorKey: 'seq', header: 'Seq' },
  { accessorKey: 'attempt', header: 'Attempt' },
  { accessorKey: 'round', header: 'Round' },
  { id: 'runningFor', header: 'Running for' },
  { accessorKey: 'workerId', header: 'Worker' },
  { accessorKey: 'nodeId', header: 'Node' },
  { id: 'progress', header: 'Progress' },
]

const items = computed(() => props.inflight.items)
</script>

<template>
  <div class="space-y-1">
    <UTable
      ref="table"
      :data="items"
      :columns="columns"
      aria-label="In-flight analyses"
      empty="No analysis is being processed right now."
      :ui="{ td: 'py-1.5 text-sm', th: 'py-2 text-xs' }"
    >
      <template #analysisId-cell="{ row }">
        <NuxtLink :to="{ query: { tab: 'workers', analysis: row.original.seq } }" class="font-mono text-xs hover:underline">{{ shortId(row.original.analysisId) }}-{{ row.original.seq }}</NuxtLink>
      </template>
      <template #seq-cell="{ row }">
        <span class="font-mono text-xs tabular-nums">{{ row.original.seq }}</span>
      </template>
      <template #runningFor-cell="{ row }">
        <span class="text-xs tabular-nums">{{ runningFor(row.original) }}</span>
      </template>
      <template #workerId-cell="{ row }">
        <IdChip :id="row.original.workerId" :copyable="false" />
      </template>
      <template #nodeId-cell="{ row }">
        <span class="font-mono text-xs">{{ shortId(row.original.nodeId) }}</span>
      </template>
      <template #progress-cell="{ row }">
        <span class="font-mono text-xs text-muted">{{ progressText(row.original.progress) }}</span>
      </template>
    </UTable>
    <p class="text-xs text-dimmed">
      <template v-if="inflight.updatedAt">updated <RelativeTime :value="inflight.updatedAt" /></template>
      <template v-else>no recent reports from runners</template>
    </p>
  </div>
</template>
