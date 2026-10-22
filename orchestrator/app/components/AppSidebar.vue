<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'
import type { NavigationLink } from '~/utils/navigation'

// The dashboard sidebar (docs/ui.md §3): logo, theme, primary actions, navigation groups, API docs and the
// user menu. Items are data from utils/navigation.ts; badges come from the singleton sidebar poll.

const { isAdmin } = useAuth()
const { features } = useInstance()
const counts = useSidebarCounts()

function badgeFor(link: NavigationLink): NavigationMenuItem['badge'] {
  if (link.badge === 'activeScans') {
    const label = counts.activeScansLabel.value
    return label ? { label, color: 'neutral', variant: 'subtle' } : undefined
  }
  if (link.badge === 'offlineNodes') {
    const offline = counts.offlineNodes.value
    return offline ? { label: String(offline), color: 'error', variant: 'subtle' } : undefined
  }
  return undefined
}

function toItem(link: NavigationLink): NavigationMenuItem {
  return {
    label: link.label,
    icon: link.icon,
    to: link.to,
    exact: link.to === '/',
    badge: badgeFor(link),
    ...(link.external ? { external: true, target: '_blank' } : {}),
  }
}

const groups = computed<NavigationMenuItem[][]>(() =>
  visibleGroups({ isAdmin: isAdmin.value, editorEnabled: features.value.editor }).map((group) => [
    { label: group.label, type: 'label' },
    ...group.links.map(toItem),
  ]),
)

const footerItems = computed<NavigationMenuItem[]>(() => SIDEBAR_FOOTER_LINKS.map(toItem))
const actions = SIDEBAR_ACTIONS
</script>

<template>
  <UDashboardSidebar
    id="main"
    collapsible
    resizable
    :min-size="14"
    :default-size="16"
    :max-size="26"
    :ui="{ root: 'bg-elevated/40', footer: 'border-t border-default' }"
  >
    <template #header="{ collapsed }">
      <NuxtLink to="/" class="flex min-w-0 items-center gap-2" :aria-label="collapsed ? 'scantor overview' : undefined">
        <AppLogo class="h-7 shrink-0" />
        <span v-if="!collapsed" class="truncate text-base font-bold text-highlighted">scantor</span>
      </NuxtLink>
      <ThemeToggle v-if="!collapsed" class="ms-auto" />
    </template>

    <template #default="{ collapsed }">
      <div class="flex flex-col gap-1.5">
        <UTooltip v-for="action in actions" :key="action.to" :text="action.label" :disabled="!collapsed">
          <UButton
            :to="action.to"
            :icon="action.icon"
            :label="collapsed ? undefined : action.label"
            :aria-label="collapsed ? action.label : undefined"
            :color="action.color"
            :variant="action.variant"
            size="sm"
            :block="!collapsed"
            :square="collapsed"
          />
        </UTooltip>
      </div>

      <UNavigationMenu
        :collapsed="collapsed"
        :items="groups"
        orientation="vertical"
        tooltip
        aria-label="Main navigation"
        :ui="{ label: 'text-[10px] font-semibold uppercase tracking-wider text-dimmed' }"
      />

      <UNavigationMenu
        :collapsed="collapsed"
        :items="footerItems"
        orientation="vertical"
        tooltip
        aria-label="Documentation"
        class="mt-auto"
      />
    </template>

    <template #footer="{ collapsed }">
      <UserMenu :collapsed="collapsed" />
    </template>
  </UDashboardSidebar>
</template>
