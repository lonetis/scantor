<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'

// Workers of a scan (docs/ui.md §5.13.5): role, state with its reason, node, processes desired / applied / running,
// restarts and last exit, runtime version and timestamps; the row action shows the worker's logs.
withDefaults(defineProps<{ workers: ScanWorker[], loading?: boolean }>(), { loading: false })
const emit = defineEmits<{ logs: [worker: ScanWorker] }>()

const table = useTemplateRef('table')
useTableRowIds(table, (worker: ScanWorker) => worker.id)

function processes(worker: ScanWorker): string {
  const { desired, applied, running } = worker.processes
  return `${desired} / ${applied ?? '–'} / ${running ?? '–'}`
}

const columns: TableColumn<ScanWorker>[] = [
  { id: 'id', header: 'Worker' },
  { accessorKey: 'role', header: 'Role' },
  { accessorKey: 'state', header: 'State' },
  { id: 'node', header: 'Node' },
  { id: 'processes', header: 'Processes', meta: { class: { th: 'whitespace-nowrap' } } },
  { id: 'restarts', header: 'Restarts' },
  { id: 'lastExit', header: 'Last exit' },
  { id: 'runtime', header: 'Runtime' },
  { id: 'lastSeen', header: 'Last seen' },
  { accessorKey: 'startedAt', header: 'Started' },
  { id: 'actions', header: '', meta: { class: { td: 'text-end w-px' } } },
]
</script>

<template>
  <UTable
    ref="table"
    :data="workers"
    :columns="columns"
    :loading="loading"
    aria-label="Workers"
    empty="No workers match."
    :ui="{ td: 'py-2 text-sm', th: 'py-2 text-xs' }"
  >
    <template #id-cell="{ row }">
      <IdChip :id="row.original.id" :copy-label="`Copy worker id ${shortId(row.original.id)}`" />
    </template>
    <template #role-cell="{ row }">
      <UBadge :label="row.original.role" :color="row.original.role === 'scheduler' ? 'info' : 'neutral'" variant="subtle" size="xs" />
    </template>
    <template #state-cell="{ row }">
      <div class="space-y-0.5">
        <StatusBadge kind="worker" :state="row.original.state" />
        <p v-if="row.original.stateReason" class="max-w-56 truncate text-xs text-muted" :title="row.original.stateReason.message">{{ row.original.stateReason.message }}</p>
      </div>
    </template>
    <template #node-cell="{ row }">
      <NuxtLink v-if="row.original.node" :to="`/admin/nodes/${row.original.node.id}`" class="font-mono text-xs hover:underline">{{ row.original.node.name }}</NuxtLink>
      <span v-else class="text-xs text-dimmed">–</span>
    </template>
    <template #processes-cell="{ row }">
      <span class="font-mono text-xs tabular-nums" title="desired / applied / running">{{ processes(row.original) }}</span>
    </template>
    <template #restarts-cell="{ row }">
      <span class="font-mono text-xs tabular-nums">{{ row.original.container?.restarts ?? 0 }}</span>
    </template>
    <template #lastExit-cell="{ row }">
      <span v-if="row.original.container?.lastExit" class="inline-flex items-center gap-1 text-xs">
        <span class="font-mono">{{ row.original.container.lastExit.exitCode }}</span>
        <UBadge v-if="row.original.container.lastExit.oomKilled" label="OOM" color="error" variant="subtle" size="xs" />
        <RelativeTime :value="row.original.container.lastExit.at" />
      </span>
      <span v-else class="text-xs text-dimmed">–</span>
    </template>
    <template #runtime-cell="{ row }">
      <span class="font-mono text-xs">{{ row.original.runtime?.version ?? '–' }}</span>
    </template>
    <template #lastSeen-cell="{ row }">
      <RelativeTime v-if="row.original.runtime?.lastSeenAt" :value="row.original.runtime.lastSeenAt" />
      <span v-else class="text-xs text-dimmed">–</span>
    </template>
    <template #startedAt-cell="{ row }">
      <RelativeTime v-if="row.original.startedAt" :value="row.original.startedAt" />
      <span v-else class="text-xs text-dimmed">–</span>
    </template>
    <template #actions-cell="{ row }">
      <UButton
        label="Logs"
        icon="i-lucide-scroll-text"
        color="neutral"
        variant="ghost"
        size="xs"
        :aria-label="`Show worker logs of ${shortId(row.original.id)}`"
        @click="emit('logs', row.original)"
      />
    </template>
  </UTable>
</template>
