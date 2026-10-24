import { createHash, randomBytes } from 'node:crypto'
import type { APIRequestContext, APIResponse } from '@playwright/test'
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client'
import type { FetchLike, OAuthClientMetadata, StoredOAuthClientInformation } from '@modelcontextprotocol/client'
import { env } from './env'
import { DEFAULT_MCP_SCOPES, ISSUER, REDIRECT_URI, registerClient, TestOAuthProvider, type McpConnection } from './mcp'
import { oauthRequest, reserveOAuth, retryAfterMs } from './mcp-limiter'
import { unique } from './unique'
import { newApiContext } from './users'

// The OAuth 2.1 flow of the MCP server step by step (docs/mcp.md §3.1–§3.6) for the mcp writer's specs: the worker's
// registered client, PKCE, the authorize redirect to the consent page, the consent decision, the token exchange and
// refresh, and raw `/mcp` requests for status and challenge checks. helpers/mcp.ts connects an SDK client through the
// whole flow; these pieces let a test stop at, or tamper with, any step. Authorize and token requests go through the
// OAuth budget of helpers/mcp-limiter.ts.

/** The resource every MCP token is bound to. */
export const MCP_RESOURCE = env.mcpUrl
/** The consent page of the dashboard. */
export const CONSENT_PATH = '/oauth/consent'
/** Scopes of an "Admin" grant. */
export const ADMIN_MCP_SCOPES = 'offline_access scantor:read scantor:write scantor:admin'

let workerClient: Promise<StoredOAuthClientInformation> | undefined

/**
 * The OAuth client of this worker process, registered once through dynamic client registration (one limiter slot).
 * The outcome is cached for the worker's lifetime, a failed registration included: every test that needs the client
 * then fails with the same registration error instead of spending another slot of the shared registration budget.
 */
export function workerOAuthClient(): Promise<StoredOAuthClientInformation> {
  workerClient ??= (async () => {
    const context = await newApiContext()
    try {
      return await registerClient(context)
    } finally {
      await context.dispose()
    }
  })()
  return workerClient
}

/**
 * A client registered for one test (one registration slot). Consents are stored per user and client, so a client of
 * its own gives the worker's tenant a clean consent state for the test without a fresh user.
 */
export async function registerTestClient(name = unique('mcp-client'), metadata: Partial<OAuthClientMetadata> = {}): Promise<StoredOAuthClientInformation> {
  const context = await newApiContext()
  try {
    return await registerClient(context, { client_name: name, ...metadata })
  } finally {
    await context.dispose()
  }
}

export interface Pkce {
  verifier: string
  challenge: string
}

/** A PKCE pair with the S256 method. */
export function pkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export interface AuthorizationRequest {
  clientId: string
  scope: string
  challenge: string
  redirectUri?: string
  state?: string
  /** `consent` shows the consent page even when the user already consented to these scopes */
  prompt?: string
}

/** The authorize URL an MCP client opens in the browser. */
export function authorizationUrl(request: AuthorizationRequest): URL {
  const url = new URL(`${ISSUER}/oauth2/authorize`)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: request.clientId,
    redirect_uri: request.redirectUri ?? REDIRECT_URI,
    scope: request.scope,
    state: request.state ?? randomBytes(8).toString('hex'),
    code_challenge: request.challenge,
    code_challenge_method: 'S256',
    resource: MCP_RESOURCE,
    ...(request.prompt ? { prompt: request.prompt } : {}),
  }).toString()
  return url
}

/** GET of an authorize URL (without following redirects) within the OAuth budget. */
export function authorizeRequest(session: APIRequestContext, url: URL): Promise<APIResponse> {
  return oauthRequest('/oauth2/authorize', () => session.get(url.toString(), { maxRedirects: 0 }))
}

/** Follows the authorize URL with a signed-in session; returns where it redirects (the consent page on success). */
export async function authorizeRedirect(session: APIRequestContext, url: URL): Promise<URL> {
  const response = await authorizeRequest(session, url)
  const location = response.headers()['location']
  if (!location) throw new Error(`authorize did not redirect: ${response.status()} ${await response.text()}`)
  return new URL(location, env.publicUrl)
}

/** The consent decision the consent page posts, with the signed query of the authorize redirect. */
export function postConsent(session: APIRequestContext, consentUrl: URL, decision: { accept: boolean; scope?: string }): Promise<APIResponse> {
  return session.post('/api/auth/oauth2/consent', {
    headers: { Accept: 'application/json' },
    data: { ...decision, oauth_query: consentUrl.search.slice(1) },
  })
}

/** The redirect URL back to the client from a consent response (`{redirect, url}`). */
export async function consentRedirect(response: APIResponse): Promise<URL> {
  if (!response.ok()) throw new Error(`consent failed: ${response.status()} ${await response.text()}`)
  const body = (await response.json()) as { url?: unknown }
  if (typeof body.url !== 'string') throw new Error(`consent answered without a redirect URL: ${JSON.stringify(body)}`)
  return new URL(body.url)
}

export interface TokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  scope?: string
  refresh_token?: string
  id_token?: string
}

/** POSTs a form to the token endpoint (within the OAuth budget) and returns the raw response. */
export function tokenRequest(request: APIRequestContext, form: Record<string, string>): Promise<APIResponse> {
  return oauthRequest('/oauth2/token', () => request.post(`${ISSUER}/oauth2/token`, { form: { resource: MCP_RESOURCE, ...form } }))
}

async function tokensOf(response: APIResponse, what: string): Promise<TokenResponse> {
  if (!response.ok()) throw new Error(`${what} failed: ${response.status()} ${await response.text()}`)
  return (await response.json()) as TokenResponse
}

/** Exchanges an authorization code (PKCE) for tokens. */
export async function exchangeCode(
  request: APIRequestContext,
  clientId: string,
  code: string,
  verifier: string,
  redirectUri = REDIRECT_URI,
): Promise<TokenResponse> {
  const response = await tokenRequest(request, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  })
  return tokensOf(response, 'the code exchange')
}

/** Redeems a refresh token. */
export async function refreshTokens(request: APIRequestContext, clientId: string, refreshToken: string): Promise<TokenResponse> {
  const response = await tokenRequest(request, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId })
  return tokensOf(response, 'the refresh')
}

export interface Authorized {
  client: StoredOAuthClientInformation
  tokens: TokenResponse
}

/**
 * Runs the whole authorization as the user signed in to `session`: the worker's client (unless `client` is given)
 * requests `scope`, the user approves with `consentScope` (default: the requested scopes) and the code is exchanged.
 * `prompt=consent` makes better-auth show the consent page although an earlier test of the same user and client
 * may already have consented to these scopes (it would redirect with a code at once otherwise).
 */
export async function authorize(
  session: APIRequestContext,
  options: { scope?: string; consentScope?: string; client?: StoredOAuthClientInformation } = {},
): Promise<Authorized> {
  const client = options.client ?? (await workerOAuthClient())
  const scope = options.scope ?? DEFAULT_MCP_SCOPES
  const { verifier, challenge } = pkce()
  const consentUrl = await authorizeRedirect(session, authorizationUrl({ clientId: client.client_id, scope, challenge, prompt: 'consent' }))
  if (consentUrl.pathname !== CONSENT_PATH) throw new Error(`authorize went to ${consentUrl.toString()} instead of the consent page`)
  const callback = await consentRedirect(await postConsent(session, consentUrl, { accept: true, scope: options.consentScope ?? scope }))
  const code = callback.searchParams.get('code')
  if (!code) throw new Error(`the authorization returned no code: ${callback.toString()}`)
  return { client, tokens: await exchangeCode(session, client.client_id, code, verifier) }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A fetch for the MCP SDK whose token requests take a slot of the OAuth token budget and wait out a 429 of the
 * provider's per-IP token limit (X-Retry-After) before they are sent again, for up to `timeoutMs`.
 */
function budgetedFetch(timeoutMs: number): FetchLike {
  const deadline = Date.now() + timeoutMs
  return async (url, init) => {
    const limited = new URL(url).pathname === new URL(`${ISSUER}/oauth2/token`).pathname
    for (;;) {
      if (limited) await reserveOAuth('/oauth2/token')
      const response = await fetch(url, init)
      if (!limited || response.status !== 429 || Date.now() >= deadline) return response
      await sleep(Math.min(retryAfterMs(response.headers.get('x-retry-after')), Math.max(deadline - Date.now(), 0)))
    }
  }
}

/**
 * Connects an MCP client as the user signed in to `session` through the SDK's OAuth flow (401 challenge, discovery,
 * the given registered client, PKCE S256), like helpers/mcp.ts `connectMcp`, but within the OAuth budget: the
 * authorize and token requests wait out a 429 of the provider's per-IP limits, which better-auth resets only after
 * a minute without requests and which every spec on the shared stack spends.
 */
export async function connectMcpPatiently(
  session: APIRequestContext,
  options: { client: StoredOAuthClientInformation; scopes?: string; consentScope?: string; timeoutMs?: number },
): Promise<McpConnection> {
  const scopes = options.scopes ?? DEFAULT_MCP_SCOPES
  const provider = new TestOAuthProvider(scopes, options.client)
  const fetchFn = budgetedFetch(options.timeoutMs ?? 150_000)
  const challenged = new StreamableHTTPClientTransport(new URL(env.mcpUrl), { authProvider: provider, fetch: fetchFn })
  const unchallenged = await new Client({ name: 'scantor-tests', version: '1.0.0' }).connect(challenged).then(
    () => true,
    (error: unknown) => {
      if (error instanceof UnauthorizedError) return false
      throw error
    },
  )
  if (unchallenged) throw new Error('the unauthenticated MCP connect was not challenged')
  if (!provider.authorizationUrl) throw new Error('the MCP SDK did not start an authorization')

  // The SDK's authorization URL has no prompt=consent: a user who already consented to these scopes is sent back
  // with a code at once, otherwise the consent page decides.
  const next = await authorizeRedirect(session, provider.authorizationUrl)
  const callback =
    next.origin === env.publicUrl && next.pathname === CONSENT_PATH
      ? await consentRedirect(await postConsent(session, next, { accept: true, scope: options.consentScope ?? scopes }))
      : next
  if (!callback.searchParams.get('code')) throw new Error(`the authorization returned no code: ${callback.toString()}`)
  await challenged.finishAuth(callback.searchParams)

  const client = new Client({ name: 'scantor-tests', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(env.mcpUrl), { authProvider: provider, fetch: fetchFn }))
  const tokens = provider.tokens()
  if (!tokens) throw new Error('the MCP SDK stored no tokens')
  return { client, provider, accessToken: tokens.access_token, close: () => client.close() }
}

/** The claims of a JWT (not verified: the server verifies, the test only reads). */
export function jwtClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1]
  if (!payload) throw new Error('not a JWT')
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
}

export interface RawMcpResponse {
  status: number
  headers: Record<string, string>
  /** the JSON-RPC body, parsed from JSON or from the first SSE `data:` line */
  body: Record<string, unknown> | null
}

/** A raw JSON-RPC POST to /mcp (default `tools/list`), for status codes, headers and challenges. */
export async function rawMcp(request: APIRequestContext, headers: Record<string, string>, payload?: Record<string, unknown>): Promise<RawMcpResponse> {
  const response = await request.post(env.mcpUrl, {
    headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...headers },
    data: payload ?? { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  })
  const text = await response.text()
  const json = text.startsWith('{')
    ? text
    : (text
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6) ?? '')
  return { status: response.status(), headers: response.headers(), body: json ? (JSON.parse(json) as Record<string, unknown>) : null }
}

/** The parameters of a `WWW-Authenticate: Bearer …` challenge. */
export function bearerChallenge(header: string | undefined): Record<string, string> {
  if (!header || !header.startsWith('Bearer ')) throw new Error(`not a Bearer challenge: ${header}`)
  const params: Record<string, string> = {}
  for (const match of header.slice(7).matchAll(/([a-z_]+)="([^"]*)"/g)) params[match[1]!] = match[2]!
  return params
}
