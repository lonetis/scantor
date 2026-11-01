<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'

// Background jobs (docs/ui.md §5.20): failed jobs first, then newest first.
const props = withDefaults(defineProps<{
  jobs: Job[]
  loading?: boolean
}>(), { loading: false })

const table = useTemplateRef('table')
const getRowId = tableRowId((job: Job) => job.id)
useTableRowIds(table, getRowId)

const sorted = computed(() =>
  [...props.jobs].sort((a, b) => Number(b.state === 'failed') - Number(a.state === 'failed') || b.createdAt.localeCompare(a.createdAt)),
)

function percent(job: Job): number | null {
  return job.progress.total ? Math.min(100, (job.progress.done / job.progress.total) * 100) : null
}

const columns: TableColumn<Job>[] = [
  { accessorKey: 'kind', header: 'Kind' },
  { id: 'subject', header: 'Subject' },
  { accessorKey: 'state', header: 'State' },
  { id: 'progress', header: 'Progress' },
  { accessorKey: 'attempts', header: 'Attempts' },
  { id: 'error', header: 'Error' },
  { accessorKey: 'createdAt', header: 'Created' },
  { accessorKey: 'finishedAt', header: 'Finished' },
]
</script>

<template>
  <UTable
    ref="table"
    :get-row-id="getRowId"
    :data="sorted"
    :columns="columns"
    :loading="loading"
    aria-label="Jobs"
    empty="No jobs."
    :ui="{ td: 'py-2 text-sm', th: 'py-2 text-xs' }"
  >
    <template #kind-cell="{ row }">
      <code class="font-mono text-xs">{{ row.original.kind }}</code>
    </template>
    <template #subject-cell="{ row }">
      <span class="text-xs text-muted">{{ row.original.subject.kind }}</span>
      <IdChip :id="row.original.subject.id" :copy-label="`Copy subject id of job ${shortId(row.original.id)}`" />
    </template>
    <template #state-cell="{ row }">
      <StatusBadge kind="job" :state="row.original.state" />
    </template>
    <template #progress-cell="{ row }">
      <div class="flex min-w-32 items-center gap-2">
        <UProgress v-if="row.original.state === 'running'" :model-value="percent(row.original)" size="xs" class="w-20" :get-value-label="() => `Progress of job ${shortId(row.original.id)}`" />
        <span class="text-xs text-muted tabular-nums">
          {{ formatCount(row.original.progress.done) }}<template v-if="row.original.progress.total !== null"> / {{ formatCount(row.original.progress.total) }}</template>
        </span>
      </div>
    </template>
    <template #attempts-cell="{ row }">
      <span class="tabular-nums">{{ row.original.attempts }}</span>
    </template>
    <template #error-cell="{ row }">
      <UTooltip v-if="row.original.error" :text="row.original.error.message">
        <span class="block max-w-64 truncate text-xs text-error">
          <code class="font-mono">{{ row.original.error.code }}</code> {{ row.original.error.message }}
        </span>
      </UTooltip>
      <span v-else class="text-dimmed">–</span>
    </template>
    <template #createdAt-cell="{ row }"><RelativeTime :value="row.original.createdAt" /></template>
    <template #finishedAt-cell="{ row }">
      <RelativeTime v-if="row.original.finishedAt" :value="row.original.finishedAt" />
      <span v-else class="text-dimmed">–</span>
    </template>
  </UTable>
</template>
