import { randomUUID } from 'node:crypto'
import { type AuthInfo, createMcpHandler, McpServer, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server'
import { requireMcpAuth } from '@better-auth/mcp'
import { useAuth } from '../../utils/auth'
import { MCP_CHALLENGE_SCOPES, type McpConfig, resolveMcpConfig } from '../../utils/auth-policy'
import { PROTOCOL_BODY_LIMIT } from '../../utils/body-limits'
import { useConfig } from '../../utils/config'
import { ApiError } from '../../utils/errors'
import { useLogger } from '../../utils/logger'
import type { UserPrincipal } from '../../utils/principal'
import { scantorVersion } from '../../utils/version'
import { type AccessTokenClaims, mcpApiKeyOf, principalFromApiKey, principalFromToken, tokenClientId, tokenScopes } from './auth'
import { callApiTool } from './bridge'
import type { GuideReader } from '../../utils/guides'
import { loadInstructions, registerGuideResources } from './resources'
import { loadCatalogue, toolsForLevel } from './tools'

// The `/mcp` endpoint (docs/mcp.md §2): Streamable HTTP, stateless, MCP SDK v2. Every request authenticates
// (OAuth access token or API key), then a new McpServer bound to the caller is built with the tools of its level,
// the guide resources and the instructions.

const log = useLogger('mcp')

interface McpAuthExtra {
  principal: UserPrincipal
  requestId: string
}

function protectedResourceMetadataUrl(config: McpConfig): string {
  const url = new URL(config.resource)
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`
}

function jsonRpcError(status: number, message: string, headers: Record<string, string>): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** 401 with the OAuth challenge, so a client with a bad API key can fall back to OAuth (docs/mcp.md §3.7). */
function challenge(config: McpConfig, message: string): Response {
  const parts = [`Bearer error="invalid_token"`, `error_description="${message}"`]
  if (config.oauth) parts.push(`resource_metadata="${protectedResourceMetadataUrl(config)}"`)
  parts.push(`scope="${MCP_CHALLENGE_SCOPES.join(' ')}"`)
  return jsonRpcError(401, message, { 'www-authenticate': parts.join(', ') })
}

function revoked(config: McpConfig): Response {
  const message = 'Access revoked: the user no longer exists, is banned or no longer authorizes this application'
  return jsonRpcError(401, message, {
    'www-authenticate': `Bearer error="invalid_token", error_description="${message}", resource_metadata="${protectedResourceMetadataUrl(config)}"`,
  })
}

/** 503 without a challenge: the credential could not be checked, so the client keeps it and retries. */
function unavailable(message: string): Response {
  return jsonRpcError(503, message, { 'retry-after': '5' })
}

/** docs/mcp.md §2: tools without listChanged, resources without subscribe, no prompts, sampling or elicitation. */
const CAPABILITIES = { tools: { listChanged: false }, resources: { listChanged: false } }

/**
 * docs/mcp.md §2: the server info, with the app icon of brand/favicons that the dashboard serves on the origin of
 * `/mcp`, so clients can show it without fetching from another host.
 */
function serverInfo(publicUrl: string) {
  return {
    name: 'scantor',
    title: 'scantor',
    version: scantorVersion,
    icons: [
      { src: new URL('/favicon.svg', publicUrl).href, mimeType: 'image/svg+xml', sizes: ['any'] },
      { src: new URL('/android-chrome-192x192.png', publicUrl).href, mimeType: 'image/png', sizes: ['192x192'] },
    ],
  }
}

async function buildServer(principal: UserPrincipal, requestId: string, readGuide: GuideReader, loopbackOrigin: string): Promise<McpServer> {
  const [catalogue, instructions] = await Promise.all([loadCatalogue(), loadInstructions(readGuide)])
  const server = new McpServer(serverInfo(useConfig().publicUrl), { instructions, capabilities: CAPABILITIES })
  const tools = toolsForLevel(catalogue, principal.mcp?.level ?? 'read')
  for (const tool of tools) {
    server.registerTool(tool.name, tool.config, (input: unknown) =>
      callApiTool(tool, (input ?? {}) as Record<string, unknown>, principal, requestId, loopbackOrigin),
    )
  }
  // The SDK installs the tools handlers with the first registered tool; a level without tools still answers.
  if (tools.length === 0) {
    server.server.setRequestHandler('tools/list', () => ({ tools: [] }))
    server.server.setRequestHandler('tools/call', (request) => {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${request.params.name} not found`)
    })
  }
  registerGuideResources(server, readGuide, instructions)
  return server
}

/** Header carrying the request id of the `/mcp` request into the handler (set by server/routes/mcp.ts). */
export const REQUEST_ID_HEADER = 'x-request-id'

export type McpRequestHandler = (request: Request) => Promise<Response>

/**
 * Builds the request handler of `/mcp` (once per process). Tool calls and the JWKS fetch go to this process's
 * loopback listener at `loopbackOrigin` (server/utils/loopback.ts).
 */
export function createScantorMcpHandler(readGuide: GuideReader, loopbackOrigin: string): McpRequestHandler {
  const config = resolveMcpConfig(useConfig())
  const handler = createMcpHandler(
    async (ctx) => {
      const extra = ctx.authInfo?.extra as McpAuthExtra | undefined
      if (!extra) throw new Error('MCP request reached the server factory without an authenticated principal')
      return buildServer(extra.principal, extra.requestId, readGuide, loopbackOrigin)
    },
    {
      legacy: 'stateless',
      responseMode: 'auto',
      keepAliveMs: 15_000,
      maxRequestBodySize: PROTOCOL_BODY_LIMIT,
      onerror: (error) => log.warn('MCP request error', { err: error }),
    },
  )

  const serve = (request: Request, authInfo: AuthInfo) => handler.fetch(request, { authInfo })

  const oauth = config.oauth
    ? requireMcpAuth(
          useAuth(),
          async (request: Request, claims: AccessTokenClaims) => {
            const principal = await principalFromToken(claims)
            if (!principal) return revoked(config)
            const token = request.headers.get('authorization')?.replace(/^\S+\s+/, '') ?? ''
            const requestId = request.headers.get(REQUEST_ID_HEADER) ?? randomUUID()
            return serve(request, {
              token,
              clientId: tokenClientId(claims),
              scopes: tokenScopes(claims),
              extra: { principal, requestId } satisfies McpAuthExtra,
            })
          },
          {
            resource: config.resource,
            jwksUrl: `${loopbackOrigin}/api/auth/jwks`,
            requiredScopes: ['scantor:read'],
            isScopeSatisfied: (required: string, granted: ReadonlySet<string>) =>
              required === 'scantor:read'
                ? ['scantor:read', 'scantor:write', 'scantor:admin'].some((scope) => granted.has(scope))
                : granted.has(required),
            challengeScopes: MCP_CHALLENGE_SCOPES,
          },
        )
    : null

  return async (request) => {
    const key = mcpApiKeyOf(request.headers)
    if (key) {
      let principal: UserPrincipal | null
      try {
        principal = await principalFromApiKey(key)
      } catch (error) {
        if (error instanceof ApiError && error.code === 'unavailable') return unavailable(error.message)
        throw error
      }
      if (!principal) return challenge(config, 'invalid, expired or revoked API key')
      const requestId = request.headers.get(REQUEST_ID_HEADER) ?? randomUUID()
      return serve(request, { token: '', clientId: 'api-key', scopes: [], extra: { principal, requestId } satisfies McpAuthExtra })
    }
    if (!oauth) return challenge(config, 'an API key is required (MCP OAuth needs an https SCANTOR_PUBLIC_URL)')
    return oauth(request)
  }
}
