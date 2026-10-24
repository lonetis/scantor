import { mcp } from '@better-auth/mcp'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { jwt } from 'better-auth/plugins'
import { beforeAll, describe, expect, it } from 'vitest'
import { isAllowedMcpRedirect, OAUTH_SCOPES } from '../../../server/utils/auth-policy'

// The redirect URI policy (docs/mcp.md §3.4) against what better-auth's oauth-provider itself registers. Regression:
// the policy allowed https loopback redirect URIs, but better-auth refuses them for every client type (a web client
// must not use a loopback host, a native client must use http on loopback, RFC 8252 §7.3, §8.3), so such a
// registration failed with better-auth's error instead. The policy now refuses them itself.

const ORIGIN = 'http://localhost:3000'

const db: Record<string, unknown[]> = {}
const auth = betterAuth({
  baseURL: ORIGIN,
  basePath: '/api/auth',
  secret: 'a-test-secret-that-is-long-enough-for-better-auth',
  database: memoryAdapter(db),
  telemetry: { enabled: false },
  logger: { disabled: true },
  plugins: [
    jwt(),
    mcp({
      resource: `${ORIGIN}/mcp`,
      loginPage: '/login',
      consentPage: '/oauth/consent',
      scopes: OAUTH_SCOPES,
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultApplicationType: 'infer',
    }),
  ],
})

/** Dynamic client registration as an MCP client sends it, straight to better-auth (without scantor's hook). */
async function register(redirectUri: string, applicationType?: 'web' | 'native'): Promise<{ status: number; error?: string }> {
  const response = await auth.handler(
    new Request(`${ORIGIN}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({
        client_name: 'policy test',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(applicationType ? { application_type: applicationType } : {}),
      }),
    }),
  )
  const body = (await response.json()) as { error?: string }
  return { status: response.status, error: body.error }
}

beforeAll(async () => {
  // The in-memory database needs a table per model of the configured plugins.
  const ctx = (await auth.$context) as { tables: Record<string, { modelName: string }> }
  for (const table of Object.values(ctx.tables)) db[table.modelName] ??= []
})

describe('MCP redirect policy and better-auth', () => {
  it.each(['https://localhost:8443/cb', 'https://127.0.0.1:8443/cb', 'https://[::1]:8443/cb'])(
    'refuses the https loopback URI %s, which better-auth refuses for every client type',
    async (uri) => {
      expect(isAllowedMcpRedirect(uri, [new URL(uri).origin])).toBe(false)
      for (const applicationType of [undefined, 'web', 'native'] as const) {
        expect(await register(uri, applicationType), `${uri} as ${applicationType ?? 'inferred'}`).toEqual({ status: 400, error: 'invalid_redirect_uri' })
      }
    },
  )

  it.each([
    'http://127.0.0.1:61234/callback',
    'http://localhost:8080/oauth/callback',
    'http://[::1]:9999/callback',
    'cursor://anysphere.cursor-mcp/oauth/callback',
  ])('allows %s, which better-auth registers', async (uri) => {
    expect(isAllowedMcpRedirect(uri, [])).toBe(true)
    expect((await register(uri)).status).toBe(201)
  })
})
