import type { EffectScope } from 'vue'

// Singleton poll for the sidebar badges (docs/ui.md §3.2, §9): the caller's scans in creating/running/paused
// and, for admins, the offline nodes. One poll for every consumer; it lives until the next full page load.

const SIDEBAR_POLL_MS = 15_000
/** Largest page the list APIs return; a full page shows as "200+". */
const COUNT_LIMIT = 200

const activeScans = ref<number | null>(null)
const activeScansCapped = ref(false)
const offlineNodes = ref<number | null>(null)
let scope: EffectScope | null = null
let refreshNow: (() => Promise<void>) | null = null

export function useSidebarCounts() {
  if (!scope) {
    const api = useApi()
    const { user, isAdmin } = useAuth()
    scope = effectScope(true)
    scope.run(() => {
      const poll = usePoll(async () => {
        const userId = user.value?.id
        if (!userId) return
        const scans = await api<Page<ScanSummary>>('/api/scans', {
          query: apiQuery({ state: [...ACTIVE_SCAN_STATES], userId, limit: COUNT_LIMIT }),
          background: true,
        })
        activeScans.value = scans.items.length
        activeScansCapped.value = scans.nextCursor !== null
        if (isAdmin.value) {
          const nodes = await api<ItemList<ScantorNode>>('/api/nodes', { query: { state: 'offline' }, background: true })
          offlineNodes.value = nodes.items.length
        }
      }, { intervalMs: SIDEBAR_POLL_MS, enabled: () => user.value !== null })
      refreshNow = poll.refresh
    })
  }

  const activeScansLabel = computed(() => {
    if (activeScans.value === null || activeScans.value === 0) return null
    return activeScansCapped.value ? `${activeScans.value}+` : String(activeScans.value)
  })

  return {
    activeScans: readonly(activeScans),
    activeScansLabel,
    offlineNodes: readonly(offlineNodes),
    refresh: () => refreshNow?.() ?? Promise.resolve(),
  }
}
