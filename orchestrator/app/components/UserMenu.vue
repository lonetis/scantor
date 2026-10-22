<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'

// Sidebar footer: who is signed in, with Account, CLI & MCP access and Sign out (docs/ui.md §3.2).
defineProps<{ collapsed?: boolean }>()

const { user, isAdmin, signOut } = useAuth()

const initials = computed(() => {
  const source = user.value?.name || user.value?.email || '?'
  return source
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('')
})

const items = computed<DropdownMenuItem[][]>(() => [
  [
    { label: 'Account', icon: 'i-lucide-circle-user', to: '/account' },
    { label: 'CLI & MCP access', icon: 'i-lucide-terminal', to: '/account/access' },
  ],
  [
    {
      label: 'Sign out',
      icon: 'i-lucide-log-out',
      onSelect: () => {
        signOut().catch((error: unknown) => console.error('[auth] sign-out failed', error))
      },
    },
  ],
])
</script>

<template>
  <UDropdownMenu v-if="user" :items="items" :content="{ align: 'start', side: 'top' }" :ui="{ content: 'w-(--reka-dropdown-menu-trigger-width) min-w-56' }">
    <button
      type="button"
      class="flex w-full min-w-0 items-center gap-2.5 rounded-md p-1.5 text-left transition-colors hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary"
      :aria-label="collapsed ? `Account menu of ${user.name || user.email}` : undefined"
      data-testid="user-menu"
    >
      <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-elevated text-xs font-semibold text-muted" aria-hidden="true">
        {{ initials }}
      </span>
      <span v-if="!collapsed" class="min-w-0 flex-1">
        <span class="flex items-center gap-1.5">
          <span class="truncate text-sm font-medium text-highlighted">{{ user.name || user.email }}</span>
          <UBadge v-if="isAdmin" label="admin" color="warning" variant="subtle" size="xs" />
        </span>
        <span class="block truncate text-xs text-muted">{{ user.email }}</span>
      </span>
      <UIcon v-if="!collapsed" name="i-lucide-chevrons-up-down" class="size-4 shrink-0 text-dimmed" />
    </button>
  </UDropdownMenu>
</template>
