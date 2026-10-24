<script setup lang="ts">
// CLI & MCP access (docs/ui.md §5.18): API keys, MCP endpoint and setup, and authorized OAuth apps.
useHead({ title: 'CLI & MCP access · scantor' })

const { loadInfo } = useInstance()

onMounted(() => {
  loadInfo().catch((error: unknown) => console.error('[access] loading instance info failed', error))
})
</script>

<template>
  <UDashboardPanel id="account-access">
    <template #header>
      <UDashboardNavbar title="CLI & MCP access">
        <template #leading>
          <SidebarCollapseButton />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-5xl space-y-6">
        <ApiKeysSection />
        <McpAccessSection />
        <OAuthAppsSection />
      </div>
    </template>
  </UDashboardPanel>
</template>
