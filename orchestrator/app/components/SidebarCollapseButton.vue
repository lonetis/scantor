<script setup lang="ts">
import { useDashboard } from '#ui/utils/dashboard'

// The navbar's sidebar collapse toggle (docs/ui.md §3.1): UDashboardSidebarCollapse with its name, "Collapse sidebar"
// or "Expand sidebar", as its tooltip (§11 rule 1). The collapsed state comes from UDashboardGroup's context.
const { sidebarCollapsed } = useDashboard({ sidebarCollapsed: ref(false) })
const label = computed(() => (sidebarCollapsed?.value ? 'Expand sidebar' : 'Collapse sidebar'))
</script>

<template>
  <UTooltip :text="label">
    <UDashboardSidebarCollapse :aria-label="label" />
  </UTooltip>
</template>
