// OAuth and MCP discovery at the origin root (docs/mcp.md §3.1), served by better-auth through
// server/routes/.well-known/[...path].ts. better-auth serves the protected-resource metadata, the authorization-server
// metadata with path insertion (`/.well-known/oauth-authorization-server/api/auth`) and the OpenID metadata only
// appended to the issuer (`/api/auth/.well-known/openid-configuration`, OpenID Connect Discovery 1.0). MCP clients also
// try the OpenID metadata with path insertion (`/.well-known/openid-configuration/api/auth`), which is answered with
// the appended document, and the protected-resource metadata gets the RFC 9728 `resource_name` better-auth omits.

/** RFC 9728 `resource_name` of `/mcp`, the name the MCP server reports in its server info. */
export const MCP_RESOURCE_NAME = 'scantor'

const OPENID_CONFIGURATION = '/.well-known/openid-configuration'
const PROTECTED_RESOURCE_METADATA = '/.well-known/oauth-protected-resource'

/** The request better-auth answers for a root discovery request; `issuerPath` is better-auth's base path. */
export function toBetterAuthDiscoveryRequest(request: Request, issuerPath: string): Request {
  const url = new URL(request.url)
  if (url.pathname !== `${OPENID_CONFIGURATION}${issuerPath}` || (request.method !== 'GET' && request.method !== 'HEAD')) return request
  url.pathname = `${issuerPath}${OPENID_CONFIGURATION}`
  return new Request(url, { method: request.method, headers: request.headers })
}

export function isProtectedResourceMetadataPath(pathname: string): boolean {
  return pathname === PROTECTED_RESOURCE_METADATA || pathname.startsWith(`${PROTECTED_RESOURCE_METADATA}/`)
}

/** Adds `resource_name` to a successful protected-resource metadata document; other responses pass unchanged. */
export async function withResourceName(response: Response): Promise<Response> {
  const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (response.status !== 200 || type !== 'application/json' || !response.body) return response
  const metadata = (await response.json()) as Record<string, unknown>
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return new Response(JSON.stringify({ ...metadata, resource_name: MCP_RESOURCE_NAME }), { status: response.status, headers })
}
