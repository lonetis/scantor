<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { Export } from '#shared/types/exports'
import type { Scan } from '#shared/types/scans'

// The exports tab of a scan (docs/ui.md §5.13.6): listExports?scanId= with format, state, rows, size, created and
// expiry; "Download" follows a fresh presigned link, delete asks first. Unsettled exports are followed every 2 s by
// useExports, which also announces ready exports with a toast. New exports start in the ExportModal; one started from
// the scan controls or the query console joins the table as it is followed.
const props = defineProps<{
  scan: Pick<Scan, 'id' | 'name' | 'state'>
}>()

const exports = useExports(() => props.scan.id)
const { confirm } = useConfirm()
const busy = ref<string | null>(null)

const table = useTemplateRef('table')
const getRowId = tableRowId((item: Export) => item.id)
useTableRowIds(table, getRowId)

onMounted(() => {
  exports.reset().catch((error: unknown) => console.error('[exports] loading exports failed', error))
})
watch(() => props.scan.id, () => {
  exports.reset().catch((error: unknown) => console.error('[exports] loading exports failed', error))
})

const canExport = computed(() => props.scan.state !== 'deleting' && props.scan.state !== 'deleted')

async function newExport(): Promise<void> {
  await exports.openExportModal(props.scan)
}

async function download(item: Export): Promise<void> {
  busy.value = item.id
  try {
    await exports.download(item)
  } finally {
    busy.value = null
  }
}

async function remove(item: Export): Promise<void> {
  const confirmed = await confirm({
    title: 'Delete export?',
    description: `The ${item.format.toUpperCase()} export of ${formatCount(item.rows)} rows and its file are deleted. Download links handed out earlier stop working.`,
    confirmLabel: 'Delete export',
  })
  if (!confirmed) return
  busy.value = item.id
  try {
    await exports.remove(item)
  } finally {
    busy.value = null
  }
}

function describe(item: Export): string {
  return `${item.format} export ${shortId(item.id)}`
}

const columns: TableColumn<Export>[] = [
  { accessorKey: 'format', header: 'Format' },
  { accessorKey: 'state', header: 'State' },
  { accessorKey: 'rows', header: 'Rows' },
  { accessorKey: 'bytes', header: 'Size' },
  { id: 'selection', header: 'Selection' },
  { accessorKey: 'createdAt', header: 'Created' },
  { accessorKey: 'expiresAt', header: 'Expires' },
  { id: 'actions', header: '', meta: { class: { td: 'text-end w-px whitespace-nowrap' } } },
]
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-xs text-muted">Background exports of this scan; files expire after the retention period.</p>
      <div class="flex items-center gap-2">
        <RefreshButton label="Refresh exports" :loading="exports.loading.value || exports.refreshing.value" @click="exports.refresh()" />
        <UButton label="New export" icon="i-lucide-file-down" size="sm" :disabled="!canExport" @click="newExport" />
      </div>
    </div>
    <UTable
      ref="table"
      :get-row-id="getRowId"
      :data="exports.items.value"
      :columns="columns"
      :loading="exports.loading.value"
      aria-label="Exports"
      empty="No exports yet."
      :ui="{ td: 'py-2 text-sm', th: 'py-2 text-xs' }"
    >
      <template #format-cell="{ row }">
        <code class="font-mono text-xs">{{ row.original.format }}</code>
      </template>
      <template #state-cell="{ row }">
        <div class="flex flex-col gap-0.5">
          <StatusBadge kind="export" :state="row.original.state" />
          <span v-if="row.original.error" class="max-w-56 truncate text-xs text-error">{{ row.original.error.message }}</span>
        </div>
      </template>
      <template #rows-cell="{ row }">
        <span class="tabular-nums">{{ formatCount(row.original.rows) }}</span>
      </template>
      <template #bytes-cell="{ row }">
        <BytesText :bytes="row.original.bytes" />
      </template>
      <template #selection-cell="{ row }">
        <UTooltip :text="JSON.stringify(row.original.filter)">
          <code class="block max-w-48 truncate font-mono text-xs text-muted">{{ JSON.stringify(row.original.filter) }}</code>
        </UTooltip>
        <span v-if="row.original.fields" class="block max-w-48 truncate text-xs text-dimmed">{{ row.original.fields.join(', ') }}</span>
      </template>
      <template #createdAt-cell="{ row }"><RelativeTime :value="row.original.createdAt" /></template>
      <template #expiresAt-cell="{ row }"><RelativeTime :value="row.original.expiresAt" /></template>
      <template #actions-cell="{ row }">
        <div class="flex justify-end gap-1">
          <UButton
            v-if="row.original.state === 'ready'"
            label="Download"
            icon="i-lucide-download"
            color="neutral"
            variant="outline"
            size="xs"
            :loading="busy === row.original.id"
            :aria-label="`Download ${describe(row.original)}`"
            @click="download(row.original)"
          />
          <UTooltip :text="`Delete ${describe(row.original)}`">
            <UButton
              icon="i-lucide-trash-2"
              color="error"
              variant="ghost"
              size="xs"
              :disabled="busy === row.original.id"
              :aria-label="`Delete ${describe(row.original)}`"
              @click="remove(row.original)"
            />
          </UTooltip>
        </div>
      </template>
    </UTable>
    <LoadMoreButton :has-more="exports.hasMore.value" :loading="exports.loading.value" @load="exports.loadMore()" />
  </div>
</template>
