<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { GitCredential } from '#shared/types/credentials'

// Git credentials (docs/ui.md §5.19): name, host, username, the token's last 4 characters, last use and creation;
// edit and a two-step delete per row.
withDefaults(defineProps<{ credentials: GitCredential[]; loading?: boolean }>(), { loading: false })
const emit = defineEmits<{ edit: [credential: GitCredential]; delete: [credential: GitCredential] }>()

const table = useTemplateRef('table')
const getRowId = tableRowId((credential: GitCredential) => credential.id)
useTableRowIds(table, getRowId)
const armed = ref<string | null>(null)

function remove(credential: GitCredential): void {
  if (armed.value !== credential.id) {
    armed.value = credential.id
    return
  }
  armed.value = null
  emit('delete', credential)
}

const columns: TableColumn<GitCredential>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'host', header: 'Host' },
  { accessorKey: 'username', header: 'Username' },
  { accessorKey: 'last4', header: 'Token' },
  { accessorKey: 'lastUsedAt', header: 'Last used' },
  { accessorKey: 'createdAt', header: 'Created' },
  { id: 'actions', header: '', meta: { class: { td: 'text-end w-px' } } },
]
</script>

<template>
  <UTable
    ref="table"
    :get-row-id="getRowId"
    :data="credentials"
    :columns="columns"
    :loading="loading"
    aria-label="Git credentials"
    empty="No git credentials."
    :ui="{ td: 'py-2 text-sm', th: 'py-2 text-xs' }"
  >
    <template #name-cell="{ row }">
      <span class="font-medium">{{ row.original.name }}</span>
    </template>
    <template #host-cell="{ row }">
      <span class="font-mono text-xs">{{ row.original.host }}</span>
    </template>
    <template #username-cell="{ row }">
      <span class="font-mono text-xs">{{ row.original.username }}</span>
    </template>
    <template #last4-cell="{ row }">
      <span class="font-mono text-xs">••••{{ row.original.last4 }}</span>
    </template>
    <template #lastUsedAt-cell="{ row }">
      <RelativeTime v-if="row.original.lastUsedAt" :value="row.original.lastUsedAt" />
      <span v-else class="text-xs text-dimmed">never</span>
    </template>
    <template #createdAt-cell="{ row }">
      <RelativeTime :value="row.original.createdAt" />
    </template>
    <template #actions-cell="{ row }">
      <div class="flex items-center justify-end gap-1">
        <UTooltip :text="`Edit credential ${row.original.name}`">
          <UButton icon="i-lucide-pencil" size="xs" color="neutral" variant="ghost" :aria-label="`Edit credential ${row.original.name}`" @click="emit('edit', row.original)" />
        </UTooltip>
        <UTooltip :text="armed === row.original.id ? `Confirm deleting credential ${row.original.name}` : `Delete credential ${row.original.name}`">
          <UButton
            :icon="armed === row.original.id ? 'i-lucide-check' : 'i-lucide-trash-2'"
            :label="armed === row.original.id ? 'Confirm' : undefined"
            size="xs"
            color="error"
            :variant="armed === row.original.id ? 'soft' : 'ghost'"
            :aria-label="armed === row.original.id ? `Confirm deleting credential ${row.original.name}` : `Delete credential ${row.original.name}`"
            @click="remove(row.original)"
            @blur="armed = null"
          />
        </UTooltip>
      </div>
    </template>
  </UTable>
</template>
