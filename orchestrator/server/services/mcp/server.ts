import { randomUUID } from 'node:crypto'
import { type AuthInfo, createMcpHandler, McpServer, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server'
import { requireMcpAuth } from '@better-auth/mcp'
import { useAuth } from '../../utils/auth'
import { MCP_CHALLENGE_SCOPES, type McpConfig, resolveMcpConfig } from '../../utils/auth-policy'
import { useConfig } from '../../utils/config'
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

function jsonRpcError(status: number, message: string, wwwAuthenticate: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json', 'www-authenticate': wwwAuthenticate },
  })
}

/** 401 with the OAuth challenge, so a client with a bad API key can fall back to OAuth (docs/mcp.md §3.7). */
function challenge(config: McpConfig, message: string): Response {
  const parts = [`Bearer error="invalid_token"`, `error_description="${message}"`]
  if (config.oauth) parts.push(`resource_metadata="${protectedResourceMetadataUrl(config)}"`)
  parts.push(`scope="${MCP_CHALLENGE_SCOPES.join(' ')}"`)
  return jsonRpcError(401, message, parts.join(', '))
}

function revoked(config: McpConfig): Response {
  const message = 'Access revoked: the user no longer exists, is banned or no longer authorizes this application'
  return jsonRpcError(
    401,
    message,
    `Bearer error="invalid_token", error_description="${message}", resource_metadata="${protectedResourceMetadataUrl(config)}"`,
  )
}

/** docs/mcp.md §2: tools without listChanged, resources without subscribe, no prompts, sampling or elicitation. */
const CAPABILITIES = { tools: { listChanged: false }, resources: { listChanged: false } }

async function buildServer(principal: UserPrincipal, requestId: string, readGuide: GuideReader, loopbackOrigin: string): Promise<McpServer> {
  const [catalogue, instructions] = await Promise.all([loadCatalogue(), loadInstructions(readGuide)])
  const server = new McpServer({ name: 'scantor', title: 'scantor', version: scantorVersion }, { instructions, capabilities: CAPABILITIES })
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
      maxRequestBodySize: 1024 * 1024,
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
      const principal = await principalFromApiKey(key)
      if (!principal) return challenge(config, 'invalid, expired or revoked API key')
      const requestId = request.headers.get(REQUEST_ID_HEADER) ?? randomUUID()
      return serve(request, { token: '', clientId: 'api-key', scopes: [], extra: { principal, requestId } satisfies McpAuthExtra })
    }
    if (!oauth) return challenge(config, 'an API key is required (MCP OAuth needs an https SCANTOR_PUBLIC_URL)')
    return oauth(request)
  }
}
