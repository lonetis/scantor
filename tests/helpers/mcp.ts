import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client'
import type { CallToolResult, OAuthClientMetadata, OAuthClientProvider, StoredOAuthClientInformation, StoredOAuthTokens } from '@modelcontextprotocol/client'
import type { APIRequestContext } from '@playwright/test'
import { env } from './env'
import { reserve } from './limiter'

// MCP clients for tests (docs/testing.md §7.8, docs/mcp.md §3): through the real OAuth 2.1 flow as a signed-in user
// (401 challenge → discovery → the worker's registered client → consent → PKCE token exchange → connect), or with an
// API key as bearer token. The SDK's own OAuth machinery runs the protocol; the helper plays the user's part on the
// consent page with the user's session. Dynamic client registration reserves a limiter slot and is cached per worker
// by the fixtures, because better-auth allows only 10 registrations per minute per IP.

/** Loopback redirect URI of the test client. Nothing listens there: the code is read from the consent redirect. */
export const REDIRECT_URI = 'http://127.0.0.1:53682/callback'
export const ISSUER = `${env.publicUrl}/api/auth`

/** Scopes of a "Read and write" grant, the consent page's default level. */
export const DEFAULT_MCP_SCOPES = 'offline_access scantor:read scantor:write'

const CLIENT_INFO = { name: 'scantor-tests', version: '1.0.0' }

export class TestOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL
  private info?: StoredOAuthClientInformation
  private storedTokens?: StoredOAuthTokens
  private verifier?: string

  constructor(
    private readonly scopes: string,
    client?: StoredOAuthClientInformation,
  ) {
    this.info = client
  }

  get redirectUrl(): string {
    return REDIRECT_URI
  }

  get clientMetadata(): OAuthClientMetadata {
    return { ...clientMetadata(), scope: this.scopes }
  }

  clientInformation() {
    return this.info
  }
  saveClientInformation(info: StoredOAuthClientInformation) {
    this.info = info
  }
  tokens() {
    return this.storedTokens
  }
  saveTokens(tokens: StoredOAuthTokens) {
    this.storedTokens = tokens
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier
  }
  codeVerifier() {
    if (!this.verifier) throw new Error('no PKCE verifier was saved')
    return this.verifier
  }
}

function clientMetadata(): OAuthClientMetadata {
  return {
    client_name: 'scantor tests',
    redirect_uris: [REDIRECT_URI],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: 'offline_access scantor:read scantor:write scantor:admin',
  }
}

/** Registers a public client through dynamic client registration (one limiter slot, no session needed). */
export async function registerClient(context: APIRequestContext, metadata: Partial<OAuthClientMetadata> = {}): Promise<StoredOAuthClientInformation> {
  await reserve('/oauth2/register')
  const response = await context.post(`${ISSUER}/oauth2/register`, { data: { ...clientMetadata(), ...metadata } })
  if (!response.ok()) throw new Error(`client registration failed: ${response.status()} ${await response.text()}`)
  return (await response.json()) as StoredOAuthClientInformation
}

/**
 * Plays the user's part of an authorization with the signed-in `session`: follows the authorize URL and, on the consent
 * page, approves with `scope` (or denies). Returns the redirect URL back to the client (with `code` or `error`).
 */
export async function approveAuthorization(
  session: APIRequestContext,
  authorizationUrl: URL,
  options: { accept?: boolean; scope?: string } = {},
): Promise<URL> {
  const authorize = await session.get(authorizationUrl.toString(), { maxRedirects: 0 })
  const location = authorize.headers()['location']
  if (!location) throw new Error(`authorize did not redirect: ${authorize.status()} ${await authorize.text()}`)
  const next = new URL(location, env.publicUrl)
  if (next.origin !== env.publicUrl || next.pathname !== '/oauth/consent') return next
  const accept = options.accept ?? true
  // What the consent page does: POST the decision with the signed query of the authorize redirect.
  const consent = await session.post('/api/auth/oauth2/consent', {
    headers: { Accept: 'application/json' },
    data: {
      accept,
      oauth_query: next.search.slice(1),
      ...(accept ? { scope: options.scope ?? authorizationUrl.searchParams.get('scope') ?? DEFAULT_MCP_SCOPES } : {}),
    },
  })
  if (!consent.ok()) throw new Error(`consent failed: ${consent.status()} ${await consent.text()}`)
  const body = (await consent.json()) as { url?: string }
  if (!body.url) throw new Error(`consent answered without a redirect URL: ${JSON.stringify(body)}`)
  return new URL(body.url)
}

export interface McpConnection {
  client: Client
  provider: TestOAuthProvider
  accessToken: string
  close(): Promise<void>
}

export interface ConnectOptions {
  /** requested scopes; the consent grants them unless `consentScope` narrows the level */
  scopes?: string
  /** the scope the user approves on the consent page (default: the requested scopes) */
  consentScope?: string
  /** a registered client to reuse (from registerClient); without it the SDK registers one (one limiter slot) */
  client?: StoredOAuthClientInformation
}

/** Connects an MCP client as the user signed in to `session`, through the full OAuth flow. */
export async function connectMcp(session: APIRequestContext, options: ConnectOptions = {}): Promise<McpConnection> {
  const scopes = options.scopes ?? DEFAULT_MCP_SCOPES
  const provider = new TestOAuthProvider(scopes, options.client)
  if (!options.client) await reserve('/oauth2/register')
  const challenged = new StreamableHTTPClientTransport(new URL(env.mcpUrl), { authProvider: provider })
  try {
    await new Client(CLIENT_INFO).connect(challenged)
    throw new Error('the unauthenticated MCP connect was not challenged')
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error
  }
  if (!provider.authorizationUrl) throw new Error('the MCP SDK did not start an authorization')
  const callback = await approveAuthorization(session, provider.authorizationUrl, { scope: options.consentScope ?? scopes })
  const code = callback.searchParams.get('code')
  if (!code) throw new Error(`the authorization returned no code: ${callback.toString()}`)
  await challenged.finishAuth(callback.searchParams)

  const client = new Client(CLIENT_INFO)
  await client.connect(new StreamableHTTPClientTransport(new URL(env.mcpUrl), { authProvider: provider }))
  const tokens = provider.tokens()
  if (!tokens) throw new Error('the MCP SDK stored no tokens')
  return { client, provider, accessToken: tokens.access_token, close: () => client.close() }
}

/** Connects with a fixed bearer credential: an API key (`sk_scantor_…`) or an access token. */
export async function connectMcpWithKey(key: string): Promise<Client> {
  const client = new Client(CLIENT_INFO)
  await client.connect(new StreamableHTTPClientTransport(new URL(env.mcpUrl), { authProvider: { token: async () => key } }))
  return client
}

/** The concatenated text content of a tool result. */
export function resultText(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
}

/** Calls a tool and returns its structured content (or its parsed JSON text); throws on a tool error. */
export async function callJson<T = unknown>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = (await client.callTool({ name, arguments: args }, { timeout: 120_000 })) as CallToolResult
  if (result.isError) throw new Error(`${name} failed: ${resultText(result)}`)
  if (result.structuredContent !== undefined) return result.structuredContent as T
  return JSON.parse(resultText(result)) as T
}

/** Calls a tool that must fail; returns the error text. */
export async function callError(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = (await client.callTool({ name, arguments: args }, { timeout: 120_000 })) as CallToolResult
  if (!result.isError) throw new Error(`${name} unexpectedly succeeded: ${resultText(result)}`)
  return resultText(result)
}
