<script setup lang="ts">
// Scan detail (docs/ui.md §5.13): header, lifecycle controls and the tabs overview, results, query, workers,
// events and exports (`?tab=`). The analysis drawer follows `?analysis=<seq>` itself, so it opens from any tab.
// Results, query, exports and the drawer are components of the results area.
const route = useRoute()
const router = useRouter()
const api = useApi()
const { isAdmin } = useAuth()

const scanId = computed(() => String(route.params.scanId))
const { scan, error, loaded, polling, refresh, set } = useScan(scanId)

useHead({ title: computed(() => `${scan.value?.name || (scan.value ? `Scan ${shortId(scan.value.id)}` : 'Scan')} · scantor`) })

const TABS = [
  { label: 'Overview', value: 'overview', icon: 'i-lucide-gauge' },
  { label: 'Results', value: 'results', icon: 'i-lucide-table' },
  { label: 'Query', value: 'query', icon: 'i-lucide-search-code' },
  { label: 'Workers', value: 'workers', icon: 'i-lucide-cpu' },
  { label: 'Events', value: 'events', icon: 'i-lucide-history' },
  { label: 'Exports', value: 'exports', icon: 'i-lucide-download' },
] as const
type Tab = (typeof TABS)[number]['value']

const tab = computed<Tab>({
  get: () => {
    const value = route.query.tab
    return TABS.some((candidate) => candidate.value === value) ? (value as Tab) : 'overview'
  },
  set: (value) => void router.replace({ query: { ...route.query, tab: value === 'overview' ? undefined : value } }),
})

const terminal = computed(() => scan.value !== null && !['creating', 'running', 'paused'].includes(scan.value.state))
const running = computed(() => scan.value?.state === 'running')

// Resume from the breakerTripped condition.
const scanRef = computed(() => scan.value)
const actions = useScanActions(scanRef, { onChanged: set })
const canResume = computed(() => actions.available.value.has('resume'))

// Owner (admins).
const ownerEmail = ref<string | null | undefined>(undefined)
watch(() => scan.value?.userId, async (userId) => {
  if (!isAdmin.value || !userId) return
  ownerEmail.value = null
  const owner = await api<User>(`/api/users/${encodeURIComponent(userId)}`, { background: true }).catch(() => null)
  ownerEmail.value = owner?.email ?? null
}, { immediate: true })

// Workers tab.
const NON_TERMINAL_WORKER_STATES: WorkerState[] = ['pending', 'assigned', 'pulling', 'starting', 'running', 'backoff', 'draining']
const workerStateFilter = ref<WorkerState[]>([...NON_TERMINAL_WORKER_STATES])
const workerStateItems = WORKER_STATES.map((state) => ({ label: state, value: state }))
const workersVisible = computed(() => tab.value === 'workers' && scan.value !== null)
const workers = useWorkers(scanId, { state: workerStateFilter, enabled: () => workersVisible.value && !terminal.value })
watch(workersVisible, (visible) => {
  if (visible && terminal.value) void workers.reset()
})
const { inflight, refresh: refreshInflight } = useInflight(scanId, () => workersVisible.value && running.value)
const logsWorker = shallowRef<ScanWorker | null>(null)
const logsOpen = ref(false)
function showLogs(worker: ScanWorker): void {
  logsWorker.value = worker
  logsOpen.value = true
}

// Events tab.
const EVENT_TYPES = [
  { label: 'All events', value: 'all' },
  { label: 'Scan events', value: 'scan.' },
  { label: 'Worker events', value: 'worker.' },
]
const eventType = ref('all')
const events = useEvents(scanId, { type: () => (eventType.value === 'all' ? null : eventType.value), enabled: () => tab.value === 'events' && scan.value !== null })

async function refreshAll(): Promise<void> {
  await refresh()
  if (tab.value === 'workers') await Promise.all([workers.refresh(), refreshInflight()])
  if (tab.value === 'events') await events.refresh()
}
</script>

<template>
  <UDashboardPanel id="scan">
    <template #header>
      <UDashboardNavbar :title="scan?.name || (scan ? `Scan ${shortId(scan.id)}` : 'Scan')">
        <template #leading>
          <SidebarCollapseButton />
        </template>
        <template #right>
          <RefreshButton :loading="polling" @click="refreshAll()" />
        </template>
      </UDashboardNavbar>
      <UDashboardToolbar v-if="scan">
        <UTabs v-model="tab" :items="[...TABS]" :content="false" variant="link" size="sm" aria-label="Scan tabs" />
      </UDashboardToolbar>
    </template>

    <template #body>
      <EmptyState
        v-if="loaded && !scan && error"
        icon="i-lucide-radar"
        :title="error.code === 'notFound' ? 'Scan not found' : 'The scan could not be loaded'"
        :description="error.code === 'notFound' ? 'It does not exist or belongs to someone else.' : error.message"
        action-label="All scans"
        action-to="/scans"
      />
      <div v-else-if="!scan" class="text-sm text-muted">Loading…</div>

      <div v-else class="space-y-6">
        <div class="space-y-3">
          <ScanHeader :scan="scan" :owner-email="isAdmin ? ownerEmail : undefined" />
          <ScanControls :scan="scan" @changed="set" />
        </div>

        <template v-if="tab === 'overview'">
          <ScanProgress
            :progress="scan.progress"
            :rate-per-min="scan.stats.ratePerMin"
            :scheduling="scan.scheduling"
            :label="`Progress of ${scan.name || shortId(scan.id)}`"
          />
          <ScanStats :scan-id="scan.id" :stats="scan.stats" />
          <ScanHealth :scan-id="scan.id" :conditions="scan.conditions" :can-resume="canResume" @resume="actions.resume()" />
          <ScanSettingsCard :scan="scan" />
        </template>

        <ScanResultsTable v-else-if="tab === 'results'" :scan="scan" />

        <QueryConsole v-else-if="tab === 'query'" :scan="scan" />

        <template v-else-if="tab === 'workers'">
          <section aria-labelledby="workers-heading" class="space-y-2">
            <div class="flex flex-wrap items-center gap-2">
              <h2 id="workers-heading" class="section-label">Workers</h2>
              <span class="text-xs text-muted tabular-nums">{{ scan.workers.active }} active · {{ scan.workers.pending }} pending · {{ scan.workers.desired }} desired</span>
              <USelectMenu
                v-model="workerStateFilter"
                :items="workerStateItems"
                value-key="value"
                multiple
                placeholder="All states"
                class="ms-auto w-64"
                aria-label="Filter workers by state"
              />
            </div>
            <WorkersTable :workers="workers.items.value" :loading="workers.loading.value" @logs="showLogs" />
            <LoadMoreButton :has-more="workers.hasMore.value" :loading="workers.loading.value" @load="workers.loadMore()" />
          </section>
          <section aria-labelledby="inflight-heading" class="space-y-2">
            <h2 id="inflight-heading" class="section-label">In flight</h2>
            <InflightTable :inflight="inflight" />
          </section>
          <WorkerLogsModal v-model:open="logsOpen" :scan-id="scan.id" :worker="logsWorker" />
        </template>

        <section v-else-if="tab === 'events'" aria-labelledby="events-heading" class="space-y-2">
          <div class="flex flex-wrap items-center gap-2">
            <h2 id="events-heading" class="section-label">Events</h2>
            <USelect v-model="eventType" :items="EVENT_TYPES" class="ms-auto w-48" aria-label="Filter events by type" />
          </div>
          <EventTimeline v-if="events.items.value.length > 0" :events="events.items.value" />
          <p v-else-if="events.loaded.value" class="text-sm text-dimmed">No events.</p>
          <LoadMoreButton :has-more="events.hasMore.value" :loading="events.loading.value" @load="events.loadMore()" />
        </section>

        <ExportsPanel v-else-if="tab === 'exports'" :scan="scan" />
      </div>

      <AnalysisSlideover v-if="scan" :scan="scan" />
    </template>
  </UDashboardPanel>
</template>
