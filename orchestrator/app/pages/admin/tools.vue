<script setup lang="ts">
import { JOB_KINDS, JOB_STATES } from '#shared/utils/enums'

// Admin tools (docs/ui.md §5.20): the infrastructure GUIs behind Traefik forwardAuth, API links, platform health and
// the background jobs of all users.
definePageMeta({ admin: true })
useHead({ title: 'Admin tools · scantor' })

const HEALTH_POLL_MS = 15_000
const JOBS_POLL_MS = 10_000
const ANY = 'any'

const { adminTools, loadInfo, health, healthError, loadHealth, filters, jobs } = useTools()

const kindFilter = ref<string>(ANY)
const stateFilter = ref<string>(ANY)
const kindItems = [{ label: 'Any kind', value: ANY }, ...JOB_KINDS.map((kind) => ({ label: kind, value: kind }))]
const stateItems = [{ label: 'Any state', value: ANY }, ...JOB_STATES.map((state) => ({ label: state, value: state }))]

watch([kindFilter, stateFilter], ([kind, state]) => {
  filters.kind = kind === ANY ? null : (kind as JobKind)
  filters.state = state === ANY ? null : (state as JobState)
  jobs.reset().catch((error: unknown) => console.error('[tools] loading jobs failed', error))
})

const links = [
  { label: 'API reference', description: 'Interactive OpenAPI reference (Scalar)', to: '/api/docs', icon: 'i-lucide-book-open' },
  { label: 'OpenAPI document', description: 'The OpenAPI 3.1 document of the REST API', to: '/api/docs/openapi.json', icon: 'i-lucide-file-json' },
  { label: 'Metrics', description: 'Prometheus text format; scrape it with an admin API key', to: '/api/metrics', icon: 'i-lucide-activity' },
]

const healthComponents = computed(() => (health.value ? (Object.entries(health.value.components) as [string, ComponentHealth][]) : []))

const healthPoll = usePoll(() => loadHealth({ background: true }), { intervalMs: HEALTH_POLL_MS })
const jobsPoll = usePoll(() => jobs.refresh(), { intervalMs: JOBS_POLL_MS, immediate: false })

onMounted(() => {
  loadInfo().catch((error: unknown) => console.error('[tools] loading instance info failed', error))
  jobs.reset().catch((error: unknown) => console.error('[tools] loading jobs failed', error))
})

function loadMoreJobs(): void {
  jobs.loadMore().catch((error: unknown) => console.error('[tools] loading more jobs failed', error))
}

async function refreshAll(): Promise<void> {
  await Promise.allSettled([healthPoll.refresh(), jobsPoll.refresh()])
}
</script>

<template>
  <UDashboardPanel id="admin-tools">
    <template #header>
      <UDashboardNavbar title="Admin tools">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <RefreshButton :loading="jobs.loading.value || jobs.refreshing.value || healthPoll.running.value" @click="refreshAll" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-6xl space-y-8">
        <section class="space-y-3" aria-labelledby="tools-heading">
          <h2 id="tools-heading" class="text-[10px] font-semibold uppercase tracking-wider text-dimmed">Infrastructure tools</h2>
          <UAlert
            v-if="adminTools && !adminTools.enabled"
            color="neutral"
            variant="subtle"
            icon="i-lucide-info"
            title="Traefik is not enabled"
            description="Without Traefik the admin tools are published only on SCANTOR_ADMIN_BIND_ADDRESS. Reach them through an SSH tunnel; they ask for their own credentials."
          />
          <div v-if="adminTools" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <ToolCard v-for="item in adminTools.items" :key="item.target" :item="item" />
          </div>
          <p v-else class="text-xs text-dimmed">Loading…</p>
          <p v-if="adminTools?.enabled" class="text-xs text-muted">
            Opening a tool sets an admin-only cookie for the tool hosts (valid 8 hours). The tools still ask for their own credentials.
          </p>
        </section>

        <section class="space-y-3" aria-labelledby="links-heading">
          <h2 id="links-heading" class="text-[10px] font-semibold uppercase tracking-wider text-dimmed">API</h2>
          <ul class="grid gap-2 sm:grid-cols-3">
            <li v-for="link in links" :key="link.to">
              <ULink :to="link.to" external target="_blank" class="flex items-start gap-2 rounded-md border border-default p-3 text-sm hover:bg-elevated">
                <UIcon :name="link.icon" class="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                <span>
                  <span class="font-medium text-highlighted">{{ link.label }}</span>
                  <span class="block text-xs text-muted">{{ link.description }}</span>
                </span>
              </ULink>
            </li>
          </ul>
        </section>

        <section class="space-y-3" aria-labelledby="health-heading">
          <div class="flex items-center gap-2">
            <h2 id="health-heading" class="text-[10px] font-semibold uppercase tracking-wider text-dimmed">Health</h2>
            <UBadge
              v-if="health"
              :label="health.status"
              :color="health.status === 'ok' ? 'success' : 'warning'"
              variant="subtle"
              size="xs"
            />
            <span v-if="health" class="text-xs text-dimmed">version {{ health.version }}</span>
          </div>
          <ul v-if="health" class="grid gap-2 sm:grid-cols-4" aria-label="Platform components">
            <li v-for="[name, value] in healthComponents" :key="name" class="flex items-center justify-between rounded-md border border-default px-3 py-2 text-sm">
              <span class="font-mono text-xs">{{ name }}</span>
              <UBadge :label="value" :color="value === 'ok' ? 'success' : 'error'" variant="subtle" size="xs" />
            </li>
          </ul>
          <UAlert
            v-if="health && health.alarms.length > 0"
            color="error"
            variant="subtle"
            icon="i-lucide-siren"
            title="RabbitMQ alarms"
            :description="health.alarms.join(', ')"
          />
          <p v-if="healthError" class="text-xs text-error" role="alert">Health could not be loaded: {{ healthError.message }}</p>
        </section>

        <section class="space-y-3" aria-labelledby="jobs-heading">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h2 id="jobs-heading" class="text-[10px] font-semibold uppercase tracking-wider text-dimmed">Jobs</h2>
            <div class="flex gap-2">
              <USelect v-model="kindFilter" :items="kindItems" size="sm" class="w-44" aria-label="Filter jobs by kind" />
              <USelect v-model="stateFilter" :items="stateItems" size="sm" class="w-36" aria-label="Filter jobs by state" />
            </div>
          </div>
          <JobsTable :jobs="jobs.items.value" :loading="jobs.loading.value && !jobs.loaded.value" />
          <p v-if="jobs.error.value" class="text-xs text-error" role="alert">{{ errorMessage(jobs.error.value, 'Jobs could not be loaded.') }}</p>
          <LoadMoreButton :has-more="jobs.hasMore.value" :loading="jobs.loading.value" @load="loadMoreJobs" />
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
