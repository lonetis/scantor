<script setup lang="ts">
// Scans list (docs/ui.md §5.11): state and task filters (and "Only mine" for admins), the scans table with row
// actions, "Load more", a 10 s poll. Filters are remembered in the UI prefs; `?task=` and `?state=` preselect them.
useHead({ title: 'Scans · scantor' })

const api = useApi()
const route = useRoute()
const router = useRouter()
const { isAdmin, user } = useAuth()
const prefs = useUiPrefs()

// `?task=` and `?state=` preselect the filters (the taskInUse toast links to the active scans of a task).
const initial = initialScanFilters(route.query, prefs.getFilters<StoredScanFilters>('scans'))
const stateFilter = ref<ScanState[]>(initial.state)
const taskFilter = ref<string | null>(initial.task)
const onlyMine = ref(initial.onlyMine)

watch([stateFilter, taskFilter, onlyMine], () => {
  prefs.setFilters('scans', { state: stateFilter.value, task: taskFilter.value, onlyMine: onlyMine.value })
  // Once the filters change, the query no longer describes them; drop it so a reload shows the remembered ones.
  if (route.query.task !== undefined || route.query.state !== undefined) {
    void router.replace({ query: { ...route.query, task: undefined, state: undefined } })
  }
}, { deep: true })

const filters = computed<ScanListFilters>(() => ({
  state: stateFilter.value,
  task: taskFilter.value,
  userId: isAdmin.value && onlyMine.value ? (user.value?.id ?? null) : null,
}))
const scans = useScans(filters)

const stateItems = SCAN_STATES.map((state) => ({ label: state, value: state }))
// The task filter searches every task (listTasks?q=); the remembered or linked task is loaded so its name shows.
const { search: taskSearch, tasks, load: loadTasks, choose: chooseTask, resolve: resolveTask } = useTaskChoices()
const taskItems = computed(() => [{ label: 'All tasks', value: null }, ...tasks.value.map((task) => ({ label: task.name, value: task.id }))])
watch(taskFilter, (taskId) => chooseTask(taskId))
onMounted(() => {
  loadTasks().catch((error: unknown) => console.error('[scans] loading the tasks failed', error))
  if (taskFilter.value) resolveTask(taskFilter.value).catch((error: unknown) => console.warn('[scans] the filtered task could not be loaded', error))
})

// Owner column for admins: emails resolved once per user id.
const ownerEmails = ref<Record<string, string>>({})
watch(() => scans.items.value.map((scan) => scan.userId), async (userIds) => {
  if (!isAdmin.value) return
  for (const userId of new Set(userIds)) {
    if (ownerEmails.value[userId]) continue
    const owner = await api<User>(`/api/users/${encodeURIComponent(userId)}`, { background: true }).catch(() => null)
    if (owner) ownerEmails.value = { ...ownerEmails.value, [userId]: owner.email }
  }
})

// Row actions act on the chosen scan; restart asks for the clone's name and scaling first.
const current = shallowRef<ScanSummary | null>(null)
const actions = useScanActions(current, { onChanged: () => void scans.refresh() })
const restartOpen = ref(false)

async function onAction(action: ScanAction, scan: ScanSummary): Promise<void> {
  current.value = scan
  switch (action) {
    case 'pause':
      await actions.pause()
      break
    case 'resume':
      await actions.resume()
      break
    case 'cancel':
      await actions.cancel()
      break
    case 'restart':
      restartOpen.value = true
      break
    case 'delete':
      if (await actions.remove()) await scans.refresh()
      break
    default:
      await navigateTo(`/scans/${scan.id}`)
  }
}

async function restart(values: { name?: string, settings?: { workers?: number, processes?: number } }): Promise<void> {
  if (await actions.restart(values)) restartOpen.value = false
}
</script>

<template>
  <UDashboardPanel id="scans">
    <template #header>
      <UDashboardNavbar title="Scans">
        <template #leading>
          <SidebarCollapseButton />
        </template>
        <template #right>
          <RefreshButton :loading="scans.polling.value" @click="scans.refresh()" />
          <UButton label="New scan" icon="i-lucide-play" to="/scans/new" size="sm" />
        </template>
      </UDashboardNavbar>
      <UDashboardToolbar>
        <div class="flex flex-wrap items-center gap-2 py-1">
          <USelectMenu
            v-model="stateFilter"
            :items="stateItems"
            value-key="value"
            multiple
            placeholder="All states except deleted"
            class="w-64"
            aria-label="Filter by state"
          />
          <USelectMenu
            v-model="taskFilter"
            v-model:search-term="taskSearch"
            :items="taskItems"
            value-key="value"
            ignore-filter
            placeholder="All tasks"
            :search-input="{ placeholder: 'Search tasks…' }"
            class="w-56"
            aria-label="Filter by task"
          />
          <USwitch v-if="isAdmin" v-model="onlyMine" label="Only mine" />
        </div>
      </UDashboardToolbar>
    </template>

    <template #body>
      <EmptyState
        v-if="scans.loaded.value && scans.items.value.length === 0 && stateFilter.length === 0 && !taskFilter"
        icon="i-lucide-radar"
        title="No scans yet"
        description="A scan runs a published task revision over many analyses."
        action-label="New scan"
        action-to="/scans/new"
        action-icon="i-lucide-play"
      />
      <template v-else>
        <ScanTable
          :scans="scans.items.value"
          :loading="scans.loading.value"
          :owner-emails="isAdmin && !onlyMine ? ownerEmails : null"
          @action="onAction"
        />
        <LoadMoreButton :has-more="scans.hasMore.value" :loading="scans.loading.value" @load="scans.loadMore()" />
      </template>
      <RestartModal v-if="current" v-model:open="restartOpen" :scan="current" :saving="actions.busy.value === 'restart'" @submit="restart" />
    </template>
  </UDashboardPanel>
</template>
