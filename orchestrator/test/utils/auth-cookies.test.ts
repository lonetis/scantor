import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Config } from '../../server/utils/config'

// The origin-bound settings of the better-auth instances (docs/auth.md §2.2, §3; security.md TUN-4) in the typical
// tunnel deployment: an http public URL on the internal network next to the https tunnel URL. Each instance derives
// its cookies, trusted origins, passkey relying party and MCP OAuth from its own origin, never from the public URL:
// the tunnel's session cookie is `__Secure-` and Secure, the public URL's is neither.

const db = vi.hoisted(
  () =>
    Object.fromEntries(
      [
        'user',
        'session',
        'account',
        'verification',
        'apikey',
        'passkey',
        'jwks',
        'oauthClient',
        'oauthResource',
        'oauthClientResource',
        'oauthRefreshToken',
        'oauthAccessToken',
        'oauthConsent',
        'oauthClientAssertion',
      ].map((model) => [model, [] as unknown[]]),
    ) as Record<string, unknown[]>,
)

vi.mock('better-auth/adapters/mongodb', async () => {
  const { memoryAdapter } = await import('better-auth/adapters/memory')
  return { mongodbAdapter: () => memoryAdapter(db) }
})
vi.mock('../../server/utils/mongo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/utils/mongo')>()),
  useMongo: () => ({ db: {}, client: {} }),
}))
vi.mock('../../server/utils/guide-assets', () => ({ readGuide: async () => null }))

const { useAuth } = await import('../../server/utils/auth')
const { resetBootRegistry, runBoot } = await import('../../server/utils/boot')
const { parseConfig, setConfigForTesting } = await import('../../server/utils/config')
const { useLogger } = await import('../../server/utils/logger')

const PUBLIC = 'http://10.0.0.5:3000'
const TUNNEL = 'https://tunnel.example.org'

interface AuthCookie {
  name: string
  attributes: { secure?: boolean; domain?: string; httpOnly?: boolean; sameSite?: string }
}

beforeAll(async () => {
  setConfigForTesting(parseConfig({ SCANTOR_PUBLIC_URL: PUBLIC, SCANTOR_EDITOR_URL: 'http://10.0.0.5:3001', SCANTOR_TUNNEL_URL: TUNNEL }).config)
  resetBootRegistry()
  await runBoot({ config: () => ({ components: [] }) as unknown as Config, log: useLogger('test') })
})

afterAll(() => {
  setConfigForTesting(null)
  resetBootRegistry()
})

async function contextOf(origin: 'public' | 'tunnel') {
  return (await useAuth(origin).$context) as {
    authCookies: { sessionToken: AuthCookie }
    trustedOrigins: string[]
    options: { plugins: { id: string; options?: Record<string, unknown> }[] }
  }
}

describe('an http public URL next to the https tunnel URL', () => {
  it('gives the tunnel instance a __Secure- host-only session cookie and the public instance a plain one', async () => {
    const tunnel = (await contextOf('tunnel')).authCookies.sessionToken
    expect(tunnel.name).toBe('__Secure-scantor.session_token')
    expect(tunnel.attributes).toMatchObject({ secure: true, httpOnly: true, sameSite: 'lax' })
    expect(tunnel.attributes.domain).toBeUndefined()
    const pub = (await contextOf('public')).authCookies.sessionToken
    expect(pub.name).toBe('scantor.session_token')
    expect(pub.attributes.secure).toBeFalsy()
    expect(pub.attributes.domain).toBeUndefined()
  })

  it('trusts each origin only on its own instance', async () => {
    expect((await contextOf('tunnel')).trustedOrigins).toContain(TUNNEL)
    expect((await contextOf('tunnel')).trustedOrigins).not.toContain(PUBLIC)
    expect((await contextOf('public')).trustedOrigins).toContain(PUBLIC)
    expect((await contextOf('public')).trustedOrigins).not.toContain(TUNNEL)
  })

  it('has passkeys and MCP OAuth only on the tunnel instance (an IP literal over http has neither)', async () => {
    const plugins = async (origin: 'public' | 'tunnel') => (await contextOf(origin)).options.plugins.map((plugin) => plugin.id)
    expect(await plugins('tunnel')).toEqual(expect.arrayContaining(['passkey', 'jwt', 'oauth-provider']))
    expect(await plugins('public')).not.toContain('passkey')
    expect(await plugins('public')).not.toContain('jwt')
    const passkey = (await contextOf('tunnel')).options.plugins.find((plugin) => plugin.id === 'passkey')
    expect(passkey?.options).toMatchObject({ rpID: 'tunnel.example.org', origin: TUNNEL })
  })
})
