<script setup lang="ts">
import type { AdminToolItem } from '#shared/types/instance'

// One admin tool (docs/ui.md §5.20). With Traefik, "Open" navigates in a new tab to createToolsSession, which sets
// the admin-only tools cookie and redirects to the tool. Without Traefik the tool is bound to the admin address only.
const props = defineProps<{ item: AdminToolItem }>()

const description = computed(() => TOOL_DESCRIPTIONS[props.item.target])
</script>

<template>
  <UCard :ui="{ body: 'flex h-full flex-col gap-3 p-4 sm:p-4' }" :data-row-id="item.target">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 space-y-1">
        <h3 class="text-sm font-semibold text-highlighted">{{ item.title }}</h3>
        <p class="text-xs text-muted">{{ description }}</p>
      </div>
      <UIcon name="i-lucide-wrench" class="size-5 shrink-0 text-dimmed" aria-hidden="true" />
    </div>

    <template v-if="item.url">
      <code class="truncate font-mono text-xs text-dimmed" :title="item.url">{{ item.url }}</code>
      <div class="mt-auto">
        <UButton
          label="Open"
          trailing-icon="i-lucide-external-link"
          size="sm"
          :to="toolSessionPath(item.target)"
          external
          target="_blank"
          :aria-label="`Open ${item.title}`"
        />
      </div>
    </template>
    <p v-else class="mt-auto text-xs text-dimmed">
      Bound to <code class="font-mono">SCANTOR_ADMIN_BIND_ADDRESS</code>; use an SSH tunnel.
    </p>
  </UCard>
</template>
