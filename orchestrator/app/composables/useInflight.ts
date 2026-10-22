import type { MaybeRefOrGetter } from 'vue'

// In-flight analyses of a scan (docs/ui.md §5.13.5): listInflightAnalyses (in memory on the server, from the
// runtimes' state polls) every 3 s while the workers tab is visible and the scan is running.

const INFLIGHT_POLL_MS = 3000

export function useInflight(scanId: MaybeRefOrGetter<string>, enabled: MaybeRefOrGetter<boolean>) {
  const api = useApi()
  const inflight = shallowRef<InflightList>({ items: [], updatedAt: null })

  async function load(background: boolean): Promise<void> {
    const id = toValue(scanId)
    const result = await api<InflightList>(`/api/scans/${encodeURIComponent(id)}/inflight`, { background, toast: !background })
    if (id === toValue(scanId)) inflight.value = result
  }

  const poll = usePoll(() => load(true), { intervalMs: INFLIGHT_POLL_MS, enabled })

  watch(() => toValue(scanId), () => {
    inflight.value = { items: [], updatedAt: null }
  })

  return { inflight, polling: poll.running, refresh: () => load(false).catch(() => {}) }
}
