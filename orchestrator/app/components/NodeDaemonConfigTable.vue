<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { NodeDaemonConfig } from '#shared/types/nodes'
import type { DaemonConfigRow } from '~/utils/daemon-config'

// The daemon configuration of a node (docs/ui.md §5.15, docs/nodes.md §6.12): every setting with its value, its
// environment variable and its source (env, default or override), and overrides the daemon has not applied yet or
// rejected.
const props = defineProps<{ config: NodeDaemonConfig }>()

const table = useTemplateRef('table')
const getRowId = tableRowId((row: DaemonConfigRow) => row.key)
useTableRowIds(table, getRowId)

const rows = computed(() => daemonConfigRows(props.config))

const columns: TableColumn<DaemonConfigRow>[] = [
  { id: 'setting', header: 'Setting' },
  { id: 'value', header: 'Value' },
  { id: 'source', header: 'Source' },
]
</script>

<template>
  <UTable
    ref="table"
    :get-row-id="getRowId"
    :data="rows"
    :columns="columns"
    aria-label="Daemon configuration"
    empty="The daemon reported no settings."
    :ui="{ td: 'py-2 text-sm align-top', th: 'py-2 text-xs' }"
  >
    <template #setting-cell="{ row }">
      <div class="flex flex-col">
        <span>{{ row.original.label }}</span>
        <span class="font-mono text-xs text-muted">{{ row.original.env }}</span>
      </div>
    </template>
    <template #value-cell="{ row }">
      <div class="flex flex-col gap-0.5">
        <span class="whitespace-normal break-words" :class="row.original.mono ? 'font-mono text-xs' : ''" :title="row.original.title">
          {{ row.original.value }}
        </span>
        <span v-if="row.original.note" class="whitespace-normal text-xs" :class="row.original.note.tone === 'rejected' ? 'text-error' : 'text-muted'">
          {{ row.original.note.text }}
        </span>
      </div>
    </template>
    <template #source-cell="{ row }">
      <StatusBadge kind="daemonConfigSource" :state="row.original.source" />
    </template>
  </UTable>
</template>
