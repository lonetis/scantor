import { defineEventHandler, toWebRequest } from 'h3'
import { useAuth } from '../../utils/auth'
import { dataAuthOrigin } from '../../utils/auth-policy'
import { useConfig } from '../../utils/config'
import { isLoopbackListenerSocket } from '../../utils/loopback'
import { requestOriginOf } from '../../utils/tunnel'

// better-auth (docs/api.md §3): every `/api/auth/*` endpoint, answered by the instance of the request's origin
// (docs/auth.md §2.2). Not part of the OpenAPI operation registry; the auth middleware rejects API keys here and
// applies credential-less CORS to JWKS, token and registration. The JWKS fetch of `/mcp` arrives on the loopback
// listener, which counts as public; it goes to the instance that always has the jwt plugin when any origin has MCP
// OAuth (the signing keys are shared).

export default defineEventHandler((event) => {
  const origin = isLoopbackListenerSocket(event.node.req.socket) ? dataAuthOrigin(useConfig()) : requestOriginOf(event)
  return useAuth(origin).handler(toWebRequest(event))
})
