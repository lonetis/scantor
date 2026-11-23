import type { SetupStatus } from '#shared/types/instance'
import type { RequestOrigin } from '#shared/utils/enums'
import { resolveMcpConfig, resolvePasskeyConfig } from '../../utils/auth-policy'
import { useConfig } from '../../utils/config'
import { anyUserExists } from '../../utils/setup'

// Setup status (docs/api.md §4.2): public, read by the SPA to redirect to /setup while no user exists. Passkeys and
// the MCP URL are those of the request's origin (public URL or tunnel URL).

export async function setupStatus(origin: RequestOrigin = 'public'): Promise<SetupStatus> {
  const config = useConfig()
  const mcp = resolveMcpConfig(config, origin)
  return {
    needsSetup: !(await anyUserExists()),
    passkeysEnabled: resolvePasskeyConfig(config, origin).enabled,
    mcpUrl: mcp.enabled ? mcp.resource : null,
  }
}
