import type { SetupStatus } from '#shared/types/instance'
import { resolveMcpConfig, resolvePasskeyConfig } from '../../utils/auth-policy'
import { useConfig } from '../../utils/config'
import { anyUserExists } from '../../utils/setup'

// Setup status (docs/api.md §4.2): public, read by the SPA to redirect to /setup while no user exists.

export async function setupStatus(): Promise<SetupStatus> {
  const config = useConfig()
  const mcp = resolveMcpConfig(config)
  return {
    needsSetup: !(await anyUserExists()),
    passkeysEnabled: resolvePasskeyConfig(config).enabled,
    mcpUrl: mcp.enabled ? mcp.resource : null,
  }
}
