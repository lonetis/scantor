<script setup lang="ts">
import type { DropdownMenuItem, TableColumn, TableRow } from '@nuxt/ui'

// The scans list table (docs/ui.md §5.11): name and id, revision, state (with the number of conditions), progress,
// rate, ETA, workers × processes, owner (admins), created and finished; row actions per scanActions().
// `compact` (overview and task detail, §5.4/§5.7) keeps name, revision, state, progress and created, without row
// actions, so a page that shows a few recent scans needs no action handling.
const props = withDefaults(defineProps<{
  scans: ScanSummary[]
  loading?: boolean
  /** owner emails by user id; the owner column shows when given (admins) */
  ownerEmails?: Record<string, string> | null
  compact?: boolean
  /** accessible name of the table */
  label?: string
  empty?: string
}>(), { loading: false, ownerEmails: null, compact: false, label: 'Scans', empty: 'No scans match.' })

const emit = defineEmits<{ action: [action: ScanAction, scan: ScanSummary] }>()

const table = useTemplateRef('table')
useTableRowIds(table, (scan: ScanSummary) => scan.id)

function name(scan: ScanSummary): string {
  return scan.name || `Scan ${shortId(scan.id)}`
}

function actionsFor(scan: ScanSummary): DropdownMenuItem[][] {
  const available = new Set(scanActions(scanActionSubject(scan)))
  const item = (action: ScanAction, label: string, icon: string, color?: 'error') => ({
    label,
    icon,
    ...(color ? { color } : {}),
    disabled: !available.has(action),
    onSelect: () => emit('action', action, scan),
  })
  return [
    [{ label: 'Open', icon: 'i-lucide-arrow-up-right', to: `/scans/${scan.id}` }],
    [item('pause', 'Pause', 'i-lucide-pause'), item('resume', 'Resume', 'i-lucide-play'), item('cancel', 'Cancel', 'i-lucide-circle-stop', 'error')],
    [item('restart', 'Restart', 'i-lucide-refresh-cw'), item('delete', 'Delete', 'i-lucide-trash-2', 'error')],
  ]
}

const columns = computed<TableColumn<ScanSummary>[]>(() => props.compact
  ? [
      { id: 'name', header: 'Scan' },
      { id: 'revision', header: 'Revision' },
      { accessorKey: 'state', header: 'State' },
      { id: 'progress', header: 'Progress' },
      { accessorKey: 'createdAt', header: 'Created' },
    ]
  : [
      { id: 'name', header: 'Scan' },
      { id: 'revision', header: 'Revision' },
      { accessorKey: 'state', header: 'State' },
      { id: 'progress', header: 'Progress' },
      { id: 'rate', header: 'Rate' },
      { id: 'eta', header: 'ETA' },
      { id: 'workers', header: 'Workers' },
      ...(props.ownerEmails ? [{ id: 'owner', header: 'Owner' }] : []),
      { accessorKey: 'createdAt', header: 'Created' },
      { accessorKey: 'completedAt', header: 'Finished' },
      { id: 'actions', header: '', meta: { class: { td: 'text-end w-px' } } },
    ])

function open(_event: Event, row: TableRow<ScanSummary>): void {
  void navigateTo(`/scans/${row.original.id}`)
}
</script>

<template>
  <UTable
    ref="table"
    :data="scans"
    :columns="columns"
    :loading="loading"
    :aria-label="label"
    :empty="empty"
    :sticky="!compact"
    :ui="{ td: 'py-2 text-sm', th: 'py-2 text-xs' }"
    @select="open"
  >
    <template #name-cell="{ row }">
      <div class="flex items-center gap-1.5">
        <NuxtLink :to="`/scans/${row.original.id}`" class="font-medium hover:underline" @click.stop>{{ name(row.original) }}</NuxtLink>
        <IdChip v-if="!compact" :id="row.original.id" :copyable="false" />
      </div>
    </template>
    <template #revision-cell="{ row }">
      <NuxtLink :to="`/tasks/${row.original.task.id}/revisions/${row.original.revision.number}`" class="font-mono text-xs text-muted hover:underline" @click.stop>
        {{ row.original.revision.ref }}
      </NuxtLink>
    </template>
    <template #state-cell="{ row }">
      <div class="flex items-center gap-1.5">
        <StatusBadge kind="scan" :state="row.original.state" />
        <UTooltip v-if="row.original.conditionsCount > 0" :text="plural(row.original.conditionsCount, 'condition')">
          <span class="inline-flex items-center gap-0.5 text-xs text-warning">
            <UIcon name="i-lucide-triangle-alert" class="size-3.5" aria-hidden="true" />{{ row.original.conditionsCount }}
            <span class="sr-only">conditions</span>
          </span>
        </UTooltip>
      </div>
    </template>
    <template #progress-cell="{ row }">
      <ScanProgress :progress="row.original.progress" compact :label="`Progress of ${name(row.original)}`" />
    </template>
    <template #rate-cell="{ row }">
      <span class="text-xs text-muted tabular-nums">{{ formatRate(row.original.stats.ratePerMin) }}</span>
    </template>
    <template #eta-cell="{ row }">
      <span class="text-xs text-muted tabular-nums">{{ formatEta(row.original.progress.etaSeconds) || '–' }}</span>
    </template>
    <template #workers-cell="{ row }">
      <span class="font-mono text-xs tabular-nums">{{ row.original.settings.workers }} × {{ row.original.settings.processes }}</span>
    </template>
    <template #owner-cell="{ row }">
      <span class="font-mono text-xs">{{ ownerEmails?.[row.original.userId] ?? shortId(row.original.userId) }}</span>
    </template>
    <template #createdAt-cell="{ row }">
      <RelativeTime :value="row.original.createdAt" />
    </template>
    <template #completedAt-cell="{ row }">
      <RelativeTime v-if="row.original.completedAt" :value="row.original.completedAt" />
      <span v-else class="text-xs text-dimmed">–</span>
    </template>
    <template #actions-cell="{ row }">
      <UDropdownMenu :items="actionsFor(row.original)" :content="{ align: 'end' }">
        <UTooltip :text="`Scan actions for ${name(row.original)}`">
          <UButton icon="i-lucide-ellipsis-vertical" color="neutral" variant="ghost" size="xs" :aria-label="`Scan actions for ${name(row.original)}`" @click.stop />
        </UTooltip>
      </UDropdownMenu>
    </template>
  </UTable>
</template>
