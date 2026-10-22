import type { CreateCredentialBody, UpdateCredentialBody } from '#shared/schemas/tasks'
import type { GitCredential } from '#shared/types/credentials'

// Git credentials (docs/api.md §4.5, docs/ui.md §5.19). Mutations throw ApiError so the form modal shows errors
// inline; tokens never come back from the API.

export function useCredentials() {
  const api = useApi()
  const credentials = shallowRef<GitCredential[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = shallowRef<ApiError | null>(null)

  async function load(): Promise<void> {
    loading.value = true
    try {
      credentials.value = (await api<ItemList<GitCredential>>('/api/credentials', { toast: false })).items
      error.value = null
      loaded.value = true
    } catch (cause) {
      error.value = toApiError(cause)
    } finally {
      loading.value = false
    }
  }

  function replace(credential: GitCredential): void {
    const others = credentials.value.filter((item) => item.id !== credential.id)
    credentials.value = [...others, credential].sort((a, b) => a.name.localeCompare(b.name))
  }

  async function createCredential(body: CreateCredentialBody): Promise<GitCredential> {
    const created = await api<GitCredential>('/api/credentials', { method: 'POST', body, toast: false })
    replace(created)
    return created
  }

  async function updateCredential(credentialId: string, body: UpdateCredentialBody): Promise<GitCredential> {
    const updated = await api<GitCredential>(`/api/credentials/${credentialId}`, { method: 'PATCH', body, toast: false })
    replace(updated)
    return updated
  }

  async function deleteCredential(credentialId: string): Promise<void> {
    await api(`/api/credentials/${credentialId}`, { method: 'DELETE' })
    credentials.value = credentials.value.filter((item) => item.id !== credentialId)
  }

  void load()

  return { credentials, loading, loaded, error, load, createCredential, updateCredential, deleteCredential }
}
