<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { Attempt } from '#shared/types/analyses'

// The attempts history of an analysis (docs/ui.md §5.13.3): the most recent attempts across rounds (at most 10),
// newest first, with the error and an expandable log tail. Texts come from task code and are rendered as text.
const props = defineProps<{
  attempts: readonly Attempt[]
  /** Admins see node links. */
  showNodeLinks?: boolean
}>()

interface AttemptRow extends Attempt {
  key: string
}

const rows = computed<AttemptRow[]>(() =>
  [...props.attempts].reverse().map((attempt, index) => ({ ...attempt, key: `${attempt.round}-${attempt.attempt}-${index}` })),
)
const expanded = ref<Record<string, boolean>>({})

const table = useTemplateRef('table')
useTableRowIds(table, (row: AttemptRow) => row.key)

function toggle(key: string): void {
  expanded.value = { ...expanded.value, [key]: !expanded.value[key] }
}

const columns: TableColumn<AttemptRow>[] = [
  { accessorKey: 'attempt', header: 'Attempt' },
  { accessorKey: 'round', header: 'Round' },
  { accessorKey: 'startedAt', header: 'Started' },
  { accessorKey: 'durationMs', header: 'Duration' },
  { id: 'error', header: 'Error' },
  { id: 'worker', header: 'Worker' },
  { id: 'node', header: 'Node' },
  { id: 'log', header: '', meta: { class: { td: 'text-end w-px' } } },
]
</script>

<template>
  <div>
    <UTable
      ref="table"
      :data="rows"
      :columns="columns"
      aria-label="Attempts"
      empty="No attempts recorded."
      :ui="{ td: 'py-1.5 text-xs align-top', th: 'py-1.5 text-xs' }"
    >
      <template #attempt-cell="{ row }">
        <span class="tabular-nums">{{ row.original.attempt }}</span>
      </template>
      <template #round-cell="{ row }">
        <span class="tabular-nums">{{ row.original.round }}</span>
      </template>
      <template #startedAt-cell="{ row }">
        <RelativeTime :value="row.original.startedAt" />
      </template>
      <template #durationMs-cell="{ row }">
        <DurationText :ms="row.original.durationMs" />
      </template>
      <template #error-cell="{ row }">
        <div v-if="row.original.error" class="flex max-w-80 flex-col gap-0.5">
          <span class="font-mono text-error">{{ row.original.error.type }}<span class="text-dimmed"> · {{ row.original.error.phase }}</span></span>
          <span class="line-clamp-2 whitespace-pre-wrap break-words text-muted">{{ stripEscapes(row.original.error.message) }}</span>
        </div>
        <span v-else class="text-success">succeeded</span>
      </template>
      <template #worker-cell="{ row }">
        <IdChip v-if="row.original.workerId" :id="row.original.workerId" :copy-label="`Copy worker id of attempt ${row.original.attempt} round ${row.original.round}`" />
        <span v-else class="text-dimmed">–</span>
      </template>
      <template #node-cell="{ row }">
        <template v-if="row.original.nodeId">
          <NuxtLink v-if="showNodeLinks" :to="`/admin/nodes/${row.original.nodeId}`" class="font-mono text-xs hover:underline">{{ shortId(row.original.nodeId) }}</NuxtLink>
          <IdChip v-else :id="row.original.nodeId" :copy-label="`Copy node id of attempt ${row.original.attempt} round ${row.original.round}`" />
        </template>
        <span v-else class="text-dimmed">–</span>
      </template>
      <template #log-cell="{ row }">
        <UTooltip v-if="row.original.logTail" :text="`${expanded[row.original.key] ? 'Hide' : 'Show'} log of attempt ${row.original.attempt} round ${row.original.round}`">
          <UButton
            :icon="expanded[row.original.key] ? 'i-lucide-chevron-up' : 'i-lucide-scroll-text'"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-expanded="Boolean(expanded[row.original.key])"
            :aria-label="`${expanded[row.original.key] ? 'Hide' : 'Show'} log of attempt ${row.original.attempt} round ${row.original.round}`"
            @click="toggle(row.original.key)"
          />
        </UTooltip>
      </template>
    </UTable>
    <template v-for="row in rows" :key="row.key">
      <div v-if="expanded[row.key]" class="mt-2 space-y-1">
        <p class="text-[10px] font-semibold uppercase tracking-wider text-dimmed">Log of attempt {{ row.attempt }}, round {{ row.round }}</p>
        <LogView :text="row.logTail" max-height-class="max-h-48" />
      </div>
    </template>
  </div>
</template>
