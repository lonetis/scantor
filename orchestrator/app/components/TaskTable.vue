<script setup lang="ts">
import type { TableColumn, TableRow } from '@nuxt/ui'

// The tasks list (docs/ui.md §5.5): name, language, source, latest revision, unpublished changes, privileged,
// revision count, owner (admins) and last update. A row opens the task.
const props = withDefaults(defineProps<{
  tasks: Task[]
  loading?: boolean
  showOwner?: boolean
  compact?: boolean
}>(), { loading: false, showOwner: false, compact: false })

const table = useTemplateRef('table')
useTableRowIds(table, (task: Task) => task.id)

const SOURCE_ICONS: Record<string, string> = {
  scaffold: 'i-lucide-layout-template',
  upload: 'i-lucide-upload',
  git: 'i-lucide-git-branch',
}

const columns = computed<TableColumn<Task>[]>(() => {
  const all: (TableColumn<Task> | false)[] = [
    { accessorKey: 'name', header: 'Name' },
    { accessorKey: 'language', header: 'Language' },
    !props.compact && { id: 'source', header: 'Source' },
    { id: 'latestRevision', header: 'Latest revision' },
    !props.compact && { accessorKey: 'revisionCount', header: 'Revisions' },
    props.showOwner && { accessorKey: 'userId', header: 'Owner' },
    { accessorKey: 'updatedAt', header: 'Updated' },
  ]
  return all.filter((column): column is TableColumn<Task> => column !== false)
})

function open(_event: Event, row: TableRow<Task>): void {
  void navigateTo(`/tasks/${row.original.id}`)
}
</script>

<template>
  <UTable
    ref="table"
    :data="tasks"
    :columns="columns"
    :loading="loading"
    aria-label="Tasks"
    empty="No tasks."
    sticky
    class="cursor-pointer"
    :ui="{ td: 'py-2 text-sm', th: 'py-2 text-xs' }"
    @select="open"
  >
    <template #name-cell="{ row }">
      <div class="flex flex-wrap items-center gap-1.5">
        <NuxtLink :to="`/tasks/${row.original.id}`" class="font-mono font-medium hover:underline" @click.stop>{{ row.original.name }}</NuxtLink>
        <UBadge
          v-if="row.original.workspace.dirty"
          label="Unpublished changes"
          color="warning"
          variant="subtle"
          size="xs"
          data-testid="unpublished-badge"
        />
        <UBadge v-if="row.original.privileged" label="privileged" color="warning" variant="outline" size="xs" icon="i-lucide-shield-alert" />
      </div>
      <p v-if="row.original.description && !compact" class="max-w-md truncate text-xs text-muted">{{ row.original.description }}</p>
    </template>
    <template #language-cell="{ row }">
      <UBadge :label="row.original.language" color="neutral" variant="soft" size="xs" />
    </template>
    <template #source-cell="{ row }">
      <span class="flex items-center gap-1 text-xs text-muted">
        <UIcon :name="SOURCE_ICONS[row.original.source.kind] ?? 'i-lucide-folder'" class="size-3.5" />
        {{ row.original.source.kind }}
      </span>
    </template>
    <template #latestRevision-cell="{ row }">
      <div v-if="row.original.latestRevision" class="flex items-center gap-1.5">
        <span class="font-mono text-xs">@{{ row.original.latestRevision.number }}</span>
        <StatusBadge kind="revision" :state="row.original.latestRevision.state" />
      </div>
      <span v-else class="text-xs text-dimmed">none</span>
    </template>
    <template #revisionCount-cell="{ row }">
      <span class="tabular-nums">{{ row.original.revisionCount }}</span>
    </template>
    <template #userId-cell="{ row }">
      <IdChip :id="row.original.userId" :copy-label="`Copy owner id of task ${row.original.name}`" />
    </template>
    <template #updatedAt-cell="{ row }">
      <RelativeTime :value="row.original.updatedAt" />
    </template>
  </UTable>
</template>
