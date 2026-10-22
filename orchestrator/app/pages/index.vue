<script setup lang="ts">
import type { ScantorNode } from '#shared/types/nodes'

// Overview (docs/ui.md §5.4): active scans, scans that need attention, recent scans and tasks, platform health
// for admins, and quick actions. Polls every 10 s while visible.
useHead({ title: 'Overview · scantor' })

const OVERVIEW_POLL_MS = 10_000
const api = useApi()
const { isAdmin } = useAuth()

const activeScans = shallowRef<ScanSummary[]>([])
const failedScans = shallowRef<ScanSummary[]>([])
const recentScans = shallowRef<ScanSummary[]>([])
const recentTasks = shallowRef<Task[]>([])
const health = shallowRef<Health | null>(null)
const nodes = shallowRef<ScantorNode[]>([])
const loaded = ref(false)

async function load(background: boolean): Promise<void> {
  const options = { background, toast: !background }
  const [active, failed, recent, tasks] = await Promise.all([
    api<Page<ScanSummary>>('/api/scans', { query: { state: ACTIVE_SCAN_STATES.join(','), limit: 20 }, ...options }),
    api<Page<ScanSummary>>('/api/scans', { query: { state: 'failed', limit: 10 }, ...options }),
    api<Page<ScanSummary>>('/api/scans', { query: { limit: 10 }, ...options }),
    api<Page<Task>>('/api/tasks', { query: { limit: 5 }, ...options }),
  ])
  activeScans.value = active.items
  failedScans.value = failed.items
  recentScans.value = recent.items
  recentTasks.value = tasks.items
  if (isAdmin.value) {
    const [healthResult, nodeList] = await Promise.all([
      api<Health>('/api/health', options),
      api<ItemList<ScantorNode>>('/api/nodes', options),
    ])
    health.value = healthResult
    nodes.value = nodeList.items
  }
  loaded.value = true
}

const poll = usePoll(() => load(loaded.value), { intervalMs: OVERVIEW_POLL_MS })

const attention = computed(() => {
  const seen = new Set<string>()
  return [...activeScans.value.filter((scan) => scan.conditionsCount > 0), ...failedScans.value]
    .filter((scan) => (seen.has(scan.id) ? false : (seen.add(scan.id), true)))
})

const firstRun = computed(() => loaded.value && recentTasks.value.length === 0 && recentScans.value.length === 0)

function scanName(scan: ScanSummary): string {
  return scan.name || shortId(scan.id)
}

function attentionText(scan: ScanSummary): string {
  if (scan.state === 'failed') return scan.stateReason?.message || 'Failed'
  return `${plural(scan.conditionsCount, 'condition')} ${scan.conditionsCount === 1 ? 'needs' : 'need'} attention`
}

// Platform health (admins).
const HEALTH_COMPONENTS = ['mongo', 'rabbitmq', 's3', 'registry'] as const

function nodeCapacity(node: ScantorNode): number {
  const reported = node.info?.maxWorkers ?? 0
  return node.maxWorkers === null ? reported : Math.min(reported, node.maxWorkers)
}

const nodeStats = computed(() => {
  const online = nodes.value.filter((node) => node.state === 'online')
  return {
    online: online.length,
    offline: nodes.value.filter((node) => node.state === 'offline').length,
    total: nodes.value.length,
    freeCapacity: online.filter((node) => !node.cordoned).reduce((sum, node) => sum + Math.max(0, nodeCapacity(node) - node.activeWorkers), 0),
  }
})
</script>

<template>
  <UDashboardPanel id="index">
    <template #header>
      <UDashboardNavbar title="Overview">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <RefreshButton :loading="poll.running.value" @click="poll.refresh()" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <EmptyState
        v-if="firstRun"
        icon="i-lucide-package"
        title="No tasks yet"
        description="A task is a folder of code that scantor builds into an image and runs at scale."
        action-label="Create your first task"
        action-to="/tasks/new"
        action-icon="i-lucide-plus"
      />

      <template v-else>
        <section aria-labelledby="active-scans-heading" class="space-y-2">
          <h2 id="active-scans-heading" class="section-label">Active scans</h2>
          <div v-if="activeScans.length > 0" class="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
            <NuxtLink
              v-for="scan in activeScans"
              :key="scan.id"
              :to="`/scans/${scan.id}`"
              class="block space-y-2 rounded-lg border border-default p-3 transition-colors hover:bg-elevated/60"
              :data-row-id="scan.id"
            >
              <div class="flex items-center gap-2">
                <span class="min-w-0 flex-1 truncate text-sm font-semibold text-highlighted">{{ scanName(scan) }}</span>
                <UTooltip v-if="scan.conditionsCount > 0" :text="plural(scan.conditionsCount, 'condition')">
                  <span class="inline-flex items-center gap-0.5 text-xs text-warning">
                    <UIcon name="i-lucide-triangle-alert" class="size-3.5" aria-hidden="true" />{{ scan.conditionsCount }}
                    <span class="sr-only">conditions</span>
                  </span>
                </UTooltip>
                <StatusBadge kind="scan" :state="scan.state" />
              </div>
              <p class="font-mono text-xs text-muted">{{ scan.revision.ref }}</p>
              <ScanProgress :progress="scan.progress" compact :label="`Progress of ${scanName(scan)}`" />
              <div class="flex flex-wrap items-center gap-x-3 text-xs text-muted tabular-nums">
                <span>{{ formatRate(scan.stats.ratePerMin) }}</span>
                <span v-if="formatEta(scan.progress.etaSeconds)">{{ formatEta(scan.progress.etaSeconds) }}</span>
              </div>
            </NuxtLink>
          </div>
          <p v-else-if="loaded" class="text-sm text-dimmed">No scan is running.</p>
        </section>

        <section v-if="attention.length > 0" aria-labelledby="attention-heading" class="space-y-2">
          <h2 id="attention-heading" class="section-label">Needs attention</h2>
          <ul class="divide-y divide-default rounded-lg border border-default">
            <li v-for="scan in attention" :key="scan.id" class="flex flex-wrap items-center gap-2 px-3 py-2" :data-row-id="scan.id">
              <UIcon :name="scan.state === 'failed' ? 'i-lucide-circle-x' : 'i-lucide-triangle-alert'" :class="scan.state === 'failed' ? 'text-error' : 'text-warning'" class="size-4" aria-hidden="true" />
              <NuxtLink :to="`/scans/${scan.id}`" class="text-sm font-medium hover:underline">{{ scanName(scan) }}</NuxtLink>
              <StatusBadge kind="scan" :state="scan.state" />
              <span class="text-xs text-muted">{{ attentionText(scan) }}</span>
              <span class="ms-auto text-xs text-dimmed"><RelativeTime :value="scan.completedAt ?? scan.createdAt" /></span>
            </li>
          </ul>
        </section>

        <div class="grid gap-6 xl:grid-cols-3">
          <section aria-labelledby="recent-scans-heading" class="space-y-2 xl:col-span-2">
            <div class="flex items-center justify-between">
              <h2 id="recent-scans-heading" class="section-label">Recent scans</h2>
              <UButton label="All scans" to="/scans" color="neutral" variant="link" size="xs" trailing-icon="i-lucide-chevron-right" />
            </div>
            <ScanTable
              :scans="recentScans"
              :loading="!loaded"
              compact
              label="Recent scans"
              empty="No scans yet."
              class="rounded-lg border border-default"
            />
          </section>

          <section aria-labelledby="recent-tasks-heading" class="space-y-2">
            <div class="flex items-center justify-between">
              <h2 id="recent-tasks-heading" class="section-label">Recent tasks</h2>
              <UButton label="All tasks" to="/tasks" color="neutral" variant="link" size="xs" trailing-icon="i-lucide-chevron-right" />
            </div>
            <ul class="divide-y divide-default rounded-lg border border-default">
              <li v-for="task in recentTasks" :key="task.id" class="flex flex-wrap items-center gap-2 px-3 py-2" :data-row-id="task.id">
                <NuxtLink :to="`/tasks/${task.id}`" class="font-mono text-sm font-medium hover:underline">{{ task.name }}</NuxtLink>
                <UBadge :label="task.language" color="neutral" variant="subtle" size="xs" />
                <span v-if="task.latestRevision" class="inline-flex items-center gap-1">
                  <span class="font-mono text-xs text-muted">@{{ task.latestRevision.number }}</span>
                  <StatusBadge kind="revision" :state="task.latestRevision.state" />
                </span>
                <span v-else class="text-xs text-dimmed">no revision</span>
                <UBadge
                  v-if="task.workspace.dirty"
                  label="Unpublished changes"
                  color="warning"
                  variant="subtle"
                  size="xs"
                  data-testid="unpublished-badge"
                />
              </li>
              <li v-if="loaded && recentTasks.length === 0" class="px-3 py-2 text-sm text-dimmed">No tasks yet.</li>
            </ul>
          </section>
        </div>

        <section v-if="isAdmin && health" aria-labelledby="health-heading" class="space-y-2">
          <h2 id="health-heading" class="section-label">Platform health</h2>
          <div class="flex flex-wrap gap-6 rounded-lg border border-default p-3">
            <ul class="flex flex-wrap items-center gap-4" aria-label="Components">
              <li v-for="component in HEALTH_COMPONENTS" :key="component" class="flex items-center gap-1.5 text-sm">
                <span
                  class="size-2 rounded-full"
                  :class="health.components[component] === 'ok' ? 'bg-success' : 'bg-error'"
                  aria-hidden="true"
                />
                <span>{{ component }}</span>
                <span class="text-xs" :class="health.components[component] === 'ok' ? 'text-muted' : 'text-error'">{{ health.components[component] }}</span>
              </li>
            </ul>
            <div class="flex flex-wrap items-center gap-4 text-sm">
              <NuxtLink to="/admin/nodes" class="hover:underline">
                Nodes: <span class="text-success">{{ nodeStats.online }} online</span> ·
                <span :class="nodeStats.offline > 0 ? 'text-error' : 'text-muted'">{{ nodeStats.offline }} offline</span> ·
                {{ nodeStats.total }} total
              </NuxtLink>
              <span class="text-muted">free capacity: {{ plural(nodeStats.freeCapacity, 'worker') }}</span>
            </div>
            <UAlert
              v-if="health.alarms.length > 0"
              class="basis-full"
              color="error"
              variant="subtle"
              icon="i-lucide-circle-alert"
              title="RabbitMQ alarms"
              :description="health.alarms.join(', ')"
            />
          </div>
        </section>

        <section aria-labelledby="quick-actions-heading" class="space-y-2">
          <h2 id="quick-actions-heading" class="section-label">Quick actions</h2>
          <div class="flex flex-wrap gap-2">
            <UButton label="New task" icon="i-lucide-plus" color="neutral" variant="outline" size="sm" to="/tasks/new" />
            <UButton label="New scan" icon="i-lucide-play" color="neutral" variant="outline" size="sm" to="/scans/new" />
            <UButton label="CLI & MCP access" icon="i-lucide-terminal" color="neutral" variant="outline" size="sm" to="/account/access" />
          </div>
        </section>
      </template>
    </template>
  </UDashboardPanel>
</template>
