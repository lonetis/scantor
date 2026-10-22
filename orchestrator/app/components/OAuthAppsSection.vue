<script setup lang="ts">
// Applications the user authorized over OAuth (MCP clients) with a two-step revoke (docs/ui.md §5.18).
const api = useApi()
const apps = ref<OAuthApp[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const revokeArmedId = ref<string | null>(null)

async function load(): Promise<void> {
  loading.value = true
  try {
    apps.value = (await api<ItemList<OAuthApp>>('/api/account/oauth-apps', { toast: false })).items
    error.value = null
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    loading.value = false
  }
}

defineExpose({ load })
onMounted(() => {
  void load()
})

/** CIMD clients are identified by their metadata document URL: show its host. */
function clientLabel(app: OAuthApp): string {
  const url = safeHttpUrl(app.clientId)
  return url ? new URL(url).host : app.clientId
}

function appName(app: OAuthApp): string {
  return app.name || clientLabel(app)
}

async function revoke(app: OAuthApp): Promise<void> {
  if (revokeArmedId.value !== app.clientId) {
    revokeArmedId.value = app.clientId
    return
  }
  revokeArmedId.value = null
  try {
    await api(`/api/account/oauth-apps/${encodeURIComponent(app.clientId)}`, { method: 'DELETE' })
    apps.value = apps.value.filter((candidate) => candidate.clientId !== app.clientId)
  } catch (cause) {
    console.error('[oauth-apps] revoke failed', cause)
  }
}
</script>

<template>
  <section class="space-y-4 rounded-lg border border-default p-4" aria-labelledby="oauth-apps-heading">
    <div>
      <h2 id="oauth-apps-heading" class="text-sm font-semibold text-highlighted">Authorized apps</h2>
      <p class="text-xs text-muted">MCP clients you approved. Revoking deletes their tokens; the next request of the app fails.</p>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :description="error" />

    <ul class="space-y-2" aria-label="Authorized apps">
      <li
        v-for="app in apps"
        :key="app.clientId"
        class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-default px-3 py-2"
        :data-row-id="app.clientId"
      >
        <div class="min-w-0">
          <p class="text-sm font-medium">{{ appName(app) }}</p>
          <p class="truncate font-mono text-xs text-muted" :title="app.clientId">{{ clientLabel(app) }}</p>
          <a
            v-if="safeHttpUrl(app.uri)"
            :href="safeHttpUrl(app.uri) ?? undefined"
            target="_blank"
            rel="noopener noreferrer"
            class="block truncate text-xs text-primary hover:underline"
          >{{ app.uri }}</a>
        </div>
        <div class="flex flex-wrap gap-1">
          <UBadge v-for="scope in app.scopes" :key="scope" :label="scope" color="neutral" variant="subtle" size="xs" class="font-mono" />
        </div>
        <span class="text-xs text-muted">authorized <RelativeTime :value="app.createdAt" /></span>
        <div class="ms-auto flex gap-1">
          <UButton
            v-if="revokeArmedId === app.clientId"
            label="Cancel"
            size="xs"
            color="neutral"
            variant="ghost"
            :aria-label="`Keep access of ${appName(app)}`"
            @click="revokeArmedId = null"
          />
          <UButton
            :label="revokeArmedId === app.clientId ? 'Confirm revoke' : 'Revoke'"
            size="xs"
            color="error"
            :variant="revokeArmedId === app.clientId ? 'solid' : 'ghost'"
            :aria-label="`${revokeArmedId === app.clientId ? 'Confirm revoke' : 'Revoke'} ${appName(app)}`"
            @click="revoke(app)"
          />
        </div>
      </li>
      <li v-if="!loading && apps.length === 0" class="text-xs text-dimmed">No authorized apps.</li>
    </ul>
  </section>
</template>
