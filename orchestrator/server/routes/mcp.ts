import { defineEventHandler, sendWebResponse, toWebRequest } from 'h3'
import type { RequestOrigin } from '#shared/utils/enums'
import { createScantorMcpHandler, type McpRequestHandler, REQUEST_ID_HEADER } from '../services/mcp/server'
import { resolveMcpConfig } from '../utils/auth-policy'
import { isBootComplete } from '../utils/boot'
import { useConfig } from '../utils/config'
import { applyOpenCors, handleOpenCorsPreflight } from '../utils/cors'
import { apiError } from '../utils/errors'
import { readGuide } from '../utils/guide-assets'
import { useLoopbackOrigin } from '../utils/loopback'
import { requestOriginOf } from '../utils/tunnel'

// `/mcp` (docs/mcp.md §2): not under /api, it authenticates itself. Each origin (public URL, tunnel URL) has its own
// handler, bound to its better-auth instance and resource. The request URL is canonicalised to that resource
// (`${SCANTOR_PUBLIC_URL}/mcp` or `${SCANTOR_TUNNEL_URL}/mcp`), because tokens and DPoP proofs are bound to it while
// Traefik forwards an internal one. CORS allows any origin without credentials.

const handlers = new Map<RequestOrigin, Promise<McpRequestHandler>>()

/**
 * The handler of an origin in this process, created once the loopback listener for tool calls is up; a failure is not
 * cached.
 */
function mcpHandler(origin: RequestOrigin): Promise<McpRequestHandler> {
  let handler = handlers.get(origin)
  if (!handler) {
    handler = (async () => createScantorMcpHandler(readGuide, await useLoopbackOrigin(), origin))().catch((error: unknown) => {
      handlers.delete(origin)
      throw error
    })
    handlers.set(origin, handler)
  }
  return handler
}

export default defineEventHandler(async (event) => {
  if (!isBootComplete()) throw apiError('unavailable', 'the orchestrator is starting')
  const origin = requestOriginOf(event)
  const config = resolveMcpConfig(useConfig(), origin)
  if (!config.enabled) throw apiError('notFound', 'MCP is disabled')
  if (handleOpenCorsPreflight(event, '/mcp')) return
  applyOpenCors(event)

  const request = toWebRequest(event)
  const headers = new Headers(request.headers)
  headers.set(REQUEST_ID_HEADER, String(event.context.requestId ?? ''))
  const canonical = new Request(new URL(new URL(request.url).search, config.resource), {
    method: request.method,
    headers,
    body: request.body,
    // @ts-expect-error Node's fetch needs duplex for streamed request bodies
    duplex: 'half',
  })
  const handle = await mcpHandler(origin)
  return sendWebResponse(event, await handle(canonical))
})
