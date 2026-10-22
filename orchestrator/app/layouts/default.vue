<script setup lang="ts">
// Signed-in shell (docs/ui.md §3.1): sidebar plus one UDashboardPanel per page.
const { loadInfo } = useInstance()
const { paused } = useLiveStatus()

onMounted(() => {
  loadInfo().catch((error: unknown) => console.error('[instance] loading instance info failed', error))
})
</script>

<template>
  <UDashboardGroup storage="local" storage-key="scantor-dashboard" unit="%">
    <AppSidebar />
    <slot />
    <div
      v-if="paused"
      role="status"
      class="pointer-events-none fixed inset-x-0 top-2 z-50 flex justify-center"
      data-testid="live-updates-paused"
    >
      <span class="pointer-events-auto flex items-center gap-2 rounded-md border border-warning/40 bg-default px-3 py-1.5 text-xs text-warning shadow-sm">
        <UIcon name="i-lucide-loader-circle" class="size-3.5 motion-safe:animate-spin" />
        Live updates paused, retrying…
      </span>
    </div>
  </UDashboardGroup>
</template>
