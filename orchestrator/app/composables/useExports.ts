import type { MaybeRefOrGetter } from 'vue'
import type { Page } from '#shared/types/common'
import type { Export } from '#shared/types/exports'
import type { Scan } from '#shared/types/scans'
import type { AnalysisStatus, ExportFormat } from '#shared/utils/enums'

// Background exports of a scan (docs/ui.md §5.13.6; docs/api.md §4.15). The UI always uses exportScan (never the
// inline export). A created export is followed with getExport every 2 s until it is ready or failed, then a toast
// offers the download. Following is module-wide, so an export started from the scan controls is still followed
// when the exports tab is not open.

export const EXPORT_POLL_MS = 2000
const EXPORTS_PAGE_SIZE = 50

export interface ExportRequest {
  format: ExportFormat
  filter?: Record<string, unknown>
  fields?: string[]
  afterSeq?: number
}

/** Prefill of the export modal. */
export interface ExportModalOptions {
  filter?: Record<string, unknown>
  status?: AnalysisStatus[]
}

export function exportSettled(state: Export['state']): boolean {
  return state === 'ready' || state === 'failed'
}

/** Exports followed by this browser tab, newest state per id (shared by every ExportsPanel). */
const followed = shallowRef<ReadonlyMap<string, Export>>(new Map())
const following = new Set<string>()

function remember(item: Export): void {
  const next = new Map(followed.value)
  next.set(item.id, item)
  followed.value = next
}

function forget(id: string): void {
  if (!followed.value.has(id)) return
  const next = new Map(followed.value)
  next.delete(id)
  followed.value = next
}

export function useExports(scanId: MaybeRefOrGetter<string | null | undefined> = null) {
  const api = useApi()
  const toast = useToast()
  const overlay = useOverlay()

  const list = useCursorList<Export>(
    (cursor) => api<Page<Export>>('/api/exports', {
      query: apiQuery({ scanId: toValue(scanId) ?? null, cursor, limit: EXPORTS_PAGE_SIZE }),
      background: cursor !== null,
    }),
    { immediate: false },
  )

  /** The listed exports with the latest state of followed ones. */
  const items = computed(() => list.items.value.map((item) => followed.value.get(item.id) ?? item))

  function announce(item: Export): void {
    if (item.state === 'ready') {
      toast.add({
        title: 'Export ready',
        description: `${formatCount(item.rows)} rows, ${formatBytes(item.bytes)}`,
        color: 'success',
        icon: 'i-lucide-download',
        actions: [{ label: 'Download', icon: 'i-lucide-download', color: 'neutral', variant: 'outline', onClick: () => void download(item) }],
      })
    } else {
      toast.add({ title: 'Export failed', description: item.error?.message ?? 'The export could not be written.', color: 'error', icon: 'i-lucide-circle-alert' })
    }
  }

  /** Follows an export until it settles (once per export and tab). */
  function follow(item: Export): void {
    remember(item)
    if (exportSettled(item.state) || following.has(item.id)) return
    following.add(item.id)
    const tick = async (): Promise<void> => {
      try {
        const current = await api<Export>(`/api/exports/${encodeURIComponent(item.id)}`, { background: true })
        remember(current)
        if (exportSettled(current.state)) {
          following.delete(item.id)
          announce(current)
          return
        }
      } catch (cause) {
        const error = toApiError(cause)
        if (error.status === 404) {
          following.delete(item.id)
          forget(item.id)
          return
        }
        console.warn('[exports] polling an export failed; retrying', error)
      }
      setTimeout(() => void tick(), EXPORT_POLL_MS)
    }
    setTimeout(() => void tick(), EXPORT_POLL_MS)
  }

  async function create(targetScanId: string, request: ExportRequest): Promise<Export> {
    const created = await api<Export>(`/api/scans/${encodeURIComponent(targetScanId)}/exports`, { method: 'POST', body: request, toast: false })
    follow(created)
    return created
  }

  /** Opens the export modal; resolves with the created export (already followed), or null when cancelled. */
  async function openExportModal(scan: Pick<Scan, 'id' | 'name'>, options: ExportModalOptions = {}): Promise<Export | null> {
    // Loaded lazily: the modal itself uses this composable.
    const modal = overlay.create(defineAsyncComponent(() => import('~/components/ExportModal.vue')), { destroyOnClose: true })
    const result = (await modal.open({ scan, filter: options.filter, status: options.status })) as Export | null | undefined
    if (result && list.loaded.value) await list.reset().catch((error: unknown) => console.error('[exports] reloading the list failed', error))
    return result ?? null
  }

  /** Downloads a ready export; the link is presigned anew on every getExport. */
  async function download(item: Export): Promise<void> {
    const fresh = item.download && Date.parse(item.download.expiresAt) - Date.now() > 30_000
      ? item
      : await api<Export>(`/api/exports/${encodeURIComponent(item.id)}`)
    if (fresh.download) navigateToDownload(fresh.download.url)
  }

  async function remove(item: Export): Promise<void> {
    await api(`/api/exports/${encodeURIComponent(item.id)}`, { method: 'DELETE' })
    forget(item.id)
    following.delete(item.id)
    list.items.value = list.items.value.filter((entry) => entry.id !== item.id)
  }

  /** Re-reads the listed exports and follows the unsettled ones. */
  async function refresh(): Promise<void> {
    await list.refresh()
    for (const item of list.items.value) if (!exportSettled(item.state)) follow(item)
  }

  async function reset(): Promise<void> {
    await list.reset()
    for (const item of list.items.value) if (!exportSettled(item.state)) follow(item)
  }

  return {
    items,
    hasMore: list.hasMore,
    loading: list.loading,
    refreshing: list.refreshing,
    loaded: list.loaded,
    loadMore: list.loadMore,
    reset,
    refresh,
    create,
    remove,
    download,
    openExportModal,
  }
}
