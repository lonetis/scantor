import type { MaybeRefOrGetter } from 'vue'
import type { Bundle } from '#shared/types/bundles'

// The bundle of one revision (docs/ui.md §5.9, §9; docs/api.md createRevisionBundle, getRevisionBundle): getRevisionBundle
// once (404 means no bundle, also once it expired), then every 2 s while the bundle is queued or running. Like every poll
// it pauses while the tab is hidden and doubles its interval after each failure up to 60 s. A failed first read is
// retried the same way. create() posts createRevisionBundle (rebuild for "Try again") and polls the new bundle;
// download() follows the presigned link, read again when it expires within 30 s.

export const BUNDLE_POLL_MS = 2000

export function useBundle(taskId: MaybeRefOrGetter<string>, revision: MaybeRefOrGetter<string>) {
  const api = useApi()
  const bundle = shallowRef<Bundle | null>(null)
  /** True once a read answered (with a bundle or 404). */
  const loaded = ref(false)
  const error = shallowRef<ApiError | null>(null)
  const creating = ref(false)

  const path = (): string => `/api/tasks/${encodeURIComponent(toValue(taskId))}/revisions/${encodeURIComponent(toValue(revision))}/bundle`

  async function read(background: boolean): Promise<Bundle | null> {
    try {
      return await api<Bundle>(path(), { background })
    } catch (cause) {
      const apiError = toApiError(cause)
      if (apiError.status === 404) return null
      throw apiError
    }
  }

  async function load(): Promise<void> {
    try {
      bundle.value = await read(true)
      loaded.value = true
      error.value = null
    } catch (cause) {
      error.value = toApiError(cause)
      throw error.value
    }
  }

  const poll = usePoll(load, {
    intervalMs: BUNDLE_POLL_MS,
    enabled: () => !loaded.value || isBundleActive(bundle.value?.state),
  })

  watch([() => toValue(taskId), () => toValue(revision)], () => {
    bundle.value = null
    loaded.value = false
    error.value = null
  })

  /** Creates the revision's bundle (or returns the active or ready one); rebuild replaces a ready or failed one. */
  async function create(rebuild = false): Promise<Bundle> {
    creating.value = true
    try {
      const created = await api<Bundle>(path(), { method: 'POST', query: rebuild ? { rebuild: 'true' } : {}, toast: false })
      bundle.value = created
      loaded.value = true
      error.value = null
      return created
    } finally {
      creating.value = false
    }
  }

  /** Downloads a ready bundle through its presigned link. */
  async function download(): Promise<void> {
    const current = bundle.value
    const fresh = current && bundleDownloadFresh(current) ? current : await read(false)
    bundle.value = fresh
    if (fresh?.download) navigateToDownload(fresh.download.url)
  }

  return {
    bundle,
    loaded,
    error,
    creating: readonly(creating),
    refreshing: poll.running,
    refresh: poll.refresh,
    create,
    download,
  }
}
