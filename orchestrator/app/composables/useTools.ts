import type { ToolTarget } from '#shared/utils/enums'

// The admin tools page (docs/ui.md §5.20): tool links from getInstanceInfo.adminTools, platform health and the
// background jobs of all users (listJobs, filters kind and state).

export const TOOL_DESCRIPTIONS: Record<ToolTarget, string> = {
  rabbitmq: 'Queues, connections, alarms and per-scan users of the message broker.',
  'mongo-express': 'Read-only browser of the MongoDB collections.',
  rustfs: 'Buckets and objects of the S3 store (snapshots, files, exports).',
  traefik: 'Routers, services, middlewares and certificates of the reverse proxy.',
}

/** The navigation target that sets the tools cookie and redirects to the tool (createToolsSession). */
export function toolSessionPath(target: ToolTarget): string {
  return `/api/tools/session?target=${encodeURIComponent(target)}`
}

export interface JobFilters {
  kind: JobKind | null
  state: JobState | null
}

export const JOB_PAGE_SIZE = 50

export function useTools() {
  const api = useApi()
  const { info, loadInfo } = useInstance()

  const adminTools = computed(() => info.value?.adminTools ?? null)
  const health = shallowRef<Health | null>(null)
  const healthError = shallowRef<ApiError | null>(null)
  const filters = reactive<JobFilters>({ kind: null, state: null })

  async function loadHealth(options: { background?: boolean } = {}): Promise<void> {
    try {
      // getHealth answers 503 with a full report while MongoDB is down.
      health.value = await api<Health>('/api/health', { background: options.background ?? false, toast: false, ignoreResponseError: true })
      healthError.value = null
    } catch (error) {
      healthError.value = toApiError(error)
      throw error
    }
  }

  const jobs = useCursorList<Job>(
    (cursor) =>
      api<CursorPage<Job>>('/api/jobs', {
        query: apiQuery({ kind: filters.kind, state: filters.state, cursor, limit: JOB_PAGE_SIZE }),
        background: true,
      }),
    { immediate: false },
  )

  return { info, adminTools, loadInfo, health, healthError, loadHealth, filters, jobs }
}
