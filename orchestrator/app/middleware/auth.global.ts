// Setup / session / admin guard driven by page meta (docs/ui.md §4.1). The server enforces every rule again.

declare module '#app' {
  interface PageMeta {
    /** `false` marks a public page (login, setup, OAuth consent). */
    auth?: boolean
    /** Admins only; others are sent to the overview. */
    admin?: boolean
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

  if (to.meta.admin === true && !isAdmin.value) {
    useToast().add({ title: 'Admins only', color: 'warning', icon: 'i-lucide-shield' })
    return navigateTo('/')
  }
})
