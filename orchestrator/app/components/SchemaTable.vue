<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { JsonSchema, SchemaRow } from '~/utils/schema-subset'

// Read-only schema viewer (docs/ui.md §5.9): one row per property path with type, required, default,
// constraints, description and badges, plus a "Raw JSON" toggle.
const props = withDefaults(defineProps<{
  schema: JsonSchema | null | undefined
  /** Accessible name of the table, for example "Task config schema". */
  label: string
}>(), {})

const raw = ref(false)
const rows = computed<SchemaRow[]>(() => (props.schema === null || props.schema === undefined ? [] : flattenSchema(props.schema)))
const table = useTemplateRef('table')
useTableRowIds(table, (row: SchemaRow) => row.path)

const BADGE_COLORS = { secret: 'warning', upload: 'info', file: 'info', deprecated: 'warning', readOnly: 'neutral' } as const

const columns: TableColumn<SchemaRow>[] = [
  { accessorKey: 'path', header: 'Property' },
  { accessorKey: 'type', header: 'Type' },
  { accessorKey: 'required', header: 'Required' },
  { id: 'default', header: 'Default' },
  { id: 'constraints', header: 'Constraints' },
  { accessorKey: 'description', header: 'Description' },
]
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center justify-end">
      <UButton
        :label="raw ? 'Show table' : 'Raw JSON'"
        :icon="raw ? 'i-lucide-table' : 'i-lucide-braces'"
        :aria-label="`${raw ? 'Show table of' : 'Show raw JSON of'} ${label}`"
        :aria-pressed="raw"
        color="neutral"
        variant="ghost"
        size="xs"
        @click="raw = !raw"
      />
    </div>
    <JsonView v-if="raw" :value="schema ?? {}" :collapsed-depth="4" />
    <UTable
      v-else
      ref="table"
      :data="rows"
      :columns="columns"
      :aria-label="label"
      empty="No properties."
      class="rounded-md border border-default"
      :ui="{ td: 'py-1.5 align-top text-xs', th: 'py-1.5 text-xs' }"
    >
      <template #path-cell="{ row }">
        <code class="font-mono text-xs whitespace-nowrap text-highlighted" :style="{ paddingInlineStart: `${row.original.depth * 0.75}rem` }">{{ row.original.path }}</code>
      </template>
      <template #type-cell="{ row }">
        <code class="font-mono text-xs text-muted">{{ row.original.type }}</code>
      </template>
      <template #required-cell="{ row }">
        <span v-if="row.original.required" class="text-xs">required</span>
        <span v-else class="text-xs text-dimmed">optional</span>
      </template>
      <template #default-cell="{ row }">
        <code v-if="row.original.hasDefault" class="font-mono text-xs break-all">{{ JSON.stringify(row.original.default) }}</code>
        <span v-else class="text-dimmed">–</span>
      </template>
      <template #constraints-cell="{ row }">
        <ul v-if="row.original.constraints.length" class="space-y-0.5">
          <li v-for="constraint in row.original.constraints" :key="constraint" class="font-mono text-[11px] break-all text-muted">{{ constraint }}</li>
        </ul>
        <span v-else class="text-dimmed">–</span>
      </template>
      <template #description-cell="{ row }">
        <div class="flex flex-wrap items-center gap-1">
          <UBadge
            v-for="badge in row.original.badges"
            :key="badge"
            :label="badge === 'readOnly' ? 'read-only' : badge"
            :color="BADGE_COLORS[badge]"
            variant="subtle"
            size="xs"
          />
          <span class="whitespace-normal text-xs text-muted">{{ row.original.description }}</span>
        </div>
      </template>
    </UTable>
  </div>
</template>
