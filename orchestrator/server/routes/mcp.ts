import { defineEventHandler, sendWebResponse, toWebRequest } from 'h3'
import { createScantorMcpHandler, type McpRequestHandler, REQUEST_ID_HEADER } from '../services/mcp/server'
import { resolveMcpConfig } from '../utils/auth-policy'
import { isBootComplete } from '../utils/boot'
import { useConfig } from '../utils/config'
import { applyOpenCors, handleOpenCorsPreflight } from '../utils/cors'
import { apiError } from '../utils/errors'
import { readGuide } from '../utils/guide-assets'
import { useLoopbackOrigin } from '../utils/loopback'

// `/mcp` (docs/mcp.md §2): not under /api, it authenticates itself. The request URL is canonicalised to
// `${SCANTOR_PUBLIC_URL}/mcp`, because tokens and DPoP proofs are bound to the public URL while Traefik forwards
// an internal one. CORS allows any origin without credentials.

let handler: Promise<McpRequestHandler> | null = null

/** The handler of this process, created once the loopback listener for tool calls is up; a failure is not cached. */
function mcpHandler(): Promise<McpRequestHandler> {
  handler ??= (async () => createScantorMcpHandler(readGuide, await useLoopbackOrigin()))().catch((error: unknown) => {
    handler = null
    throw error
  })
  return handler
}

export default defineEventHandler(async (event) => {
  if (!isBootComplete()) throw apiError('unavailable', 'the orchestrator is starting')
  const config = resolveMcpConfig(useConfig())
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
  const handle = await mcpHandler()
  return sendWebResponse(event, await handle(canonical))
})
