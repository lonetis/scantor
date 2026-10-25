import { refDebounced } from '@vueuse/core'
import { computed, ref, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import type { CreateTaskBody, ImportGitBody } from '#shared/schemas/tasks'

// Tasks (docs/api.md §4.6–§4.8, docs/ui.md §5.5–§5.7, §9): the list (30 s poll), one task (10 s poll, 2 s while
// its latest revision builds), its files, and the task mutations. Mutations that forms show inline pass
// `toast: false` and throw ApiError.

export const TASKS_POLL_MS = 30_000
export const TASK_POLL_MS = 10_000
export const TASK_BUILDING_POLL_MS = 2000
export const TASK_SEARCH_DEBOUNCE_MS = 300
/** The longest `q` that listTasks accepts. */
export const TASK_SEARCH_MAX_LENGTH = 64
/** Matches per search: listTasks' maximum page, so an empty search still offers the newest 200 tasks. */
const TASK_CHOICES_LIMIT = 200

export interface TaskFilters {
  q?: string
  language?: string | null
  userId?: string | null
}

export function useTasks(filters: MaybeRefOrGetter<TaskFilters>) {
  const api = useApi()
  const list = useCursorList<Task>((cursor) => {
    const current = toValue(filters)
    return api<Page<Task>>('/api/tasks', {
      query: apiQuery({ q: current.q?.trim() || null, language: current.language ?? null, userId: current.userId ?? null, cursor, limit: 50 }),
      background: true,
    })
  })
  usePoll(() => list.refresh(), { intervalMs: TASKS_POLL_MS, immediate: false })
  watch(() => JSON.stringify(toValue(filters)), () => {
    list.reset().catch((cause: unknown) => console.error('[tasks] loading tasks failed', cause))
  })
  return list
}

function isBuilding(task: Task | null): boolean {
  const state = task?.latestRevision?.state
  return state === 'queued' || state === 'building'
}

/** One task, polled while the page is visible. */
export function useTask(taskId: MaybeRefOrGetter<string>) {
  const api = useApi()
  const task = shallowRef<Task | null>(null)
  const error = shallowRef<ApiError | null>(null)

  async function load(): Promise<void> {
    try {
      task.value = await api<Task>(`/api/tasks/${encodeURIComponent(toValue(taskId))}`, { background: true })
      error.value = null
    } catch (cause) {
      error.value = toApiError(cause)
      throw error.value
    }
  }

  const poll = usePoll(load, { intervalMs: () => (isBuilding(task.value) ? TASK_BUILDING_POLL_MS : TASK_POLL_MS) })
  watch(() => toValue(taskId), () => {
    task.value = null
    void poll.refresh()
  })

  return { task, error, refreshing: poll.running, refresh: poll.refresh }
}

/**
 * The tasks a searchable select offers (the new-scan task picker, the scans list's task filter): the matches of
 * `listTasks?q=<typed text>` (debounced), so every task of the caller can be found, not only the newest page, plus the
 * chosen task, which stays an item while the search shows others. `resolve` loads a task by id or name.
 */
export function useTaskChoices() {
  const api = useApi()
  const search = ref('')
  const query = refDebounced(computed(() => search.value.trim().slice(0, TASK_SEARCH_MAX_LENGTH)), TASK_SEARCH_DEBOUNCE_MS)
  const found = shallowRef<Task[]>([])
  const chosen = shallowRef<Task | null>(null)
  const loading = ref(false)
  let generation = 0

  async function load(): Promise<void> {
    const current = ++generation
    loading.value = true
    try {
      const page = await api<Page<Task>>('/api/tasks', { query: apiQuery({ q: query.value || null, limit: TASK_CHOICES_LIMIT }), toast: false })
      if (current === generation) found.value = page.items
    } finally {
      if (current === generation) loading.value = false
    }
  }

  watch(query, () => {
    load().catch((cause: unknown) => console.error('[tasks] searching tasks failed', cause))
  })

  const tasks = computed(() => (chosen.value && !found.value.some((task) => task.id === chosen.value!.id) ? [chosen.value, ...found.value] : found.value))

  /** Keeps the task with this id an item (from the current matches), or none. */
  function choose(taskId: string | null | undefined): void {
    chosen.value = taskId ? (tasks.value.find((task) => task.id === taskId) ?? null) : null
  }

  async function resolve(task: string): Promise<Task> {
    const resolved = await api<Task>(`/api/tasks/${encodeURIComponent(task)}`, { toast: false })
    chosen.value = resolved
    return resolved
  }

  return { search, tasks, loading, load, choose, resolve }
}

/** Task mutations and on-demand reads. */
export function useTaskActions() {
  const api = useApi()
  const path = (task: string) => `/api/tasks/${encodeURIComponent(task)}`

  return {
    createTask: (body: CreateTaskBody) => api<Task>('/api/tasks', { method: 'POST', body, toast: false }),
    importGitTask: (body: ImportGitBody) => api<ImportGitResult>('/api/tasks/import-git', { method: 'POST', body, toast: false }),
    uploadTask: (file: Blob, options: { publish: boolean; force: boolean; message?: string }) =>
      api<UploadTaskResult>('/api/tasks/upload', {
        method: 'POST',
        body: file,
        headers: { 'content-type': 'application/gzip' },
        query: apiQuery({ publish: options.publish, force: options.force, message: options.message?.trim() || null }),
        toast: false,
      }),
    deleteTask: (task: string) => api<{ job: JobRef }>(path(task), { method: 'DELETE', toast: false }),
    getWorkspace: (task: string) => api<TaskWorkspaceStatus>(`${path(task)}/workspace`, { toast: false }),
    pullGitTask: (task: string, force: boolean) => api<PullGitResult>(`${path(task)}/git/pull`, { method: 'POST', body: { force }, toast: false }),
    publishRevision: (task: string, message?: string) =>
      api<Revision>(`${path(task)}/revisions`, { method: 'POST', body: message?.trim() ? { message: message.trim() } : {}, toast: false }),
    listFiles: (task: string, options: { path?: string; recursive?: boolean; revision?: string | null }) =>
      api<TaskFileList>(`${path(task)}/files`, {
        query: apiQuery({ path: options.path ?? '', recursive: options.recursive ?? true, revision: options.revision ?? null }),
        toast: false,
      }),
    readFile: (task: string, filePath: string, revision?: string | null) =>
      api<TaskFileContent>(`${path(task)}/files/content`, { query: apiQuery({ path: filePath, revision: revision ?? null }), toast: false }),
    workspaceArchiveUrl: (task: string) => `${path(task)}/workspace/archive`,
  }
}
