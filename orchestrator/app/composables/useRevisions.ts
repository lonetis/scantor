import type { MaybeRefOrGetter } from 'vue'

// Revisions (docs/api.md §4.10, docs/ui.md §5.7, §5.9, §9): the list of a task, one revision (1 s poll while it is
// queued or building) and the incremental build log reader (`afterLine`).

export const REVISION_BUILDING_POLL_MS = 1000
export const BUILD_LOG_PAGE = 1000

export function isRevisionActive(state: RevisionState | null | undefined): boolean {
  return state === 'queued' || state === 'building'
}

export function useRevisions(taskId: MaybeRefOrGetter<string>, state: MaybeRefOrGetter<RevisionState | null>) {
  const api = useApi()
  const list = useCursorList<RevisionSummary>((cursor) =>
    api<Page<RevisionSummary>>(`/api/tasks/${encodeURIComponent(toValue(taskId))}/revisions`, {
      query: apiQuery({ state: toValue(state), cursor, limit: 50 }),
      background: true,
    }),
  )
  watch([() => toValue(taskId), () => toValue(state)], () => {
    list.reset().catch((cause: unknown) => console.error('[revisions] loading revisions failed', cause))
  })
  return list
}

export function useRevision(taskId: MaybeRefOrGetter<string>, revision: MaybeRefOrGetter<string>) {
  const api = useApi()
  const current = shallowRef<Revision | null>(null)
  const error = shallowRef<ApiError | null>(null)

  async function load(): Promise<void> {
    try {
      current.value = await api<Revision>(`/api/tasks/${encodeURIComponent(toValue(taskId))}/revisions/${encodeURIComponent(toValue(revision))}`, { background: true })
      error.value = null
    } catch (cause) {
      error.value = toApiError(cause)
      throw error.value
    }
  }

  const poll = usePoll(load, { intervalMs: () => (isRevisionActive(current.value?.state) || !current.value ? REVISION_BUILDING_POLL_MS : 30_000) })
  watch([() => toValue(taskId), () => toValue(revision)], () => {
    current.value = null
    void poll.refresh()
  })
  return { revision: current, error, refreshing: poll.running, refresh: poll.refresh }
}

/**
 * The build log of a revision, read incrementally every second while the build runs and until the log is complete
 * (docs/ui.md §5.9).
 */
export function useBuildLog(taskId: MaybeRefOrGetter<string>, revision: MaybeRefOrGetter<string>, active: MaybeRefOrGetter<boolean>) {
  const api = useApi()
  const lines = shallowRef<BuildLogLine[]>([])
  const complete = ref(false)
  const error = shallowRef<ApiError | null>(null)
  let nextLine = 0

  async function read(): Promise<void> {
    for (;;) {
      const page = await api<BuildLogPage>(`/api/tasks/${encodeURIComponent(toValue(taskId))}/revisions/${encodeURIComponent(toValue(revision))}/logs`, {
        query: { afterLine: String(nextLine), limit: String(BUILD_LOG_PAGE) },
        background: true,
      })
      if (page.lines.length > 0) lines.value = [...lines.value, ...page.lines]
      nextLine = page.nextLine
      complete.value = page.complete
      error.value = null
      if (page.lines.length < BUILD_LOG_PAGE || page.complete) return
    }
  }

  const poll = usePoll(
    async () => {
      try {
        await read()
      } catch (cause) {
        error.value = toApiError(cause)
        throw error.value
      }
    },
    { intervalMs: REVISION_BUILDING_POLL_MS, enabled: () => !complete.value && toValue(active) },
  )
  // A finished build is read once in full.
  watch(() => toValue(active), (isActive) => {
    if (!isActive && !complete.value) void poll.refresh()
  }, { immediate: true })
  watch([() => toValue(taskId), () => toValue(revision)], () => {
    lines.value = []
    nextLine = 0
    complete.value = false
    void poll.refresh()
  })

  return { lines, complete, error, refresh: poll.refresh }
}
