// The signed-in user's account (getAccount): role, limits and credential summary. Shared by the account
// page, the new-scan form (canRunPrivileged) and admin self-protection. Loaded once and refreshed on demand.

const account = shallowRef<Account | null>(null)
let request: Promise<Account> | null = null

export function useCurrentUser() {
  const api = useApi()

  function load(force = false): Promise<Account> {
    if (force) request = null
    request ??= api<Account>('/api/account', { toast: false }).then(
      (result) => {
        account.value = result
        return result
      },
      (error: unknown) => {
        request = null
        throw error
      },
    )
    return request
  }

  /** Replaces the cached account with a fresh representation (after updateAccount and friends). */
  function set(next: Account): void {
    account.value = next
    request = Promise.resolve(next)
  }

  return { account: readonly(account), load, set }
}
