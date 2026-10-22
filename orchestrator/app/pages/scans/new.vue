<script setup lang="ts">
// New scan (docs/ui.md §5.12). `?revision=<task>@<N>` preselects a revision.
useHead({ title: 'New scan · scantor' })

const route = useRoute()
const initialRevision = computed(() => (typeof route.query.revision === 'string' ? route.query.revision : null))
</script>

<template>
  <UDashboardPanel id="scans-new">
    <template #header>
      <UDashboardNavbar title="New scan">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="max-w-5xl">
        <NewScanForm :initial-revision="initialRevision" />
      </div>
    </template>
  </UDashboardPanel>
</template>
