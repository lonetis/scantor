import { ofetch } from 'ofetch'
import type { FetchOptions } from 'ofetch'

// The central fetch wrapper for /api (docs/ui.md §8). Every composable calls $api; raw $fetch/fetch is used
// only for EventSource and anchor downloads.

export interface ApiRequestOptions extends Omit<FetchOptions, 'onRequest' | 'onRequestError' | 'onResponse' | 'onResponseError' | 'credentials'> {
  /** Show an error toast (default true). Forms and inline-error views pass false. */
  toast?: boolean
  /** A background poll: never toasts, not even for network failures. */
  background?: boolean
}

export type ApiClient = <T>(url: string, options?: ApiRequestOptions) => Promise<T>

const NETWORK_TOAST_INTERVAL_MS = 10_000
const PUBLIC_PATHS = ['/login', '/setup']

export default defineNuxtPlugin(() => {
  const toast = useToast()
  const router = useRouter()
  const raw = ofetch.create({ credentials: 'same-origin', retry: 0 })
  let lastNetworkToastAt = 0
  let leaving = false

  function copyRequestId(requestId: string): void {
    navigator.clipboard.writeText(requestId).then(
      () => toast.add({ title: 'Copied', icon: 'i-lucide-check', color: 'success', duration: 2000 }),
      (error: unknown) => console.error('[api] copying the request id failed', error),
    )
  }

  function handleError(error: ApiError, options: { toast: boolean, background: boolean }): void {
    const currentPath = router.currentRoute.value.path
    if (error.status === 401 && !PUBLIC_PATHS.includes(currentPath)) {
      if (leaving) return
      leaving = true
      hardNavigate(`/login?redirect=${encodeURIComponent(router.currentRoute.value.fullPath)}`)
      return
    }
    if (error.status === 403 && error.code === 'banned') {
      if (leaving) return
      leaving = true
      const { client } = useAuth()
      client.signOut()
        .then((result) => {
          if (result.error) console.error('[api] sign-out of a banned user failed', result.error)
        })
        .finally(() => hardNavigate('/login?banned=1'))
      return
    }
    if (options.background || !options.toast) return
    if (error.isNetworkError) {
      const now = Date.now()
      if (now - lastNetworkToastAt < NETWORK_TOAST_INTERVAL_MS) return
      lastNetworkToastAt = now
      toast.add({ id: 'network-error', title: errorTitle(error.code), description: 'Check your connection; requests are retried when you act again.', color: 'error', icon: 'i-lucide-circle-alert' })
      return
    }
    const requestId = error.requestId
    toast.add({
      title: errorTitle(error.code),
      description: error.message,
      color: 'error',
      icon: 'i-lucide-circle-alert',
      actions: error.status >= 500 && requestId
        ? [{ label: 'Copy request id', icon: 'i-lucide-copy', color: 'neutral', variant: 'outline', onClick: () => copyRequestId(requestId) }]
        : undefined,
    })
  }

  const api: ApiClient = async <T>(url: string, options: ApiRequestOptions = {}): Promise<T> => {
    const { toast: showToast = true, background = false, ...fetchOptions } = options
    try {
      return await raw<T, 'json'>(url, fetchOptions as FetchOptions<'json'>)
    } catch (cause) {
      const error = toApiError(cause)
      handleError(error, { toast: showToast, background })
      throw error
    }
  }

  return { provide: { api } }
})
