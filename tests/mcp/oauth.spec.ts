import type { APIRequestContext } from '@playwright/test'
import type { OAuthApp } from '#shared/types/account'
import { ApiClient, ok } from '../helpers/api-client'
import { reserve } from '../helpers/limiter'
import { connectMcpWithKey, DEFAULT_MCP_SCOPES, ISSUER, REDIRECT_URI } from '../helpers/mcp'
import {
  ADMIN_MCP_SCOPES,
  authorizationUrl,
  authorize,
  authorizeRedirect,
  authorizeRequest,
  bearerChallenge,
  CONSENT_PATH,
  consentRedirect,
  jwtClaims,
  pkce,
  postConsent,
  rawMcp,
  refreshTokens,
  registerTestClient,
  tokenRequest,
  workerOAuthClient,
} from '../helpers/mcp-oauth'
import { newApiContext } from '../helpers/users'
import { withMcpTenants } from '../helpers/mcp-tenant'
import { expect, test as base, unique } from '../fixtures'

// MCP OAuth 2.1 (docs/mcp.md §3; docs/auth.md §2.2, §2.8): discovery, dynamic client registration and its redirect-URI
// policy, Client ID Metadata Documents, the PKCE code flow with consent levels, refresh, and the per-request checks
// after a revocation, a ban or a deletion; the authorized-apps API of the account (docs/api.md §4.3). The worker's
// registered client is reused; every authorization asks with prompt=consent, so the consent page always shows.

const test = withMcpTenants(base)

/** A registration with the given redirect URIs (one limiter slot); returns the raw response. */
async function register(request: APIRequestContext, redirectUris: string[]) {
  await reserve('/oauth2/register')
  return request.post(`${ISSUER}/oauth2/register`, {
    data: {
      client_name: 'scantor tests',
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: ADMIN_MCP_SCOPES,
    },
  })
}

/** A request context signed in with a saved storage state, disposed after `use`. */
async function withSession<T>(storageState: string, use: (session: APIRequestContext) => Promise<T>): Promise<T> {
  const session = await newApiContext({ storageState })
  try {
    return await use(session)
  } finally {
    await session.dispose()
  }
}

async function toolNames(token: string): Promise<string[]> {
  const client = await connectMcpWithKey(token)
  try {
    return (await client.listTools()).tools.map((tool) => tool.name)
  } finally {
    await client.close()
  }
}

/** Scopes of a token, from its `scope` claim. */
function scopesOf(token: string): string[] {
  const scope = jwtClaims(token).scope
  return typeof scope === 'string' ? scope.split(' ').filter(Boolean).sort() : []
}

test.describe('MCP OAuth discovery', () => {
  test('/mcp without a credential gets the Bearer challenge and the discovery documents are served', { tag: ['@MCP-009'] }, async ({ env, anonApi }) => {
    const challenged = await rawMcp(anonApi.request, {})
    expect(challenged.status).toBe(401)
    expect(bearerChallenge(challenged.headers['www-authenticate'])).toMatchObject({
      resource_metadata: `${env.publicUrl}/.well-known/oauth-protected-resource/mcp`,
      scope: 'offline_access scantor:read scantor:write scantor:admin',
    })

    const resource = await anonApi.request.get('/.well-known/oauth-protected-resource/mcp')
    expect(resource.status()).toBe(200)
    expect(resource.headers()['access-control-allow-origin']).toBe('*')
    expect(await resource.json()).toMatchObject({
      resource: env.mcpUrl,
      authorization_servers: [`${env.publicUrl}/api/auth`],
      bearer_methods_supported: ['header'],
      scopes_supported: expect.arrayContaining(['scantor:read', 'scantor:write', 'scantor:admin']),
    })

    const server = await anonApi.request.get('/.well-known/oauth-authorization-server/api/auth')
    expect(server.status()).toBe(200)
    const metadata = (await server.json()) as Record<string, unknown>
    expect(metadata).toMatchObject({
      issuer: `${env.publicUrl}/api/auth`,
      authorization_endpoint: `${env.publicUrl}/api/auth/oauth2/authorize`,
      token_endpoint: `${env.publicUrl}/api/auth/oauth2/token`,
      registration_endpoint: `${env.publicUrl}/api/auth/oauth2/register`,
      jwks_uri: `${env.publicUrl}/api/auth/jwks`,
      code_challenge_methods_supported: expect.arrayContaining(['S256']),
      scopes_supported: expect.arrayContaining(['offline_access', 'scantor:read', 'scantor:write', 'scantor:admin']),
    })

    // The OpenID metadata of the issuer, at the issuer-relative OIDC discovery path.
    const openid = await anonApi.request.get('/api/auth/.well-known/openid-configuration')
    expect(openid.status()).toBe(200)
    expect(await openid.json()).toMatchObject({
      issuer: `${env.publicUrl}/api/auth`,
      authorization_endpoint: `${env.publicUrl}/api/auth/oauth2/authorize`,
      token_endpoint: `${env.publicUrl}/api/auth/oauth2/token`,
      jwks_uri: `${env.publicUrl}/api/auth/jwks`,
    })
  })

  test('the OpenID metadata document is served at /.well-known/openid-configuration/api/auth', { tag: ['@MCP-009'] }, async ({ env, anonApi }) => {
    const response = await anonApi.request.get('/.well-known/openid-configuration/api/auth')
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({ issuer: `${env.publicUrl}/api/auth`, jwks_uri: `${env.publicUrl}/api/auth/jwks` })
  })

  test('the protected-resource metadata names the resource scantor', { tag: ['@MCP-009'] }, async ({ anonApi }) => {
    const response = await anonApi.request.get('/.well-known/oauth-protected-resource/mcp')
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({ resource_name: 'scantor' })
  })
})

test.describe('MCP OAuth clients', () => {
  test('dynamic registration rejects redirect URIs outside the policy with 400 invalid_redirect_uri', { tag: ['@MCP-010'] }, async ({ anonApi }) => {
    const rejected = [
      'https://evil.example.com/callback',
      'javascript:alert(1)',
      'data:text/html,hello',
      'file:///etc/passwd',
      'ws://127.0.0.1:53682/callback',
      'wss://127.0.0.1:53682/callback',
      'http://127.0.0.1:53682/callback#fragment',
      'http://user:secret@127.0.0.1:53682/callback',
    ]
    for (const uri of rejected) {
      // A disallowed URI next to an allowed one still rejects the whole registration.
      const response = await register(anonApi.request, [REDIRECT_URI, uri])
      expect(response.status(), uri).toBe(400)
      expect(((await response.json()) as { error?: string }).error, uri).toBe('invalid_redirect_uri')
    }
  })

  test('dynamic registration accepts loopback redirect URIs on any port and private-use schemes', { tag: ['@MCP-010'] }, async ({ anonApi }) => {
    const allowed = [
      'http://127.0.0.1:61234/callback',
      'http://localhost:8080/oauth/callback',
      'http://[::1]:9999/callback',
      'cursor://anysphere.cursor-mcp/oauth/callback',
    ]
    const response = await register(anonApi.request, allowed)
    expect(response.status(), await response.text()).toBe(201)
    const client = (await response.json()) as { client_id?: string; redirect_uris?: string[] }
    expect(client.client_id).toEqual(expect.any(String))
    expect(client.redirect_uris).toEqual(allowed)
  })

  // product bug: https loopback redirect URIs are rejected at registration
  test.fail(
    'dynamic registration accepts https loopback redirect URIs',
    {
      tag: ['@MCP-010'],
      annotation: { type: 'issue', description: 'better-auth refuses https loopback redirect URIs for native and web clients (invalid_redirect_uri)' },
    },
    async ({ anonApi }) => {
      for (const uri of ['https://localhost:8443/cb', 'https://127.0.0.1:8443/cb']) {
        const response = await register(anonApi.request, [uri])
        expect(response.status(), `${uri}: ${await response.text()}`).toBe(201)
      }
    },
  )

  test('authorization enforces the redirect policy again and never redirects to a foreign URI', { tag: ['@MCP-010'] }, async ({ env, user }) => {
    const client = await workerOAuthClient()
    await withSession(user.storageState, async (session) => {
      const url = authorizationUrl({
        clientId: client.client_id,
        scope: DEFAULT_MCP_SCOPES,
        challenge: pkce().challenge,
        redirectUri: 'https://evil.example.com/callback',
      })
      // The authorization fails on the issuer's own error page: no consent, no redirect to the foreign URI.
      const response = await authorizeRequest(session, url)
      expect(response.status()).toBe(302)
      const location = new URL(response.headers()['location'] ?? '', url)
      expect(location.origin).toBe(env.publicUrl)
      expect(location.pathname).toBe('/api/auth/error')
      expect(location.searchParams.get('error')).toBe('invalid_redirect')
    })
  })

  test('a CIMD client_id that is not https or whose host is private is refused', { tag: ['@MCP-011'] }, async ({ env, user }) => {
    await withSession(user.storageState, async (session) => {
      const { challenge } = pkce()
      // https metadata URLs on private or loopback hosts: refused before any fetch.
      for (const clientId of [`https://fixtures.${env.domain}/client.json`, 'https://127.0.0.1/client.json']) {
        const response = await authorizeRequest(session, authorizationUrl({ clientId, scope: DEFAULT_MCP_SCOPES, challenge }))
        expect(response.status(), clientId).toBe(400)
        expect(await response.json(), clientId).toMatchObject({ error: 'invalid_client', error_description: expect.stringMatching(/private or reserved/) })
      }
      // An http URL is no metadata document: it is an unknown client id, refused with invalid_client.
      const plain = await authorizeRequest(
        session,
        authorizationUrl({ clientId: `http://fixtures.${env.domain}:8089/client.json`, scope: DEFAULT_MCP_SCOPES, challenge }),
      )
      const location = new URL(plain.headers()['location'] ?? '/', env.publicUrl)
      expect(plain.status()).toBe(302)
      expect(location.origin).toBe(env.publicUrl)
      expect(location.pathname).not.toBe(CONSENT_PATH)
      expect(location.searchParams.get('error')).toBe('invalid_client')
    })
  })
})

test.describe('MCP OAuth authorization', () => {
  test('the PKCE code flow issues a one-hour JWT for /mcp and a rotating refresh token that works', { tag: ['@MCP-012'] }, async ({ env, user }) => {
    await withSession(user.storageState, async (session) => {
      const { client, tokens } = await authorize(session, { scope: DEFAULT_MCP_SCOPES })
      const claims = jwtClaims(tokens.access_token)
      expect(claims.iss).toBe(`${env.publicUrl}/api/auth`)
      expect([claims.aud].flat()).toContain(env.mcpUrl)
      expect(claims.sub).toBe(user.id)
      expect(claims.client_id ?? claims.azp).toBe(client.client_id)
      expect(Number(claims.exp) - Number(claims.iat)).toBe(3600)
      expect(scopesOf(tokens.access_token)).toEqual(['offline_access', 'scantor:read', 'scantor:write'])
      expect(await toolNames(tokens.access_token)).toContain('start_scan')

      expect(tokens.refresh_token).toEqual(expect.any(String))
      const refreshed = await refreshTokens(session, client.client_id, tokens.refresh_token!)
      expect(refreshed.refresh_token).toEqual(expect.any(String))
      expect(refreshed.refresh_token).not.toBe(tokens.refresh_token)
      expect(refreshed.access_token).not.toBe(tokens.access_token)
      expect(await toolNames(refreshed.access_token)).toContain('start_scan')

      // PKCE is bound: a code redeemed with another verifier is refused.
      const { verifier: _verifier, challenge } = pkce()
      const consentUrl = await authorizeRedirect(
        session,
        authorizationUrl({ clientId: client.client_id, scope: DEFAULT_MCP_SCOPES, challenge, prompt: 'consent' }),
      )
      const callback = await consentRedirect(await postConsent(session, consentUrl, { accept: true, scope: DEFAULT_MCP_SCOPES }))
      const wrong = await tokenRequest(session, {
        grant_type: 'authorization_code',
        code: callback.searchParams.get('code') ?? '',
        redirect_uri: REDIRECT_URI,
        client_id: client.client_id,
        code_verifier: pkce().verifier,
      })
      expect(wrong.status()).toBe(400)
    })
  })

  test('a token without any scantor scope gets 403 insufficient_scope', { tag: ['@MCP-012'] }, async ({ user }) => {
    await withSession(user.storageState, async (session) => {
      const { tokens } = await authorize(session, { scope: 'openid offline_access', consentScope: 'openid offline_access' })
      const response = await rawMcp(session, { Authorization: `Bearer ${tokens.access_token}` })
      expect(response.status).toBe(403)
      expect(bearerChallenge(response.headers['www-authenticate']).error).toBe('insufficient_scope')
    })
  })

  test(
    'consent decides the level: scope is required, admin is stripped for users, Read only grants read, Deny returns access_denied',
    { tag: ['@MCP-013', '@MCP-002'] },
    async ({ user }) => {
      const client = await workerOAuthClient()
      await withSession(user.storageState, async (session) => {
        const start = async (scope: string) =>
          authorizeRedirect(session, authorizationUrl({ clientId: client.client_id, scope, challenge: pkce().challenge, prompt: 'consent' }))

        // Accepting without a scope is refused.
        const withoutScope = await postConsent(session, await start(ADMIN_MCP_SCOPES), { accept: true })
        expect(withoutScope.status()).toBe(400)
        expect(((await withoutScope.json()) as { error?: string }).error).toBe('invalid_request')

        // A user approving the admin scope gets a write token: scantor:admin is stripped.
        const stripped = await authorize(session, { client, scope: ADMIN_MCP_SCOPES, consentScope: ADMIN_MCP_SCOPES })
        expect(scopesOf(stripped.tokens.access_token)).not.toContain('scantor:admin')
        const writeTools = await toolNames(stripped.tokens.access_token)
        expect(writeTools).toContain('start_scan')
        expect(writeTools).not.toContain('list_nodes')

        // "Read only": only scantor:read, only read tools.
        const readOnly = await authorize(session, { client, scope: ADMIN_MCP_SCOPES, consentScope: 'offline_access scantor:read' })
        expect(scopesOf(readOnly.tokens.access_token)).toEqual(['offline_access', 'scantor:read'])
        const readTools = await toolNames(readOnly.tokens.access_token)
        expect(readTools).toContain('get_scan')
        expect(readTools).not.toContain('start_scan')

        // Deny: the client gets access_denied.
        const denied = await consentRedirect(await postConsent(session, await start(DEFAULT_MCP_SCOPES), { accept: false }))
        expect(denied.searchParams.get('error')).toBe('access_denied')
        expect(denied.searchParams.get('code')).toBeNull()
      })
    },
  )

  test('an admin who approves Admin gets the admin tool, and Read and write keeps it hidden', { tag: ['@MCP-013', '@MCP-002'] }, async ({ env, adminApi }) => {
    const client = await workerOAuthClient()
    try {
      await withSession(env.paths.adminState, async (session) => {
        const admin = await authorize(session, { client, scope: ADMIN_MCP_SCOPES, consentScope: ADMIN_MCP_SCOPES })
        expect(scopesOf(admin.tokens.access_token)).toContain('scantor:admin')
        expect(await toolNames(admin.tokens.access_token)).toContain('list_nodes')

        const write = await authorize(session, { client, scope: ADMIN_MCP_SCOPES, consentScope: DEFAULT_MCP_SCOPES })
        expect(await toolNames(write.tokens.access_token)).not.toContain('list_nodes')
      })
    } finally {
      // The consent belongs to the shared admin: remove it again.
      const revoked = await adminApi.call('revokeOAuthApp', { path: { clientId: client.client_id } })
      expect([204, 404]).toContain(revoked.status)
    }
  })
})

test.describe('MCP OAuth revocation', () => {
  test(
    'the authorized-apps list has the documented shape, and revoking a client never authorized is 404',
    { tag: ['@ACCT-006', '@ACCT-007'] },
    async ({ api }) => {
      const apps = ok(await api.call<{ items: OAuthApp[] }>('listOAuthApps'), 'listOAuthApps')
      expect(Array.isArray(apps.items)).toBe(true)
      const neverAuthorized = await api.call('revokeOAuthApp', { path: { clientId: unique('never-authorized') } })
      expect(neverAuthorized.status).toBe(404)
      expect(neverAuthorized.body).toMatchObject({ error: { code: 'notFound' } })
    },
  )

  test(
    'revoking an app lists it no longer and its next /mcp call gets 401 Access revoked',
    { tag: ['@ACCT-006', '@ACCT-007', '@MCP-014'] },
    async ({ user, openapi }) => {
      // A client of this test's own: the tenant's consent to it concerns no other test.
      const name = unique('mcp-revoke')
      const client = await registerTestClient(name)
      await withSession(user.storageState, async (session) => {
        const { tokens } = await authorize(session, { client, scope: DEFAULT_MCP_SCOPES })
        expect(await toolNames(tokens.access_token)).toContain('get_scan')

        const api = new ApiClient(session, openapi)
        const before = ok(await api.call<{ items: OAuthApp[] }>('listOAuthApps'), 'listOAuthApps')
        expect(before.items.filter((app) => app.clientId === client.client_id)).toEqual([
          {
            clientId: client.client_id,
            name,
            uri: null,
            scopes: ['offline_access', 'scantor:read', 'scantor:write'],
            createdAt: expect.any(String),
          },
        ])
        expect(Date.now() - Date.parse(before.items.find((app) => app.clientId === client.client_id)!.createdAt)).toBeLessThan(120_000)

        expect((await api.call('revokeOAuthApp', { path: { clientId: client.client_id } })).status).toBe(204)
        const after = ok(await api.call<{ items: OAuthApp[] }>('listOAuthApps'), 'listOAuthApps')
        expect(after.items.map((app) => app.clientId)).not.toContain(client.client_id)

        const rejected = await rawMcp(session, { Authorization: `Bearer ${tokens.access_token}` })
        expect(rejected.status).toBe(401)
        expect((rejected.body?.error as { message?: string } | undefined)?.message).toMatch(/^Access revoked: /)
        expect(bearerChallenge(rejected.headers['www-authenticate']).error).toBe('invalid_token')
        // The refresh token was deleted with the consent.
        expect(
          (await tokenRequest(session, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token ?? '', client_id: client.client_id })).ok(),
        ).toBe(false)
        // A second revocation finds nothing.
        expect((await api.call('revokeOAuthApp', { path: { clientId: client.client_id } })).status).toBe(404)
      })
    },
  )

  test("a banned user's token gets 401 Access revoked on the next call", { tag: ['@MCP-014'] }, async ({ freshUserHandle, adminApi }) => {
    const client = await workerOAuthClient()
    const fresh = await freshUserHandle.get()
    await withSession(fresh.storageState, async (session) => {
      const { tokens } = await authorize(session, { client, scope: DEFAULT_MCP_SCOPES })
      expect((await rawMcp(session, { Authorization: `Bearer ${tokens.access_token}` })).status).toBe(200)
      ok(await adminApi.call('banUser', { path: { userId: fresh.id }, body: { reason: 'mcp revocation test' } }), 'banUser')
      const rejected = await rawMcp(session, { Authorization: `Bearer ${tokens.access_token}` })
      expect(rejected.status).toBe(401)
      expect((rejected.body?.error as { message?: string } | undefined)?.message).toMatch(/^Access revoked: /)
      expect(bearerChallenge(rejected.headers['www-authenticate']).error).toBe('invalid_token')
    })
  })

  test("a deleted user's token gets 401 Access revoked on the next call", { tag: ['@MCP-014'] }, async ({ freshUserHandle, adminApi }) => {
    const client = await workerOAuthClient()
    const fresh = await freshUserHandle.get()
    await withSession(fresh.storageState, async (session) => {
      const { tokens } = await authorize(session, { client, scope: DEFAULT_MCP_SCOPES })
      expect((await rawMcp(session, { Authorization: `Bearer ${tokens.access_token}` })).status).toBe(200)
      expect((await adminApi.deleteUser(fresh.id)).status).toBe(202)
      await expect.poll(async () => (await rawMcp(session, { Authorization: `Bearer ${tokens.access_token}` })).status, { timeout: 60_000 }).toBe(401)
      const rejected = await rawMcp(session, { Authorization: `Bearer ${tokens.access_token}` })
      expect((rejected.body?.error as { message?: string } | undefined)?.message).toMatch(/^Access revoked: /)
    })
  })
})
