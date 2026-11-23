import type { APIRequestContext, APIResponse } from '@playwright/test'
import { connectMcpWithKey, DEFAULT_MCP_SCOPES, REDIRECT_URI } from '../helpers/mcp'
import {
  authorizationUrl,
  authorize,
  authorizeRequest,
  bearerChallenge,
  connectMcpPatiently,
  jwtClaims,
  pkce,
  rawMcp,
  tokenRequest,
  workerOAuthClient,
} from '../helpers/mcp-oauth'
import { withMcpTenants } from '../helpers/mcp-tenant'
import { newTunnelContext, tunnelSession } from '../helpers/tunnel'
import { newApiContext } from '../helpers/users'
import { expect, test as base } from '../fixtures'

// The MCP server through the Cloudflare Tunnel (docs/mcp.md §3, docs/auth.md §2.2, security.md TUN-4): the test stack's
// stand-in tunnel serves the tunnel URL (docs/testing.md §7.3). Each origin has its own OAuth issuer and `/mcp`
// resource, so discovery names the origin it was asked on and a token works only on the `/mcp` it was issued for;
// clients and consents are shared, API keys work on both. Authorize and token requests go through the OAuth budget of
// helpers/mcp-limiter.ts (better-auth's per-IP limits are shared by the origins).

const test = withMcpTenants(base)

/** Runs `use` with a context, disposed afterwards. */
async function withContext<T>(context: Promise<APIRequestContext>, use: (context: APIRequestContext) => Promise<T>): Promise<T> {
  const created = await context
  try {
    return await use(created)
  } finally {
    await created.dispose()
  }
}

async function expectInvalidTarget(response: APIResponse, label: string): Promise<void> {
  const text = await response.text()
  expect(response.status(), `${label}: ${text}`).toBe(400)
  expect(response.headers()['location'], label).toBeUndefined()
  expect(text, label).toContain('invalid_target')
}

test.describe('MCP through the tunnel URL', () => {
  test('discovery and the /mcp challenge name the tunnel URL', { tag: ['@TUNNEL-009'] }, async ({ env }) => {
    await withContext(newTunnelContext(), async (tunnel) => {
      const challenged = await rawMcp(tunnel, {}, undefined, env.tunnelMcpUrl)
      expect(challenged.status).toBe(401)
      expect(bearerChallenge(challenged.headers['www-authenticate'])).toMatchObject({
        resource_metadata: `${env.tunnelUrl}/.well-known/oauth-protected-resource/mcp`,
        scope: 'offline_access scantor:read scantor:write scantor:admin',
      })

      const resource = await tunnel.get('/.well-known/oauth-protected-resource/mcp')
      expect(resource.status()).toBe(200)
      expect(await resource.json()).toMatchObject({
        resource: env.tunnelMcpUrl,
        authorization_servers: [`${env.tunnelUrl}/api/auth`],
        resource_name: 'scantor',
      })

      const server = await tunnel.get('/.well-known/oauth-authorization-server/api/auth')
      expect(server.status()).toBe(200)
      expect(await server.json()).toMatchObject({
        issuer: `${env.tunnelUrl}/api/auth`,
        authorization_endpoint: `${env.tunnelUrl}/api/auth/oauth2/authorize`,
        token_endpoint: `${env.tunnelUrl}/api/auth/oauth2/token`,
        registration_endpoint: `${env.tunnelUrl}/api/auth/oauth2/register`,
        jwks_uri: `${env.tunnelUrl}/api/auth/jwks`,
      })

      const openid = await tunnel.get('/api/auth/.well-known/openid-configuration')
      expect(openid.status()).toBe(200)
      expect(await openid.json()).toMatchObject({ issuer: `${env.tunnelUrl}/api/auth`, jwks_uri: `${env.tunnelUrl}/api/auth/jwks` })

      // The setup status of the tunnel URL names its MCP URL too.
      const setup = await tunnel.get('/api/setup/status')
      expect(await setup.json()).toMatchObject({ needsSetup: false, mcpUrl: env.tunnelMcpUrl })
    })

    // The public URL keeps its own issuer and resource.
    await withContext(newApiContext(), async (anonymous) => {
      const resource = await anonymous.get('/.well-known/oauth-protected-resource/mcp')
      expect(await resource.json()).toMatchObject({ resource: env.mcpUrl, authorization_servers: [`${env.publicUrl}/api/auth`] })
      const challenged = await rawMcp(anonymous, {})
      expect(bearerChallenge(challenged.headers['www-authenticate']).resource_metadata).toBe(`${env.publicUrl}/.well-known/oauth-protected-resource/mcp`)
    })
  })

  test('an MCP client connects through the tunnel URL, and each origin refuses the other origin’s token', { tag: ['@TUNNEL-010'] }, async ({ env, user }) => {
    test.setTimeout(240_000)
    const client = await workerOAuthClient()
    const tunnel = await tunnelSession(user.email, user.password)
    const publicSession = await newApiContext({ storageState: user.storageState })
    try {
      // The SDK's flow through the tunnel: challenge, discovery, authorize and consent with the tunnel session, token.
      const connection = await connectMcpPatiently(tunnel, { client, mcpUrl: env.tunnelMcpUrl })
      const tunnelToken = connection.accessToken
      try {
        const claims = jwtClaims(tunnelToken)
        expect(claims.iss).toBe(`${env.tunnelUrl}/api/auth`)
        expect([claims.aud].flat()).toContain(env.tunnelMcpUrl)
        expect([claims.aud].flat()).not.toContain(env.mcpUrl)
        expect(claims.sub).toBe(user.id)
        expect((await connection.client.listTools()).tools.map((tool) => tool.name)).toContain('start_scan')
      } finally {
        await connection.close()
      }
      expect((await rawMcp(tunnel, { Authorization: `Bearer ${tunnelToken}` }, undefined, env.tunnelMcpUrl)).status).toBe(200)
      // A tunnel token on the public /mcp: 401 with the public challenge.
      const crossed = await rawMcp(publicSession, { Authorization: `Bearer ${tunnelToken}` })
      expect(crossed.status).toBe(401)
      expect(bearerChallenge(crossed.headers['www-authenticate']).resource_metadata).toBe(`${env.publicUrl}/.well-known/oauth-protected-resource/mcp`)

      // A token of the public URL works there and gets 401 on the tunnel's /mcp.
      const { tokens } = await authorize(publicSession, { client })
      const publicClaims = jwtClaims(tokens.access_token)
      expect(publicClaims.iss).toBe(`${env.publicUrl}/api/auth`)
      expect([publicClaims.aud].flat()).toContain(env.mcpUrl)
      expect((await rawMcp(publicSession, { Authorization: `Bearer ${tokens.access_token}` })).status).toBe(200)
      expect((await rawMcp(tunnel, { Authorization: `Bearer ${tokens.access_token}` }, undefined, env.tunnelMcpUrl)).status).toBe(401)

      // The manual PKCE flow on the tunnel origin yields the same binding.
      const manual = await authorize(tunnel, { client, origin: env.tunnelUrl, scope: DEFAULT_MCP_SCOPES })
      expect(jwtClaims(manual.tokens.access_token).iss).toBe(`${env.tunnelUrl}/api/auth`)
      expect([jwtClaims(manual.tokens.access_token).aud].flat()).toContain(env.tunnelMcpUrl)
    } finally {
      await tunnel.dispose()
      await publicSession.dispose()
    }
  })

  test('authorize and token requests that name the other origin’s resource get 400 invalid_target', { tag: ['@TUNNEL-010'] }, async ({ env, user }) => {
    const client = await workerOAuthClient()
    const tunnel = await tunnelSession(user.email, user.password)
    const publicSession = await newApiContext({ storageState: user.storageState })
    try {
      // Refused before the client and redirect URI are looked at: a JSON 400, never a redirect to the client.
      const { challenge } = pkce()
      const foreignAuthorize = authorizationUrl({
        clientId: client.client_id,
        scope: DEFAULT_MCP_SCOPES,
        challenge,
        origin: env.tunnelUrl,
        resource: env.mcpUrl,
      })
      await expectInvalidTarget(await authorizeRequest(tunnel, foreignAuthorize), 'authorize through the tunnel for the public resource')
      const crossAuthorize = authorizationUrl({ clientId: client.client_id, scope: DEFAULT_MCP_SCOPES, challenge, resource: env.tunnelMcpUrl })
      await expectInvalidTarget(await authorizeRequest(publicSession, crossAuthorize), 'authorize on the public URL for the tunnel resource')

      const form = {
        grant_type: 'authorization_code',
        code: 'not-a-code',
        redirect_uri: REDIRECT_URI,
        client_id: client.client_id,
        code_verifier: pkce().verifier,
      }
      await expectInvalidTarget(
        await tokenRequest(tunnel, { ...form, resource: env.mcpUrl }, env.tunnelUrl),
        'token through the tunnel for the public resource',
      )
      await expectInvalidTarget(await tokenRequest(publicSession, { ...form, resource: env.tunnelMcpUrl }), 'token on the public URL for the tunnel resource')
    } finally {
      await tunnel.dispose()
      await publicSession.dispose()
    }
  })

  test('an API key works on the /mcp of both origins', { tag: ['@TUNNEL-010'] }, async ({ env, user }) => {
    for (const mcpUrl of [env.tunnelMcpUrl, env.mcpUrl]) {
      const client = await connectMcpWithKey(user.apiKey, mcpUrl)
      try {
        expect(
          (await client.listTools()).tools.map((tool) => tool.name),
          mcpUrl,
        ).toContain('start_scan')
      } finally {
        await client.close()
      }
    }
  })
})
