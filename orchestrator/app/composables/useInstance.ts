// Instance-wide facts (docs/ui.md §1): the SPA reads no runtime configuration; URLs, feature flags, limits and
// the version come from getInstanceInfo (signed in) and getSetupStatus (public). Both are loaded once per page.

const info = shallowRef<InstanceInfo | null>(null)
const setupStatus = shallowRef<SetupStatus | null>(null)
let infoRequest: Promise<InstanceInfo> | null = null
let setupRequest: Promise<SetupStatus> | null = null

const RELEASE_VERSION = /^\d+\.\d+\.\d+$/

export function useInstance() {
  const api = useApi()

  /** getInstanceInfo, once per page load (requires a session). */
  function loadInfo(): Promise<InstanceInfo> {
    infoRequest ??= api<InstanceInfo>('/api/info', { background: true }).then(
      (result) => {
        info.value = result
        return result
      },
      (error: unknown) => {
        infoRequest = null
        throw error
      },
    )
    return infoRequest
  }

  /** getSetupStatus; `force` re-reads it (the setup page after a 409). */
  function loadSetupStatus(force = false): Promise<SetupStatus> {
    if (force) setupRequest = null
    setupRequest ??= api<SetupStatus>('/api/setup/status', { background: true }).then(
      (result) => {
        setupStatus.value = result
        return result
      },
      (error: unknown) => {
        setupRequest = null
        throw error
      },
    )
    return setupRequest
  }

  const features = computed(() => ({
    passkeys: info.value?.features.passkeys ?? setupStatus.value?.passkeysEnabled ?? false,
    mcp: info.value?.features.mcp ?? setupStatus.value?.mcpUrl != null,
    mcpOAuth: info.value?.features.mcpOAuth ?? false,
    editor: info.value?.features.editor ?? false,
  }))
  const limits = computed(() => info.value?.limits ?? null)
  const version = computed(() => info.value?.version ?? null)
  const isReleaseVersion = computed(() => version.value !== null && RELEASE_VERSION.test(version.value))

  return { info, setupStatus, features, limits, version, isReleaseVersion, loadInfo, loadSetupStatus }
}
