import type { MaybeRefOrGetter } from 'vue'
import type { CreateTaskBody, ImportGitBody } from '#shared/schemas/tasks'

// Tasks (docs/api.md §4.6–§4.8, docs/ui.md §5.5–§5.7, §9): the list (30 s poll), one task (10 s poll, 2 s while
// its latest revision builds), its files, and the task mutations. Mutations that forms show inline pass
// `toast: false` and throw ApiError.

export const TASKS_POLL_MS = 30_000
export const TASK_POLL_MS = 10_000
export const TASK_BUILDING_POLL_MS = 2000

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
