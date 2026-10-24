<script setup lang="ts">
import type { DropdownMenuItem, TableColumn } from '@nuxt/ui'
import type { ScantorNode } from '#shared/types/nodes'

// Nodes list of /admin/nodes (docs/ui.md §5.15): state, cordon, pool, labels, capacity and warnings per node, with
// row actions. Rotate, revoke and delete are disabled for the built-in node, whose token is derived from
// SCANTOR_SECRET; its menu says so above them.
const props = withDefaults(defineProps<{
  nodes: ScantorNode[]
  loading?: boolean
}>(), { loading: false })

const emit = defineEmits<{
  edit: [node: ScantorNode]
  join: [node: ScantorNode]
  rotate: [node: ScantorNode]
  revoke: [node: ScantorNode]
  delete: [node: ScantorNode]
}>()

const CLOCK_SKEW_MS = 2000
const BUILTIN_HINT = 'The built-in node\'s token is derived from SCANTOR_SECRET'

const table = useTemplateRef('table')
useTableRowIds(table, (node: ScantorNode) => node.id)

/** Effective worker capacity: min(reported maxWorkers, admin override). */
function capacity(node: ScantorNode): number | null {
  const reported = node.info?.maxWorkers ?? null
  if (reported === null) return node.maxWorkers
  return node.maxWorkers === null ? reported : Math.min(reported, node.maxWorkers)
}

function warnings(node: ScantorNode): string[] {
  const result: string[] = []
  if (node.info?.egressDenyApplied === false) result.push('Egress deny list not applied')
  const offset = node.info?.clockOffsetMs
  if (offset !== undefined && Math.abs(offset) > CLOCK_SKEW_MS) result.push(`Clock off by ${formatDuration(Math.abs(offset))}`)
  return result
}

function actionsFor(node: ScantorNode): DropdownMenuItem[][] {
  const builtIn = node.builtIn
  return [
    [
      { label: 'Edit', icon: 'i-lucide-pencil', onSelect: () => emit('edit', node) },
      { label: 'Show join command', icon: 'i-lucide-terminal', onSelect: () => emit('join', node) },
    ],
    [
      // The explanation sits in the menu, next to the disabled actions: the actions button's tooltip is its name.
      ...(builtIn ? [{ type: 'label' as const, label: BUILTIN_HINT, class: 'max-w-64 whitespace-normal font-normal text-muted' }] : []),
      { label: 'Rotate token', icon: 'i-lucide-key-round', disabled: builtIn, onSelect: () => emit('rotate', node) },
      { label: 'Revoke token', icon: 'i-lucide-shield-off', color: 'warning', disabled: builtIn || node.state === 'revoked', onSelect: () => emit('revoke', node) },
      { label: 'Delete', icon: 'i-lucide-trash-2', color: 'error', disabled: builtIn, onSelect: () => emit('delete', node) },
    ],
  ]
}

const columns: TableColumn<ScantorNode>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'state', header: 'State' },
  { accessorKey: 'pool', header: 'Pool' },
  { id: 'labels', header: 'Labels' },
  { id: 'arch', header: 'Arch' },
  { id: 'cpus', header: 'CPUs' },
  { id: 'memory', header: 'Memory' },
  { id: 'disk', header: 'Free disk' },
  { id: 'workers', header: 'Workers' },
  { id: 'dind', header: 'DinD' },
  { id: 'version', header: 'Version' },
  { accessorKey: 'lastSeenAt', header: 'Last seen' },
  { id: 'warnings', header: '' },
  { id: 'actions', header: '', meta: { class: { td: 'text-end w-px' } } },
]

const hasWarnings = computed(() => props.nodes.some((node) => warnings(node).length > 0))
</script>

<template>
  <UTable
    ref="table"
    :data="nodes"
    :columns="columns"
    :loading="loading"
    :column-visibility="{ warnings: hasWarnings }"
    aria-label="Nodes"
    empty="No nodes match."
    sticky
    :ui="{ td: 'py-2 text-sm', th: 'py-2 text-xs' }"
  >
    <template #name-cell="{ row }">
      <div class="flex items-center gap-1.5">
        <NuxtLink :to="`/admin/nodes/${row.original.id}`" class="font-mono text-xs font-medium hover:underline">{{ row.original.name }}</NuxtLink>
        <UBadge v-if="row.original.builtIn" label="built-in" color="neutral" variant="outline" size="xs" class="rounded-full" />
      </div>
    </template>
    <template #state-cell="{ row }">
      <div class="flex flex-wrap items-center gap-1">
        <StatusBadge kind="node" :state="row.original.state" />
        <UBadge v-if="row.original.cordoned" label="cordoned" color="warning" variant="subtle" size="xs" icon="i-lucide-ban" />
      </div>
    </template>
    <template #pool-cell="{ row }">
      <span class="font-mono text-xs">{{ row.original.pool }}</span>
    </template>
    <template #labels-cell="{ row }">
      <div class="flex max-w-56 flex-wrap gap-1">
        <UBadge
          v-for="(value, key) in row.original.labels"
          :key="key"
          :label="`${key}=${value}`"
          color="neutral"
          variant="soft"
          size="xs"
          class="font-mono"
        />
        <span v-if="Object.keys(row.original.labels).length === 0" class="text-xs text-dimmed">–</span>
      </div>
    </template>
    <template #arch-cell="{ row }">
      <span class="font-mono text-xs">{{ row.original.info ? `${row.original.info.os}/${row.original.info.arch}` : '–' }}</span>
    </template>
    <template #cpus-cell="{ row }">
      <span class="tabular-nums">{{ row.original.info?.cpus ?? '–' }}</span>
    </template>
    <template #memory-cell="{ row }">
      <BytesText :bytes="row.original.info?.memoryBytes ?? null" />
    </template>
    <template #disk-cell="{ row }">
      <BytesText :bytes="row.original.info?.diskFreeBytes ?? null" />
    </template>
    <template #workers-cell="{ row }">
      <span class="tabular-nums" :title="row.original.maxWorkers !== null ? `admin limit ${row.original.maxWorkers}` : undefined">
        {{ row.original.activeWorkers }} / {{ capacity(row.original) ?? '–' }}
      </span>
    </template>
    <template #dind-cell="{ row }">
      <span class="text-xs" :class="row.original.info?.dindMode && row.original.info.dindMode !== 'disabled' ? 'text-warning' : 'text-muted'">
        {{ row.original.info?.dindMode ?? '–' }}
      </span>
    </template>
    <template #version-cell="{ row }">
      <span class="font-mono text-xs text-muted">{{ row.original.info?.version ?? row.original.instance?.version ?? '–' }}</span>
    </template>
    <template #lastSeenAt-cell="{ row }">
      <RelativeTime :value="row.original.lastSeenAt" />
    </template>
    <template #warnings-cell="{ row }">
      <div class="flex gap-1">
        <UTooltip v-for="warning in warnings(row.original)" :key="warning" :text="warning">
          <UIcon name="i-lucide-triangle-alert" class="size-4 text-warning" :aria-label="`${row.original.name}: ${warning}`" role="img" />
        </UTooltip>
      </div>
    </template>
    <template #actions-cell="{ row }">
      <UDropdownMenu :items="actionsFor(row.original)" :content="{ align: 'end' }">
        <UTooltip :text="`Node actions for ${row.original.name}`" :content="{ side: 'left' }">
          <UButton
            icon="i-lucide-ellipsis-vertical"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="`Node actions for ${row.original.name}`"
          />
        </UTooltip>
      </UDropdownMenu>
    </template>
  </UTable>
</template>
