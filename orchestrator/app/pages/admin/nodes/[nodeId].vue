<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { ScantorEvent } from '#shared/types/events'
import type { ScanWorker } from '#shared/types/workers'

// Node detail (docs/ui.md §5.15): every reported info field, the lease holder, the workers on the node and the
// node's events. Polls every 10 s while visible.
definePageMeta({ admin: true })

const route = useRoute()
const nodeId = computed(() => String(route.params.nodeId))
const activeOnly = ref(true)
const workerStates = computed<WorkerState[]>(() => (activeOnly.value ? [...ACTIVE_WORKER_STATES] : []))
const detail = useNode(nodeId, { workerStates })
const node = detail.node

useHead({ title: () => `${node.value?.name ?? 'Node'} · scantor` })

const workersTable = useTemplateRef('workersTable')
useTableRowIds(workersTable, (worker: ScanWorker) => worker.id)
const eventsTable = useTemplateRef('eventsTable')
useTableRowIds(eventsTable, (event: ScantorEvent) => event.id)

interface InfoRow {
  label: string
  value: string
  mono?: boolean
}

const infoRows = computed<InfoRow[]>(() => {
  const current = node.value
  if (!current) return []
  const info = current.info
  const rows: InfoRow[] = [
    { label: 'Endpoint profile', value: current.endpointProfile },
    { label: 'Pool', value: current.pool, mono: true },
    { label: 'Worker limit', value: current.maxWorkers === null ? 'none' : String(current.maxWorkers) },
    { label: 'Token', value: current.tokenPrefix ? `${current.tokenPrefix}…` : '–', mono: true },
    { label: 'Token rotated', value: formatAbsoluteTime(current.tokenRotatedAt) || 'never' },
    { label: 'Assignments revision', value: String(current.assignmentsRev) },
  ]
  if (info) {
    rows.push(
      { label: 'Hostname', value: info.hostname || '–', mono: true },
      { label: 'Platform', value: `${info.os}/${info.arch}`, mono: true },
      { label: 'Kernel', value: info.kernel || '–', mono: true },
      { label: 'Docker', value: info.dockerVersion || '–', mono: true },
      { label: 'Daemon version', value: info.version, mono: true },
      { label: 'CPUs', value: String(info.cpus) },
      { label: 'Memory', value: formatBytes(info.memoryBytes) },
      { label: 'Free disk', value: formatBytes(info.diskFreeBytes) },
      { label: 'DinD mode', value: info.dindMode },
      { label: 'Reported max workers', value: String(info.maxWorkers) },
      { label: 'Egress deny list', value: info.egressDenyApplied ? 'applied' : 'not applied' },
      { label: 'Clock offset', value: info.clockOffsetMs === undefined ? '–' : `${info.clockOffsetMs} ms` },
    )
  }
  return rows
})

const leaseRows = computed<InfoRow[]>(() => {
  const instance = node.value?.instance
  if (!instance) return [{ label: 'Lease', value: 'no daemon instance holds the lease' }]
  return [
    { label: 'Instance version', value: instance.version, mono: true },
    { label: 'Instance started', value: formatAbsoluteTime(instance.startedAt) },
    { label: 'Lease renewed', value: formatAbsoluteTime(instance.lastSeenAt) },
  ]
})

const workerColumns: TableColumn<ScanWorker>[] = [
  { accessorKey: 'id', header: 'Worker' },
  { id: 'scan', header: 'Scan' },
  { accessorKey: 'role', header: 'Role' },
  { accessorKey: 'state', header: 'State' },
  { id: 'processes', header: 'Processes' },
  { id: 'restarts', header: 'Restarts' },
  { id: 'lastExit', header: 'Last exit' },
  { accessorKey: 'createdAt', header: 'Created' },
]

const eventColumns: TableColumn<ScantorEvent>[] = [
  { accessorKey: 'at', header: 'Time' },
  { accessorKey: 'level', header: 'Level' },
  { accessorKey: 'type', header: 'Type' },
  { accessorKey: 'message', header: 'Message' },
]
</script>

<template>
  <UDashboardPanel id="admin-node">
    <template #header>
      <UDashboardNavbar :title="node?.name ?? 'Node'">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #title>
          <div class="flex items-center gap-2">
            <UButton to="/admin/nodes" icon="i-lucide-arrow-left" color="neutral" variant="ghost" size="xs" aria-label="Back to nodes" />
            <span class="font-mono">{{ node?.name ?? 'Node' }}</span>
            <UBadge v-if="node?.builtIn" label="built-in" color="neutral" variant="outline" size="xs" class="rounded-full" />
            <StatusBadge v-if="node" kind="node" :state="node.state" />
            <UBadge v-if="node?.cordoned" label="cordoned" color="warning" variant="subtle" size="xs" icon="i-lucide-ban" />
          </div>
        </template>
        <template #right>
          <RefreshButton :loading="detail.refreshing.value" @click="detail.refresh()" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UAlert
        v-if="detail.error.value"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="detail.error.value.code === 'notFound' ? 'Node not found' : 'The node could not be loaded'"
        :description="errorMessage(detail.error.value)"
      />
      <div v-if="node" class="grid gap-4 lg:grid-cols-3">
        <UCard class="lg:col-span-2" :ui="{ body: 'p-4 sm:p-4' }">
          <p class="section-label mb-2">Info</p>
          <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <template v-for="row in infoRows" :key="row.label">
              <dt class="text-xs text-muted">{{ row.label }}</dt>
              <dd :class="row.mono ? 'font-mono text-xs' : ''">{{ row.value }}</dd>
            </template>
          </dl>
          <div v-if="Object.keys(node.labels).length > 0" class="mt-3 flex flex-wrap gap-1">
            <UBadge v-for="(value, key) in node.labels" :key="key" :label="`${key}=${value}`" color="neutral" variant="soft" size="xs" class="font-mono" />
          </div>
        </UCard>
        <UCard :ui="{ body: 'p-4 sm:p-4' }">
          <p class="section-label mb-2">Lease</p>
          <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <template v-for="row in leaseRows" :key="row.label">
              <dt class="text-xs text-muted">{{ row.label }}</dt>
              <dd :class="row.mono ? 'font-mono text-xs' : ''">{{ row.value }}</dd>
            </template>
            <dt class="text-xs text-muted">Last seen</dt>
            <dd><RelativeTime :value="node.lastSeenAt" /></dd>
            <dt class="text-xs text-muted">Active workers</dt>
            <dd class="tabular-nums">{{ node.activeWorkers }}</dd>
          </dl>
        </UCard>
      </div>
      <USkeleton v-else-if="!detail.error.value" class="h-48 w-full" />

      <section v-if="node" class="mt-6 space-y-2" aria-labelledby="node-workers-heading">
        <div class="flex items-center justify-between gap-2">
          <h2 id="node-workers-heading" class="section-label">Workers on this node</h2>
          <USwitch v-model="activeOnly" label="Active only" size="sm" />
        </div>
        <UTable
          ref="workersTable"
          :data="detail.workers.items.value"
          :columns="workerColumns"
          :loading="detail.workers.loading.value && !detail.workers.loaded.value"
          aria-label="Workers on this node"
          empty="No workers on this node."
          :ui="{ td: 'py-2 text-sm', th: 'py-2 text-xs' }"
        >
          <template #id-cell="{ row }">
            <IdChip :id="row.original.id" :copy-label="`Copy id of worker ${row.original.id}`" />
          </template>
          <template #scan-cell="{ row }">
            <NuxtLink :to="`/scans/${row.original.scanId}`" class="hover:underline">{{ row.original.scan.name || shortId(row.original.scanId) }}</NuxtLink>
          </template>
          <template #role-cell="{ row }">
            <UBadge :label="row.original.role" color="neutral" variant="soft" size="xs" />
          </template>
          <template #state-cell="{ row }">
            <StatusBadge kind="worker" :state="row.original.state" :detail="row.original.stateReason?.message ?? null" />
          </template>
          <template #processes-cell="{ row }">
            <span class="tabular-nums text-xs" title="desired / applied / running">
              {{ row.original.processes.desired }} / {{ row.original.processes.applied ?? '–' }} / {{ row.original.processes.running ?? '–' }}
            </span>
          </template>
          <template #restarts-cell="{ row }">
            <span class="tabular-nums">{{ row.original.container?.restarts ?? 0 }}</span>
          </template>
          <template #lastExit-cell="{ row }">
            <span v-if="row.original.container?.lastExit" class="flex items-center gap-1 text-xs">
              <span class="font-mono">{{ row.original.container.lastExit.exitCode }}</span>
              <UBadge v-if="row.original.container.lastExit.oomKilled" label="OOM" color="error" variant="subtle" size="xs" />
            </span>
            <span v-else class="text-xs text-dimmed">–</span>
          </template>
          <template #createdAt-cell="{ row }">
            <RelativeTime :value="row.original.createdAt" />
          </template>
        </UTable>
        <LoadMoreButton :has-more="detail.workers.hasMore.value" :loading="detail.workers.loading.value" @load="detail.workers.loadMore()" />
      </section>

      <section v-if="node" class="mt-6 space-y-2" aria-labelledby="node-events-heading">
        <h2 id="node-events-heading" class="section-label">Events</h2>
        <UTable
          ref="eventsTable"
          :data="detail.events.items.value"
          :columns="eventColumns"
          :loading="detail.events.loading.value && !detail.events.loaded.value"
          aria-label="Node events"
          empty="No events for this node."
          :ui="{ td: 'py-2 text-sm', th: 'py-2 text-xs' }"
        >
          <template #at-cell="{ row }">
            <RelativeTime :value="row.original.at" />
          </template>
          <template #level-cell="{ row }">
            <StatusBadge kind="eventLevel" :state="row.original.level" />
          </template>
          <template #type-cell="{ row }">
            <span class="font-mono text-xs">{{ row.original.type }}</span>
          </template>
          <template #message-cell="{ row }">
            <span class="whitespace-pre-wrap break-words">{{ row.original.message }}</span>
          </template>
        </UTable>
        <LoadMoreButton :has-more="detail.events.hasMore.value" :loading="detail.events.loading.value" @load="detail.events.loadMore()" />
      </section>
    </template>
  </UDashboardPanel>
</template>
