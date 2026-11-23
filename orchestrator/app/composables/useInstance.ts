import { computed, shallowRef } from 'vue'

// Instance-wide facts (docs/ui.md §1): the SPA reads no runtime configuration; URLs, feature flags, limits and
// the version come from getInstanceInfo (signed in) and getSetupStatus (public). Both are loaded once per page; a failed
// load is tried again by the next caller (every navigation asks, middleware/auth.global.ts). Whether the page came
// through the tunnel URL is the server's `origin`, never a comparison of window.location.

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
    downloads: info.value?.features.downloads ?? true,
  }))
  /**
   * Whether a download may start now: loads the info first (again, after a failure), so a click before it arrived
   * never leads a tunnel page to an unreachable presigned URL. Without the info downloads stay allowed, as they work on
   * the public URL. Capture it during setup and call it from the handler.
   */
  async function downloadsAvailable(): Promise<boolean> {
    const loaded = await loadInfo().catch(() => null)
    return loaded ? loaded.features.downloads : features.value.downloads
  }
  const limits = computed(() => info.value?.limits ?? null)
  const version = computed(() => info.value?.version ?? null)
  const isReleaseVersion = computed(() => version.value !== null && RELEASE_VERSION.test(version.value))
  /** True when this page was loaded through the tunnel URL. */
  const isTunnel = computed(() => info.value?.origin === 'tunnel')
  const publicUrl = computed(() => info.value?.publicUrl ?? null)
  const tunnelUrl = computed(() => info.value?.tunnelUrl ?? null)
  /** The URL this page was loaded from: the tunnel URL through the tunnel, otherwise the public URL. */
  const originUrl = computed(() => (isTunnel.value ? tunnelUrl.value : publicUrl.value))

  return {
    info,
    setupStatus,
    features,
    limits,
    version,
    isReleaseVersion,
    isTunnel,
    publicUrl,
    tunnelUrl,
    originUrl,
    loadInfo,
    loadSetupStatus,
    downloadsAvailable,
  }
}
