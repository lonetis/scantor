import { defineEventHandler, toWebRequest } from 'h3'
import { isProtectedResourceMetadataPath, toBetterAuthDiscoveryRequest, withResourceName } from '../../services/mcp/discovery'
import { useAuth } from '../../utils/auth'
import { resolveMcpConfig } from '../../utils/auth-policy'
import { isBootComplete } from '../../utils/boot'
import { useConfig } from '../../utils/config'
import { applyOpenCors, handleOpenCorsPreflight } from '../../utils/cors'
import { apiError } from '../../utils/errors'

// OAuth and MCP discovery at the origin root (docs/api.md §3, docs/mcp.md §3.1), forwarded to better-auth:
// `/.well-known/oauth-protected-resource/mcp` (with `resource_name` added), `/.well-known/oauth-authorization-server/
// api/auth` and `/.well-known/openid-configuration/api/auth` (answered with better-auth's appended OpenID document,
// services/mcp/discovery.ts). 404 while MCP OAuth is unavailable (docs/mcp.md §3.8).

export default defineEventHandler(async (event) => {
  if (!isBootComplete()) throw apiError('unavailable', 'the orchestrator is starting')
  if (!resolveMcpConfig(useConfig()).oauth) throw apiError('notFound', 'OAuth discovery is not available')
  const path = event.path.split('?')[0] ?? '/'
  if (handleOpenCorsPreflight(event, path)) return
  applyOpenCors(event)
  const auth = useAuth()
  const request = toWebRequest(event)
  const response: Response = await auth.handler(toBetterAuthDiscoveryRequest(request, auth.options.basePath))
  // The path better-auth routes (dot segments resolved), not the raw one.
  return isProtectedResourceMetadataPath(new URL(request.url).pathname) ? withResourceName(response) : response
})
