import { defineEventHandler, toWebRequest } from 'h3'
import { useAuth } from '../../utils/auth'
import { resolveMcpConfig } from '../../utils/auth-policy'
import { isBootComplete } from '../../utils/boot'
import { useConfig } from '../../utils/config'
import { applyOpenCors, handleOpenCorsPreflight } from '../../utils/cors'
import { apiError } from '../../utils/errors'

// OAuth and MCP discovery at the origin root (docs/api.md §3, docs/mcp.md §3.1), forwarded to better-auth:
// `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server/api/auth` and
// `/.well-known/openid-configuration/api/auth`. 404 while MCP OAuth is unavailable (docs/mcp.md §3.8).

export default defineEventHandler(async (event) => {
  if (!isBootComplete()) throw apiError('unavailable', 'the orchestrator is starting')
  if (!resolveMcpConfig(useConfig()).oauth) throw apiError('notFound', 'OAuth discovery is not available')
  const path = event.path.split('?')[0] ?? '/'
  if (handleOpenCorsPreflight(event, path)) return
  applyOpenCors(event)
  return useAuth().handler(toWebRequest(event))
})
