import { tryOnScopeDispose, useDocumentVisibility, useIntervalFn } from '@vueuse/core'
import type { MaybeRefOrGetter } from 'vue'

// Short polling (docs/ui.md §9): paused while the tab is hidden and refreshed when it becomes visible, one
// request in flight at a time, the interval doubles after each failure (up to 60 s) and resets on success.

const MAX_BACKOFF_MS = 60_000
/** Consecutive failures of one poll before the "Live updates paused" banner appears. */
export const LIVE_FAILURE_THRESHOLD = 3

// Module-level registry of failing polls; the default layout shows a banner while any poll is failing.
const failingPolls = ref(new Set<symbol>())

export function useLiveStatus() {
  const paused = computed(() => failingPolls.value.size > 0)
  return { paused }
}

function markFailing(id: symbol, failing: boolean): void {
  const has = failingPolls.value.has(id)
  if (failing === has) return
  const next = new Set(failingPolls.value)
  if (failing) next.add(id)
  else next.delete(id)
  failingPolls.value = next
}

export interface PollOptions {
  intervalMs: MaybeRefOrGetter<number>
  /** Polling runs only while this is true (for example "scan is running"). */
  enabled?: MaybeRefOrGetter<boolean>
  /** Run once right away (default true). */
  immediate?: boolean
}

export function usePoll(fn: () => Promise<unknown>, options: PollOptions) {
  const id = Symbol('poll')
  const visibility = useDocumentVisibility()
  const failures = ref(0)
  const running = ref(false)
  const lastError = shallowRef<unknown>(null)
  const enabled = computed(() => toValue(options.enabled ?? true))
  const interval = computed(() => {
    const base = Math.max(250, toValue(options.intervalMs))
    return failures.value === 0 ? base : Math.min(MAX_BACKOFF_MS, base * 2 ** failures.value)
  })

  async function tick(): Promise<void> {
    if (running.value) return
    running.value = true
    try {
      await fn()
      failures.value = 0
      lastError.value = null
      markFailing(id, false)
    } catch (error) {
      failures.value++
      lastError.value = error
      if (failures.value >= LIVE_FAILURE_THRESHOLD) markFailing(id, true)
    } finally {
      running.value = false
    }
  }

  const timer = useIntervalFn(tick, interval, { immediate: false })

  watch([enabled, visibility], ([isEnabled, isVisible], previous) => {
    const active = isEnabled && isVisible === 'visible'
    if (!active) {
      timer.pause()
      return
    }
    const wasHidden = previous !== undefined && previous[1] !== 'visible'
    const wasDisabled = previous !== undefined && !previous[0]
    if (previous === undefined ? options.immediate !== false : wasHidden || wasDisabled) void tick()
    timer.resume()
  }, { immediate: true })

  tryOnScopeDispose(() => markFailing(id, false))

  /** Fetches right away (the "Refresh" button), independent of the timer. */
  async function refresh(): Promise<void> {
    await tick()
  }

  return { refresh, running: readonly(running), failures: readonly(failures), lastError: readonly(lastError) }
}
