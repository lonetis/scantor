<script setup lang="ts">
import type { TableColumn, TableRow } from '@nuxt/ui'

// Revisions of a task (docs/ui.md §5.7 tab `revisions`): number, state, source kind, pack hash, privileged, errors,
// creation and build duration. A row opens the revision page.
const props = withDefaults(defineProps<{ taskId: string; revisions: RevisionSummary[]; loading?: boolean }>(), { loading: false })

const table = useTemplateRef('table')
useTableRowIds(table, (revision: RevisionSummary) => revision.id)

const columns: TableColumn<RevisionSummary>[] = [
  { accessorKey: 'ref', header: 'Revision' },
  { accessorKey: 'state', header: 'State' },
  { id: 'source', header: 'Source' },
  { id: 'pack', header: 'Pack hash' },
  { accessorKey: 'errorsCount', header: 'Errors' },
  { accessorKey: 'createdAt', header: 'Created' },
  { id: 'duration', header: 'Duration' },
]

function duration(revision: RevisionSummary): number | null {
  return revision.finishedAt ? Date.parse(revision.finishedAt) - Date.parse(revision.createdAt) : null
}

function open(_event: Event, row: TableRow<RevisionSummary>): void {
  void navigateTo(`/tasks/${props.taskId}/revisions/${row.original.number}`)
}
</script>

<template>
  <UTable
    ref="table"
    :data="revisions"
    :columns="columns"
    :loading="loading"
    aria-label="Revisions"
    empty="No revisions yet. Publish the workspace to create one."
    class="cursor-pointer"
    :ui="{ td: 'py-2 text-sm', th: 'py-2 text-xs' }"
    @select="open"
  >
    <template #ref-cell="{ row }">
      <div class="flex items-center gap-1.5">
        <NuxtLink :to="`/tasks/${taskId}/revisions/${row.original.number}`" class="font-mono hover:underline" @click.stop>{{ row.original.ref }}</NuxtLink>
        <UBadge v-if="row.original.privileged" label="privileged" color="warning" variant="outline" size="xs" />
      </div>
    </template>
    <template #state-cell="{ row }">
      <StatusBadge kind="revision" :state="row.original.state" />
    </template>
    <template #source-cell="{ row }">
      <span class="text-xs text-muted">{{ row.original.source.kind }}</span>
    </template>
    <template #pack-cell="{ row }">
      <IdChip :id="row.original.source.packSha256" :copy-label="`Copy pack hash of ${row.original.ref}`" />
    </template>
    <template #errorsCount-cell="{ row }">
      <span :class="row.original.errorsCount > 0 ? 'text-error tabular-nums' : 'tabular-nums text-dimmed'">{{ row.original.errorsCount }}</span>
    </template>
    <template #createdAt-cell="{ row }">
      <RelativeTime :value="row.original.createdAt" />
    </template>
    <template #duration-cell="{ row }">
      <DurationText :ms="duration(row.original)" />
    </template>
  </UTable>
</template>
