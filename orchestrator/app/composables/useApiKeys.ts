import type { CreateApiKeyBody } from '#shared/schemas/account'

// The caller's API keys (docs/api.md §4.3, docs/auth.md §8). Keys are created only with a browser session;
// the plain key is returned exactly once.

export function useApiKeys() {
  const api = useApi()
  const keys = shallowRef<ApiKey[]>([])
  const loading = ref(false)
  const error = shallowRef<ApiError | null>(null)

  async function load(): Promise<void> {
    loading.value = true
    try {
      const [defaults, editor] = await Promise.all([
        api<ItemList<ApiKey>>('/api/account/api-keys', { query: { configId: 'default' }, toast: false }),
        api<ItemList<ApiKey>>('/api/account/api-keys', { query: { configId: 'editor' }, toast: false }),
      ])
      keys.value = [...defaults.items, ...editor.items]
      error.value = null
    } catch (cause) {
      error.value = toApiError(cause)
    } finally {
      loading.value = false
    }
  }

  const defaultKeys = computed(() => keys.value.filter((key) => key.configId === 'default'))
  const editorKeys = computed(() => keys.value.filter((key) => key.configId === 'editor'))

  async function createKey(body: CreateApiKeyBody): Promise<CreatedApiKey> {
    const created = await api<CreatedApiKey>('/api/account/api-keys', { method: 'POST', body, toast: false })
    keys.value = [created.apiKey, ...keys.value]
    return created
  }

  async function deleteKey(keyId: string): Promise<void> {
    await api(`/api/account/api-keys/${keyId}`, { method: 'DELETE' })
    keys.value = keys.value.filter((key) => key.id !== keyId)
  }

  return { keys, defaultKeys, editorKeys, loading, error, load, createKey, deleteKey }
}
