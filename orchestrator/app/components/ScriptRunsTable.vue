<script setup lang="ts">
import type { TableColumn, TableRow } from '@nuxt/ui'

// The run history of a script: start, state, scans, progress, sample limit, duration and the hash of the code the run
// was built from. A row opens the run.
const props = withDefaults(defineProps<{
  runs: ScriptRun[]
  loading?: boolean
  label?: string
}>(), { loading: false, label: 'Script runs' })

const table = useTemplateRef('table')
const getRowId = tableRowId((run: ScriptRun) => run.id)
useTableRowIds(table, getRowId)

const columns: TableColumn<ScriptRun>[] = [
  { accessorKey: 'createdAt', header: 'Started' },
  { accessorKey: 'state', header: 'State' },
  { id: 'scans', header: 'Scans' },
  { id: 'progress', header: 'Progress' },
  { id: 'duration', header: 'Duration' },
  { id: 'pack', header: 'Pack hash' },
]

function runPath(run: ScriptRun): string {
  return `/scripts/${run.scriptId}/runs/${run.id}`
}

function open(_event: Event, row: TableRow<ScriptRun>): void {
  void navigateTo(runPath(row.original))
}

function scanNames(run: ScriptRun): string {
  return run.scans.map((scan) => scan.name || shortId(scan.id)).join(', ')
}

function progressText(run: ScriptRun): string {
  const progress = run.progress
  if (!progress) return ''
  return progress.total === null ? formatCount(progress.done) : `${formatCount(progress.done)} / ${formatCount(progress.total)}`
}
</script>

<template>
  <UTable
    ref="table"
    :get-row-id="getRowId"
    :data="runs"
    :columns="columns"
    :loading="loading"
    :aria-label="props.label"
    empty="No runs yet."
    class="cursor-pointer"
    :ui="{ td: 'py-1.5 text-sm', th: 'py-1.5 text-xs' }"
    @select="open"
  >
    <template #createdAt-cell="{ row }">
      <NuxtLink :to="runPath(row.original)" class="hover:underline" @click.stop>
        <RelativeTime :value="row.original.createdAt" />
      </NuxtLink>
    </template>
    <template #state-cell="{ row }">
      <div class="flex flex-wrap items-center gap-1">
        <StatusBadge kind="scriptRun" :state="row.original.state" />
        <UBadge v-if="row.original.input.settings.limit !== null" :label="`sample of ${formatCount(row.original.input.settings.limit)}`" color="neutral" variant="outline" size="xs" />
        <UBadge v-if="row.original.restartedFrom?.resume" label="resumed" color="neutral" variant="soft" size="xs" />
      </div>
    </template>
    <template #scans-cell="{ row }">
      <span class="block max-w-xs truncate text-xs" :title="scanNames(row.original)">{{ scanNames(row.original) }}</span>
    </template>
    <template #progress-cell="{ row }">
      <span class="text-xs tabular-nums">{{ progressText(row.original) }}</span>
    </template>
    <template #duration-cell="{ row }">
      <DurationText :ms="scriptRunDurationMs(row.original)" />
    </template>
    <template #pack-cell="{ row }">
      <IdChip :id="row.original.source.packSha256" :copy-label="`Copy pack hash of script run ${shortId(row.original.id)}`" />
    </template>
  </UTable>
</template>
