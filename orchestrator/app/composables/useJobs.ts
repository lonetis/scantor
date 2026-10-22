import type { MaybeRefOrGetter } from 'vue'
import type { Page } from '#shared/types/common'
import type { JobKind, JobState } from '#shared/utils/enums'

// Background jobs (docs/api.md §4.16): listJobs as a "Load more" list with kind, state and (admins) owner filters.
// A single job is followed with useJob.

export interface JobListFilters {
  kind?: JobKind | null
  state?: JobState | null
  /** Admins only: jobs of this user. */
  userId?: string | null
}

const JOBS_PAGE_SIZE = 50

export function useJobs(filters: MaybeRefOrGetter<JobListFilters> = {}) {
  const api = useApi()
  const list = useCursorList<Job>(
    (cursor) => {
      const current = toValue(filters)
      return api<Page<Job>>('/api/jobs', {
        query: apiQuery({ kind: current.kind ?? null, state: current.state ?? null, userId: current.userId ?? null, cursor, limit: JOBS_PAGE_SIZE }),
        background: cursor !== null,
      })
    },
    { immediate: false },
  )

  // A filter change starts over from the first page.
  watch(() => JSON.stringify(toValue(filters)), () => {
    list.reset().catch((error: unknown) => console.error('[jobs] loading jobs failed', error))
  })

  return list
}
