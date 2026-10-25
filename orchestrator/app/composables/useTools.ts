import type { ToolTarget } from '#shared/utils/enums'
import { ApiError, errorTitle } from '../utils/errors'

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True for a health report; getHealth answers one with 200, and with 503 while MongoDB is down. */
export function isHealthReport(value: unknown): value is Health {
  return isRecord(value) && typeof value.status === 'string' && isRecord(value.components) && Array.isArray(value.alarms)
}

/**
 * The error of a getHealth answer that is no report: the API's error envelope (a failing health check), or anything
 * else, such as the proxy's "Bad Gateway" page while the orchestrator restarts.
 */
export function healthAnswerError(value: unknown): ApiError {
  const envelope = isRecord(value) && isRecord(value.error) ? value.error : null
  if (envelope && typeof envelope.code === 'string') {
    return new ApiError({ status: 500, code: envelope.code, message: typeof envelope.message === 'string' ? envelope.message : errorTitle(envelope.code) })
  }
  return new ApiError({ status: 502, code: 'unavailable', message: 'The orchestrator answered without a health report.' })
}

export function useTools() {
  const api = useApi()
  const { info, loadInfo } = useInstance()

  const adminTools = computed(() => info.value?.adminTools ?? null)
  const health = shallowRef<Health | null>(null)
  const healthError = shallowRef<ApiError | null>(null)
  const filters = reactive<JobFilters>({ kind: null, state: null })

  async function loadHealth(options: { background?: boolean } = {}): Promise<void> {
    try {
      // getHealth answers 503 with a full report while MongoDB is down; any other answer is an error.
      const answer = await api<unknown>('/api/health', { background: options.background ?? false, toast: false, ignoreResponseError: true })
      if (!isHealthReport(answer)) throw healthAnswerError(answer)
      health.value = answer
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
