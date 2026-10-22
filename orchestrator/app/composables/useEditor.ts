// The caller's browser editor (docs/ui.md §5.10, §5.17; docs/api.md §4.18): its state, one-time session URLs for
// the iframe or a new tab, and stopping it. The editor page and the account section each hold their own instance.

/** Poll intervals of getEditor (docs/ui.md §9): fast while a transition runs, slow otherwise. */
export const EDITOR_TRANSITION_POLL_MS = 2_000
export const EDITOR_IDLE_POLL_MS = 30_000

export function useEditor() {
  const api = useApi()
  const status = shallowRef<EditorStatus | null>(null)
  const stopping = ref(false)

  const state = computed(() => status.value?.state ?? null)
  const live = computed(() => state.value === 'starting' || state.value === 'running')
  const pollIntervalMs = computed(() =>
    state.value === 'starting' || state.value === 'stopping' ? EDITOR_TRANSITION_POLL_MS : EDITOR_IDLE_POLL_MS,
  )

  /** getEditor; background loads (polls) never toast. */
  async function load(options: { background?: boolean } = {}): Promise<EditorStatus> {
    const result = await api<EditorStatus>('/api/editor', { background: options.background ?? false })
    status.value = result
    return result
  }

  /**
   * createEditorSession: starts the editor when needed and returns a fresh one-time URL (valid 60 s, single use).
   * Errors are not toasted; callers show them inline (429 when every editor slot is busy).
   */
  async function openSession(task?: string | null): Promise<EditorSession> {
    const session = await api<EditorSession>('/api/editor/session', {
      method: 'POST',
      body: task ? { open: task } : {},
      toast: false,
    })
    status.value = {
      state: session.editor.state,
      startedAt: session.editor.startedAt,
      lastActivityAt: session.editor.lastActivityAt,
      idleTimeoutMs: status.value?.idleTimeoutMs ?? 0,
      error: null,
    }
    return session
  }

  /** stopEditor, then the new state. */
  async function stop(): Promise<void> {
    stopping.value = true
    try {
      await api('/api/editor', { method: 'DELETE' })
      await load()
    } finally {
      stopping.value = false
    }
  }

  return { status, state, live, stopping: readonly(stopping), pollIntervalMs, load, openSession, stop }
}

/** "stops after 30 min idle" from `idleTimeoutMs`. */
export function idleTimeoutText(idleTimeoutMs: number | null | undefined): string | null {
  if (!idleTimeoutMs) return null
  const minutes = Math.round(idleTimeoutMs / 60_000)
  return minutes >= 120 && minutes % 60 === 0 ? `stops after ${minutes / 60} h idle` : `stops after ${minutes} min idle`
}
