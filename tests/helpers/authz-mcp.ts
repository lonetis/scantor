import { createHash, randomBytes } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import type { Client, StoredOAuthClientInformation } from '@modelcontextprotocol/client'
import { env } from './env'
import { connectMcpWithKey, ISSUER, REDIRECT_URI, registerClient } from './mcp'
import { oauthRequest } from './mcp-limiter'
import { newApiContext } from './users'

// The OAuth half of the MCP authorization matrix (docs/security.md §7, docs/mcp.md §3) for authz/matrix.spec.ts: a
// user's session authorizes a registered client with PKCE, approves a scope on the consent page and exchanges the
// code; the MCP client then connects with the access token. The authorize and token requests go through the suite's
// OAuth budget (helpers/mcp-limiter.ts): better-auth's oauth-provider limits them per client IP without the stack's
// SCANTOR_AUTH_RATE_LIMIT_SCALE, and the whole suite shares one IP.

export interface McpGrant {
  client: Client
  accessToken: string
  /** the scope the token endpoint granted */
  scope: string
  close(): Promise<void>
}

/** Registers a public client by dynamic client registration (one slot of the registration budget). */
export async function registerMatrixClient(): Promise<StoredOAuthClientInformation> {
  const context = await newApiContext()
  try {
    return await registerClient(context, { client_name: 'scantor authz matrix' })
  } finally {
    await context.dispose()
  }
}

/**
 * Authorizes `client` as the user of `session` for `scope`, approving `consentScope` (default: `scope`) on the consent
 * page, and connects an MCP client with the access token. `prompt=consent` shows the consent page even when the user
 * already approved this client, so every grant carries exactly the approved scope.
 */
export async function connectWithGrant(
  session: APIRequestContext,
  client: StoredOAuthClientInformation,
  scope: string,
  consentScope = scope,
): Promise<McpGrant> {
  const verifier = randomBytes(32).toString('base64url')
  const authorizeUrl = new URL(`${ISSUER}/oauth2/authorize`)
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    scope,
    state: randomBytes(8).toString('hex'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: env.mcpUrl,
    prompt: 'consent',
  }).toString()

  const authorize = await oauthRequest('/oauth2/authorize', () => session.get(authorizeUrl.toString(), { maxRedirects: 0 }))
  const location = authorize.headers()['location']
  if (!location) throw new Error(`authorize did not redirect: ${authorize.status()} ${await authorize.text()}`)
  const consentUrl = new URL(location, env.publicUrl)
  if (consentUrl.origin !== env.publicUrl || consentUrl.pathname !== '/oauth/consent')
    throw new Error(`authorize went to ${consentUrl} instead of the consent page`)

  const consent = await session.post('/api/auth/oauth2/consent', {
    headers: { Accept: 'application/json' },
    data: { accept: true, scope: consentScope, oauth_query: consentUrl.search.slice(1) },
  })
  if (!consent.ok()) throw new Error(`consent failed: ${consent.status()} ${await consent.text()}`)
  const redirect = ((await consent.json()) as { url?: string }).url
  if (!redirect) throw new Error('the consent answered without a redirect URL')
  const code = new URL(redirect).searchParams.get('code')
  if (!code) throw new Error(`the authorization returned no code: ${redirect}`)

  const token = await oauthRequest('/oauth2/token', () =>
    session.post(`${ISSUER}/oauth2/token`, {
      form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: client.client_id, code_verifier: verifier, resource: env.mcpUrl },
    }),
  )
  if (!token.ok()) throw new Error(`the code exchange failed: ${token.status()} ${await token.text()}`)
  const tokens = (await token.json()) as { access_token: string; scope?: string }
  const mcp = await connectMcpWithKey(tokens.access_token)
  return { client: mcp, accessToken: tokens.access_token, scope: tokens.scope ?? '', close: () => mcp.close() }
}
