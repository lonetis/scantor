import { mcp } from '@better-auth/mcp'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { jwt } from 'better-auth/plugins'
import { describe, expect, it } from 'vitest'
import { isProtectedResourceMetadataPath, MCP_RESOURCE_NAME, toBetterAuthDiscoveryRequest, withResourceName } from '../../../server/services/mcp/discovery'
import { OAUTH_SCOPES } from '../../../server/utils/auth-policy'

// Root discovery documents (docs/mcp.md §3.1): OpenID metadata with path insertion and the RFC 9728 resource name.

const ORIGIN = 'http://localhost:3000'
const BASE_PATH = '/api/auth'

describe('toBetterAuthDiscoveryRequest', () => {
  it('maps the OpenID path insertion onto the issuer-appended document', () => {
    const mapped = toBetterAuthDiscoveryRequest(new Request(`${ORIGIN}/.well-known/openid-configuration/api/auth?x=1`), BASE_PATH)
    expect(new URL(mapped.url).pathname).toBe('/api/auth/.well-known/openid-configuration')
    expect(new URL(mapped.url).search).toBe('?x=1')
    expect(mapped.method).toBe('GET')
    expect(toBetterAuthDiscoveryRequest(new Request(`${ORIGIN}/.well-known/openid-configuration/api/auth`, { method: 'HEAD' }), BASE_PATH).method).toBe('HEAD')
  })

  it('leaves every other request alone', () => {
    for (const request of [
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server/api/auth`),
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`),
      new Request(`${ORIGIN}/.well-known/openid-configuration/api/authx`),
      new Request(`${ORIGIN}/.well-known/openid-configuration/api/auth`, { method: 'POST', body: '{}' }),
    ]) {
      expect(toBetterAuthDiscoveryRequest(request, BASE_PATH)).toBe(request)
    }
  })
})

describe('withResourceName', () => {
  it('names the resource in a metadata document', async () => {
    const response = await withResourceName(Response.json({ resource: `${ORIGIN}/mcp` }, { headers: { 'cache-control': 'public, max-age=60' } }))
    expect(await response.json()).toEqual({ resource: `${ORIGIN}/mcp`, resource_name: MCP_RESOURCE_NAME })
    expect(response.headers.get('cache-control')).toBe('public, max-age=60')
  })

  it('passes errors and bodiless responses through', async () => {
    const missing = Response.json({ error: 'not found' }, { status: 404 })
    expect(await withResourceName(missing)).toBe(missing)
    const head = new Response(null, { status: 200, headers: { 'content-type': 'application/json' } })
    expect(await withResourceName(head)).toBe(head)
  })

  it('recognises the protected-resource metadata paths', () => {
    expect(isProtectedResourceMetadataPath('/.well-known/oauth-protected-resource/mcp')).toBe(true)
    expect(isProtectedResourceMetadataPath('/.well-known/oauth-protected-resource')).toBe(true)
    expect(isProtectedResourceMetadataPath('/.well-known/oauth-protected-resourcex')).toBe(false)
    expect(isProtectedResourceMetadataPath('/.well-known/openid-configuration/api/auth')).toBe(false)
  })
})

describe('discovery through better-auth', () => {
  // better-auth with the MCP provider as server/utils/auth.ts configures it, on an in-memory database.
  const auth = betterAuth({
    baseURL: ORIGIN,
    basePath: BASE_PATH,
    secret: 'a-test-secret-that-is-long-enough-for-better-auth',
    database: memoryAdapter({}),
    telemetry: { enabled: false },
    logger: { disabled: true },
    plugins: [jwt(), mcp({ resource: `${ORIGIN}/mcp`, loginPage: '/login', consentPage: '/oauth/consent', scopes: OAUTH_SCOPES })],
  })
  const discover = async (path: string) => {
    const request = new Request(`${ORIGIN}${path}`)
    const response = await auth.handler(toBetterAuthDiscoveryRequest(request, auth.options.basePath!))
    return isProtectedResourceMetadataPath(new URL(request.url).pathname) ? withResourceName(response) : response
  }

  it('serves the OpenID metadata at the path-insertion URL, which better-auth alone answers 404', async () => {
    expect((await auth.handler(new Request(`${ORIGIN}/.well-known/openid-configuration/api/auth`))).status).toBe(404)
    const response = await discover('/.well-known/openid-configuration/api/auth')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ issuer: `${ORIGIN}/api/auth`, jwks_uri: `${ORIGIN}/api/auth/jwks` })
  })

  it('names the resource scantor in the protected-resource metadata', async () => {
    const response = await discover('/.well-known/oauth-protected-resource/mcp')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [`${ORIGIN}/api/auth`], resource_name: 'scantor' })
  })
})
