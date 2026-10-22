import type { MaybeRefOrGetter } from 'vue'

export interface ApiFetchOptions<T> {
  query?: MaybeRefOrGetter<Record<string, string | number | boolean | readonly string[] | null | undefined> | undefined>
  /** Toast errors (default true). Inline-error views pass false. */
  toast?: boolean
  /** Fetch right away and whenever `path` or `query` change (default true). */
  immediate?: boolean
  default?: () => T
}

/**
 * Reactive GET through `$api` (docs/ui.md §7). A null path means "nothing to load yet". Responses of a
 * superseded request (path or query changed meanwhile) are dropped.
 */
export function useApiFetch<T>(path: MaybeRefOrGetter<string | null | undefined>, options: ApiFetchOptions<T> = {}) {
  const api = useApi()
  const data = shallowRef<T | undefined>(options.default?.()) as Ref<T | undefined>
  const error = shallowRef<ApiError | null>(null)
  const pending = ref(false)
  let generation = 0

  async function execute(fetchOptions: { background?: boolean } = {}): Promise<T | undefined> {
    const url = toValue(path)
    const current = ++generation
    if (!url) {
      pending.value = false
      return data.value
    }
    pending.value = true
    try {
      const query = toValue(options.query)
      const result = await api<T>(url, {
        query: query ? apiQuery(query) : undefined,
        toast: options.toast ?? true,
        background: fetchOptions.background ?? false,
      })
      if (current === generation) {
        data.value = result
        error.value = null
      }
      return result
    } catch (cause) {
      const apiError = toApiError(cause)
      if (current === generation) error.value = apiError
      throw apiError
    } finally {
      if (current === generation) pending.value = false
    }
  }

  /** Re-fetches; errors are kept in `error` (and toasted per options) instead of being thrown. */
  async function refresh(fetchOptions: { background?: boolean } = {}): Promise<void> {
    try {
      await execute(fetchOptions)
    } catch (cause) {
      if (!(cause instanceof ApiError)) throw cause
    }
  }

  if (options.immediate !== false) {
    watch([() => toValue(path), () => JSON.stringify(toValue(options.query) ?? null)], () => {
      void refresh()
    }, { immediate: true })
  }

  return { data, error, pending, execute, refresh }
}
