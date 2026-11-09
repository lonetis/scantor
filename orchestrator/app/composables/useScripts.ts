import { refDebounced } from '@vueuse/core'
import { computed, ref, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import type { CreateScriptBody } from '#shared/schemas/scripts'
import { isScriptRunActive } from './useScriptRuns'

// Scripts (docs/api.md tags `scripts` and `script-files`, docs/ui.md §5, §9): the list (30 s poll), one script (10 s
// poll, 3 s while its latest run is active), the searchable script choices of the scan page's "Run script" dialog, and
// the script mutations and file reads. Mutations that forms show inline pass `toast: false` and throw ApiError.

export const SCRIPTS_POLL_MS = 30_000
export const SCRIPT_POLL_MS = 10_000
export const SCRIPT_ACTIVE_RUN_POLL_MS = 3000
export const SCRIPT_SEARCH_DEBOUNCE_MS = 300
/** The longest `q` that listScripts accepts. */
export const SCRIPT_SEARCH_MAX_LENGTH = 64
const SCRIPT_CHOICES_LIMIT = 50

export interface ScriptFilters {
  q?: string
  /** admins: restrict to this owner */
  userId?: string | null
}

/** The path of one script's routes (`{script}` is its id or, among the caller's own scripts, its name). */
export function scriptPath(script: string): string {
  return `/api/scripts/${encodeURIComponent(script)}`
}

/** The config schema the run form uses: the described one while it belongs to the folder's current code. */
export function currentConfigSchema(script: Pick<Script, 'describe' | 'workspace'> | null | undefined): Record<string, unknown> | null {
  const describe = script?.describe
  if (!describe?.configSchema || !script?.workspace.packSha256) return null
  return describe.packSha256 === script.workspace.packSha256 ? describe.configSchema : null
}

export function useScripts(filters: MaybeRefOrGetter<ScriptFilters>) {
  const api = useApi()
  const list = useCursorList<Script>((cursor, { background }) => {
    const current = toValue(filters)
    return api<Page<Script>>('/api/scripts', {
      query: apiQuery({ q: current.q?.trim() || null, userId: current.userId ?? null, cursor, limit: 50 }),
      background,
    })
  })
  usePoll(() => list.refresh({ background: true }), { intervalMs: SCRIPTS_POLL_MS, immediate: false })
  watch(() => JSON.stringify(toValue(filters)), () => {
    list.reset().catch((cause: unknown) => console.error('[scripts] loading scripts failed', cause))
  })
  return list
}

function hasActiveRun(script: Script | null): boolean {
  return isScriptRunActive(script?.latestRun?.state)
}

/** One script, polled while the page is visible. */
export function useScript(scriptId: MaybeRefOrGetter<string>) {
  const api = useApi()
  const script = shallowRef<Script | null>(null)
  const error = shallowRef<ApiError | null>(null)

  async function load(): Promise<void> {
    try {
      script.value = await api<Script>(scriptPath(toValue(scriptId)), { background: true })
      error.value = null
    } catch (cause) {
      error.value = toApiError(cause)
      throw error.value
    }
  }

  const poll = usePoll(load, { intervalMs: () => (hasActiveRun(script.value) ? SCRIPT_ACTIVE_RUN_POLL_MS : SCRIPT_POLL_MS) })
  watch(() => toValue(scriptId), () => {
    script.value = null
    void poll.refresh()
  })

  return { script, error, refreshing: poll.running, refresh: poll.refresh }
}

/**
 * The scripts a search offers (the scan page's "Run script" dialog): the matches of `listScripts?q=<typed text>`
 * (debounced) among the scripts of `owner`, because a script run reads only scans of the script's owner. Nothing is
 * loaded while `owner` is null (the dialog is closed).
 */
export function useScriptChoices(owner: MaybeRefOrGetter<string | null>) {
  const api = useApi()
  const search = ref('')
  const query = refDebounced(computed(() => search.value.trim().slice(0, SCRIPT_SEARCH_MAX_LENGTH)), SCRIPT_SEARCH_DEBOUNCE_MS)
  const scripts = shallowRef<Script[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = shallowRef<ApiError | null>(null)
  let generation = 0

  async function load(): Promise<void> {
    const current = ++generation
    const userId = toValue(owner)
    if (userId === null) {
      loading.value = false
      return
    }
    loading.value = true
    try {
      const page = await api<Page<Script>>('/api/scripts', {
        query: apiQuery({ q: query.value || null, userId, limit: SCRIPT_CHOICES_LIMIT }),
        toast: false,
      })
      if (current !== generation) return
      scripts.value = page.items
      error.value = null
      loaded.value = true
    } catch (cause) {
      if (current === generation) error.value = toApiError(cause)
    } finally {
      if (current === generation) loading.value = false
    }
  }

  watch([query, () => toValue(owner)], () => void load())

  return { search, scripts, loading, loaded, error, load }
}

/** Script mutations and on-demand reads. */
export function useScriptActions() {
  const api = useApi()

  return {
    createScript: (body: CreateScriptBody) => api<Script>('/api/scripts', { method: 'POST', body, toast: false }),
    deleteScript: (script: string) => api<DeleteScriptResult>(scriptPath(script), { method: 'DELETE', toast: false }),
    listFiles: (script: string, options: { path?: string; recursive?: boolean } = {}) =>
      api<ScriptFileList>(`${scriptPath(script)}/files`, {
        query: apiQuery({ path: options.path ?? '', recursive: options.recursive ?? true }),
        toast: false,
      }),
    readFile: (script: string, filePath: string) =>
      api<ScriptFileContent>(`${scriptPath(script)}/files/content`, { query: apiQuery({ path: filePath }), toast: false }),
    workspaceArchiveUrl: (script: string) => `${scriptPath(script)}/workspace/archive`,
  }
}
