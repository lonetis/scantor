// Setup / session / admin / tunnel guard driven by page meta (docs/ui.md §4.1). The server enforces every rule again.

declare module '#app' {
  interface PageMeta {
    /** `false` marks a public page (login, setup, OAuth consent). */
    auth?: boolean
    /** Admins only; others are sent to the overview. */
    admin?: boolean
    /** `false` marks a page of the public URL only (the editor); the tunnel URL sends to the overview. */
    tunnel?: boolean
  }
}

// "Setup done" never flips back, so it is cached for the page's lifetime.
let setupDone = false

export default defineNuxtRouteMiddleware(async (to) => {
  if (to.meta.auth === false) return

  if (!setupDone) {
    try {
      const status = await useInstance().loadSetupStatus()
      if (status.needsSetup) return navigateTo('/setup')
      setupDone = true
    } catch (error) {
      // Without the status the session check below still decides; the API answers 401 when needed.
      console.error('[auth] loading the setup status failed', error)
    }
  }

  const { waitForSession, isAdmin } = useAuth()
  const user = await waitForSession()
  if (!user) return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  // The instance info is loaded once per page; after a failure every navigation tries again (useInstance).
  const instance = useInstance()
  if (!instance.info.value) instance.loadInfo().catch((error: unknown) => console.error('[auth] loading the instance info failed', error))

  if (to.meta.admin === true && !isAdmin.value) {
    useToast().add({ title: 'Admins only', color: 'warning', icon: 'i-lucide-shield' })
    return navigateTo('/')
  }

  if (to.meta.tunnel === false) {
    const info = await instance.loadInfo().catch((error: unknown) => {
      // Without the info the page opens; the server refuses what it cannot serve through the tunnel URL.
      console.error('[auth] loading the instance info failed', error)
      return null
    })
    if (info?.origin === 'tunnel') {
      useToast().add({ title: TUNNEL_PAGE_UNAVAILABLE, description: publicPageText(info.publicUrl, to.fullPath), color: 'warning', icon: 'i-lucide-cloud' })
      return navigateTo('/')
    }
  }
})
