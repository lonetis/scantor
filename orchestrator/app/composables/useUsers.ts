import type { MaybeRefOrGetter } from 'vue'
import type { BanUserBody, CreateUserBody, UpdateUserBody } from '#shared/schemas/users'

// Admin user management (docs/api.md §4.4, docs/ui.md §5.16). Mutations throw ApiError so modals can show
// errors inline; they never toast on their own.

export function useUsers(search: MaybeRefOrGetter<string>) {
  const api = useApi()
  const list = useCursorList<User>(
    (cursor) => api<Page<User>>('/api/users', { query: apiQuery({ q: toValue(search).trim(), cursor, limit: 50 }) }),
    { immediate: false },
  )

  watch(() => toValue(search).trim(), () => {
    list.reset().catch((error: unknown) => console.error('[users] loading users failed', error))
  }, { immediate: true })

  function replace(user: User): void {
    list.items.value = list.items.value.map((item) => (item.id === user.id ? user : item))
  }

  async function createUser(body: CreateUserBody): Promise<User> {
    const user = await api<User>('/api/users', { method: 'POST', body, toast: false })
    list.items.value = [user, ...list.items.value]
    return user
  }

  async function updateUser(userId: string, body: UpdateUserBody): Promise<User> {
    const user = await api<User>(`/api/users/${userId}`, { method: 'PATCH', body, toast: false })
    replace(user)
    return user
  }

  async function setPassword(userId: string, password: string): Promise<void> {
    await api(`/api/users/${userId}/password`, { method: 'PUT', body: { password }, toast: false })
  }

  async function banUser(userId: string, body: BanUserBody): Promise<User> {
    const user = await api<User>(`/api/users/${userId}/ban`, { method: 'POST', body, toast: false })
    replace(user)
    return user
  }

  async function unbanUser(userId: string): Promise<User> {
    const user = await api<User>(`/api/users/${userId}/unban`, { method: 'POST', body: {} })
    replace(user)
    return user
  }

  /** Starts the userPurge job; the row then shows its progress. */
  async function deleteUser(userId: string): Promise<JobRef> {
    const result = await api<JobAccepted>(`/api/users/${userId}`, { method: 'DELETE' })
    return result.job
  }

  function remove(userId: string): void {
    list.items.value = list.items.value.filter((item) => item.id !== userId)
  }

  /** Reads one user again into its row; a user that no longer exists leaves the list. */
  async function reload(userId: string): Promise<void> {
    try {
      replace(await api<User>(`/api/users/${encodeURIComponent(userId)}`, { background: true }))
    } catch (cause) {
      if (toApiError(cause).status === 404) remove(userId)
      else throw cause
    }
  }

  return { ...list, createUser, updateUser, setPassword, banUser, unbanUser, deleteUser, remove, reload }
}
