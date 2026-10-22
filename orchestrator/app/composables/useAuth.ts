import { createAuthClient } from 'better-auth/vue'
import { adminClient } from 'better-auth/client/plugins'
import { passkeyClient } from '@better-auth/passkey/client'
import { oauthProviderClient } from '@better-auth/oauth-provider/client'

// One better-auth client per page load. Sign-in and sign-out hard-reload the page, which also resets every
// other module-level singleton (docs/ui.md §3.2).
const client = createAuthClient({
  baseURL: import.meta.client ? window.location.origin : undefined,
  basePath: '/api/auth',
  // oauthProviderClient forwards the signed OAuth query on /login and /oauth/consent so better-auth can
  // resume an MCP authorization after sign-in.
  plugins: [adminClient(), passkeyClient(), oauthProviderClient()],
})

export type AuthClient = typeof client

export interface SessionUser {
  id: string
  email: string
  name: string
  role?: string | null
  image?: string | null
}

function createSessionState() {
  return client.useSession()
}

type SessionState = ReturnType<typeof createSessionState>

let session: SessionState | null = null

function useSessionAtom(): SessionState {
  session ??= createSessionState()
  return session
}

/** True on a page reached through an OAuth authorization redirect (the signed query carries `sig`). */
export function isOAuthAuthorizationPage(): boolean {
  return import.meta.client && new URLSearchParams(window.location.search).has('sig')
}

/** Follows the `{redirect: true, url}` body better-auth returns when an auth call continues an OAuth flow. */
export function followOAuthRedirect(data: unknown): boolean {
  const body = data as { redirect?: unknown, url?: unknown } | null | undefined
  if (!body || body.redirect !== true || typeof body.url !== 'string' || !body.url) return false
  window.location.href = body.url
  return true
}

/** Full page load of a same-origin path (resets all client state). */
export function hardNavigate(path: string): void {
  window.location.href = path
}

export function useAuth() {
  const state = useSessionAtom()
  const user = computed<SessionUser | null>(() => (state.value?.data?.user as SessionUser | undefined) ?? null)
  const isLoggedIn = computed(() => user.value !== null)
  const isAdmin = computed(() => user.value?.role === 'admin')
  const isPending = computed(() => state.value?.isPending ?? true)

  /** Resolves once better-auth finished loading the session. */
  async function waitForSession(): Promise<SessionUser | null> {
    if (!isPending.value) return user.value
    await new Promise<void>((resolve) => {
      const stop = watch(isPending, (pending) => {
        if (pending) return
        stop()
        resolve()
      })
    })
    return user.value
  }

  async function signOut(): Promise<void> {
    const result = await client.signOut()
    if (result.error) console.error('[auth] sign-out failed', result.error)
    hardNavigate('/login')
  }

  return { client, session: state, user, isLoggedIn, isAdmin, isPending, waitForSession, signOut }
}
