<script setup lang="ts">
import type { DropdownMenuItem, TableColumn } from '@nuxt/ui'

// Users list of /admin/users (docs/ui.md §5.16). Demote, set password, ban and delete are disabled on the
// caller's own row (the server refuses them too). Rows with a running userPurge job show its progress.
const props = withDefaults(defineProps<{
  users: User[]
  loading?: boolean
  currentUserId: string | null
  /** userPurge jobs by user id. */
  purgeJobs?: Record<string, Job | JobRef>
}>(), { loading: false, purgeJobs: () => ({}) })

const emit = defineEmits<{
  edit: [user: User]
  setPassword: [user: User]
  ban: [user: User]
  unban: [user: User]
  delete: [user: User]
}>()

const table = useTemplateRef('table')
const getRowId = tableRowId((user: User) => user.id)
useTableRowIds(table, getRowId)

function isSelf(user: User): boolean {
  return user.id === props.currentUserId
}

function actionsFor(user: User): DropdownMenuItem[][] {
  const self = isSelf(user)
  const deleting = Boolean(props.purgeJobs[user.id])
  return [
    [
      { label: 'Edit', icon: 'i-lucide-pencil', disabled: deleting, onSelect: () => emit('edit', user) },
      { label: 'Set password', icon: 'i-lucide-key-round', disabled: self || deleting, onSelect: () => emit('setPassword', user) },
    ],
    [
      user.banned
        ? { label: 'Unban', icon: 'i-lucide-user-check', disabled: deleting, onSelect: () => emit('unban', user) }
        : { label: 'Ban', icon: 'i-lucide-user-x', color: 'warning', disabled: self || deleting, onSelect: () => emit('ban', user) },
      { label: 'Delete', icon: 'i-lucide-trash-2', color: 'error', disabled: self || deleting, onSelect: () => emit('delete', user) },
    ],
  ]
}

function jobProgress(job: Job | JobRef): string {
  if ('progress' in job && job.progress.total) return `${Math.round((job.progress.done / job.progress.total) * 100)} %`
  return ''
}

const columns: TableColumn<User>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'email', header: 'Email' },
  { accessorKey: 'role', header: 'Role' },
  { id: 'status', header: 'Status' },
  { accessorKey: 'canRunPrivileged', header: 'Privileged' },
  { accessorKey: 'maxWorkers', header: 'Worker limit' },
  { id: 'usage', header: 'Usage' },
  { accessorKey: 'createdAt', header: 'Created' },
  { id: 'actions', header: '', meta: { class: { td: 'text-end w-px' } } },
]
</script>

<template>
  <UTable
    ref="table"
    :get-row-id="getRowId"
    :data="users"
    :columns="columns"
    :loading="loading"
    aria-label="Users"
    empty="No users match."
    sticky
    :ui="{ td: 'py-2 text-sm', th: 'py-2 text-xs' }"
  >
    <template #name-cell="{ row }">
      <span class="font-medium">{{ row.original.name }}</span>
      <span v-if="isSelf(row.original)" class="ms-1 text-xs text-muted">(you)</span>
    </template>
    <template #email-cell="{ row }">
      <span class="font-mono text-xs">{{ row.original.email }}</span>
    </template>
    <template #role-cell="{ row }">
      <UBadge
        :label="row.original.role"
        :color="row.original.role === 'admin' ? 'warning' : 'neutral'"
        :variant="row.original.role === 'admin' ? 'subtle' : 'soft'"
        size="xs"
      />
    </template>
    <template #status-cell="{ row }">
      <div class="flex flex-wrap items-center gap-1">
        <template v-if="purgeJobs[row.original.id]">
          <StatusBadge kind="job" :state="purgeJobs[row.original.id]!.state" detail="deleting" />
          <span class="text-xs text-muted tabular-nums">{{ jobProgress(purgeJobs[row.original.id]!) }}</span>
        </template>
        <UTooltip v-else-if="row.original.banned" :text="row.original.banReason || 'No reason given'">
          <UBadge label="banned" color="error" variant="subtle" size="xs" icon="i-lucide-user-x" />
        </UTooltip>
        <span v-else class="text-xs text-dimmed">active</span>
        <span v-if="row.original.banned && row.original.banReason && !purgeJobs[row.original.id]" class="max-w-48 truncate text-xs text-muted">{{ row.original.banReason }}</span>
      </div>
    </template>
    <template #canRunPrivileged-cell="{ row }">
      <UBadge v-if="row.original.canRunPrivileged" label="privileged" color="warning" variant="subtle" size="xs" icon="i-lucide-shield-alert" />
      <span v-else class="text-xs text-dimmed">no</span>
    </template>
    <template #maxWorkers-cell="{ row }">
      <span class="tabular-nums">{{ row.original.maxWorkers === 0 ? 'unlimited' : formatCount(row.original.maxWorkers) }}</span>
    </template>
    <template #usage-cell="{ row }">
      <span class="text-xs text-muted tabular-nums" :title="`${row.original.usage.activeWorkers} active workers, ${row.original.usage.tasks} tasks, ${row.original.usage.scans} scans`">
        {{ row.original.usage.activeWorkers }} workers · {{ row.original.usage.tasks }} tasks · {{ row.original.usage.scans }} scans
      </span>
    </template>
    <template #createdAt-cell="{ row }">
      <RelativeTime :value="row.original.createdAt" />
    </template>
    <template #actions-cell="{ row }">
      <UDropdownMenu :items="actionsFor(row.original)" :content="{ align: 'end' }">
        <UTooltip :text="`User actions for ${row.original.email}`">
          <UButton
            icon="i-lucide-ellipsis-vertical"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="`User actions for ${row.original.email}`"
          />
        </UTooltip>
      </UDropdownMenu>
    </template>
  </UTable>
</template>
