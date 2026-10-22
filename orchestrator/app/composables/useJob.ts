import type { MaybeRefOrGetter } from 'vue'

const JOB_POLL_MS = 2000

/** Follows a background job (getJob) every 2 s while it is queued or running (docs/ui.md §9). */
export function useJob(jobId: MaybeRefOrGetter<string | null | undefined>) {
  const api = useApi()
  const job = shallowRef<Job | null>(null)
  const settled = computed(() => job.value !== null && (TERMINAL_JOB_STATES as readonly string[]).includes(job.value.state))

  async function fetchJob(): Promise<void> {
    const id = toValue(jobId)
    if (!id) return
    job.value = await api<Job>(`/api/jobs/${encodeURIComponent(id)}`, { background: true })
  }

  watch(() => toValue(jobId), () => {
    job.value = null
  })

  const poll = usePoll(fetchJob, {
    intervalMs: JOB_POLL_MS,
    enabled: () => Boolean(toValue(jobId)) && !settled.value,
  })

  const percent = computed(() => {
    const progress = job.value?.progress
    if (!progress || !progress.total) return null
    return Math.min(100, (progress.done / progress.total) * 100)
  })

  return { job, settled, percent, refresh: poll.refresh }
}
