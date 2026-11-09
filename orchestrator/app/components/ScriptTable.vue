<script setup lang="ts">
import type { TableColumn, TableRow } from '@nuxt/ui'

// The scripts list: name and description, language, source, latest run, owner (admins) and last update. A row opens
// the script.
const props = withDefaults(defineProps<{
  scripts: Script[]
  loading?: boolean
  showOwner?: boolean
}>(), { loading: false, showOwner: false })

const table = useTemplateRef('table')
const getRowId = tableRowId((script: Script) => script.id)
useTableRowIds(table, getRowId)

const SOURCE_ICONS: Record<string, string> = {
  scaffold: 'i-lucide-layout-template',
  upload: 'i-lucide-upload',
}

const columns = computed<TableColumn<Script>[]>(() => {
  const all: (TableColumn<Script> | false)[] = [
    { accessorKey: 'name', header: 'Name' },
    { accessorKey: 'language', header: 'Language' },
    { id: 'source', header: 'Source' },
    { id: 'latestRun', header: 'Latest run' },
    props.showOwner && { accessorKey: 'userId', header: 'Owner' },
    { accessorKey: 'updatedAt', header: 'Updated' },
  ]
  return all.filter((column): column is TableColumn<Script> => column !== false)
})

function open(_event: Event, row: TableRow<Script>): void {
  void navigateTo(`/scripts/${row.original.id}`)
}
</script>

<template>
  <UTable
    ref="table"
    :get-row-id="getRowId"
    :data="scripts"
    :columns="columns"
    :loading="loading"
    aria-label="Scripts"
    empty="No scripts."
    sticky
    class="cursor-pointer"
    :ui="{ td: 'py-2 text-sm', th: 'py-2 text-xs' }"
    @select="open"
  >
    <template #name-cell="{ row }">
      <NuxtLink :to="`/scripts/${row.original.id}`" class="font-mono font-medium hover:underline" @click.stop>{{ row.original.name }}</NuxtLink>
      <p v-if="row.original.description" class="max-w-md truncate text-xs text-muted">{{ row.original.description }}</p>
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
    <template #latestRun-cell="{ row }">
      <div v-if="row.original.latestRun" class="flex items-center gap-1.5">
        <StatusBadge kind="scriptRun" :state="row.original.latestRun.state" />
        <RelativeTime :value="row.original.latestRun.createdAt" class="text-xs text-muted" />
      </div>
      <span v-else class="text-xs text-dimmed">none</span>
    </template>
    <template #userId-cell="{ row }">
      <IdChip :id="row.original.userId" :copy-label="`Copy owner id of script ${row.original.name}`" />
    </template>
    <template #updatedAt-cell="{ row }">
      <RelativeTime :value="row.original.updatedAt" />
    </template>
  </UTable>
</template>
