import { describe, expect, it } from 'vitest'
import { mintToolsJwt } from '../../../server/services/tools/cookie'
import { decideForwardAuth, type ForwardAuthDeps, toolTargetOfHost } from '../../../server/services/tools/forward-auth'
import { createKeyring } from '../../../server/utils/keys'
import type { CachedUser } from '../../../server/utils/user-cache'

// Traefik forwardAuth decisions for the admin GUIs (docs/auth.md §11, docs/api.md §4.18, security.md GUI-1).

const ADMIN_ID = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const USER_ID = '1b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const DOMAIN = 'scantor.example'
const keyring = createKeyring('forward auth test secret')
const sign = (input: string) => keyring.toolsCookieSignature(input)

function cachedUser(id: string, overrides: Partial<CachedUser> = {}): CachedUser {
  return { id, email: `${id}@example.com`, name: 'x', role: 'admin', banned: false, banExpires: null, canRunPrivileged: false, maxWorkers: 0, ...overrides }
}

function deps(users: Record<string, CachedUser> = { [ADMIN_ID]: cachedUser(ADMIN_ID) }, overrides: Partial<ForwardAuthDeps> = {}): ForwardAuthDeps {
  return {
    publicUrl: `https://${DOMAIN}`,
    domain: DOMAIN,
    sign,
    getUser: async (id) => users[id] ?? null,
    isBanned: (user) => user.banned,
    ...overrides,
  }
}

const cookieOf = (userId: string, nowMs = Date.now()) => `scantor_tools=${mintToolsJwt(userId, sign, { nowMs }).token}`
const html = 'text/html,application/xhtml+xml,*/*;q=0.8'

describe('toolTargetOfHost', () => {
  it('maps exactly the four tool hosts', () => {
    expect(toolTargetOfHost('rabbitmq.scantor.example', DOMAIN)).toBe('rabbitmq')
    expect(toolTargetOfHost('mongo-express.scantor.example', DOMAIN)).toBe('mongo-express')
    expect(toolTargetOfHost('RUSTFS.Scantor.Example:443', DOMAIN)).toBe('rustfs')
    expect(toolTargetOfHost('traefik.scantor.example:8443', DOMAIN)).toBe('traefik')
    for (const host of ['scantor.example', 'editor.scantor.example', 's3.scantor.example', 'rabbitmq.evil.example', 'x.rabbitmq.scantor.example', 'rabbitmq.scantor.example.evil', 'rabbitmq.scantor.example, traefik.scantor.example', '']) {
      expect(toolTargetOfHost(host, DOMAIN), host).toBeNull()
    }
    expect(toolTargetOfHost('rabbitmq.scantor.example', null)).toBeNull()
    expect(toolTargetOfHost(undefined, DOMAIN)).toBeNull()
  })
})

describe('decideForwardAuth', () => {
  it('allows an active admin with a valid cookie', async () => {
    expect(await decideForwardAuth({ forwardedHost: 'rabbitmq.scantor.example', accept: '*/*', cookie: cookieOf(ADMIN_ID) }, deps())).toEqual({
      kind: 'allow',
      userId: ADMIN_ID,
      target: 'rabbitmq',
    })
  })

  it('denies any other forwarded host, even with a valid cookie and a browser Accept', async () => {
    for (const forwardedHost of ['editor.scantor.example', 'evil.example', undefined]) {
      expect(await decideForwardAuth({ forwardedHost, accept: html, cookie: cookieOf(ADMIN_ID) }, deps())).toMatchObject({ kind: 'deny' })
    }
  })

  it('redirects browsers without a valid cookie to createToolsSession for the tool', async () => {
    const decision = await decideForwardAuth({ forwardedHost: 'rustfs.scantor.example', accept: html, cookie: undefined }, deps())
    expect(decision).toEqual({ kind: 'redirect', location: 'https://scantor.example/api/tools/session?target=rustfs', target: 'rustfs' })
  })

  it('answers 401 to non-browser requests without a valid cookie', async () => {
    const decision = await decideForwardAuth({ forwardedHost: 'traefik.scantor.example', accept: 'application/json', cookie: 'scantor_tools=garbage' }, deps())
    expect(decision).toMatchObject({ kind: 'deny' })
  })

  it('rejects expired cookies, demoted, banned and deleted users', async () => {
    const request = (cookie: string) => ({ forwardedHost: 'mongo-express.scantor.example', accept: 'application/json', cookie })
    const expired = cookieOf(ADMIN_ID, Date.now() - 9 * 3_600_000)
    expect(await decideForwardAuth(request(expired), deps())).toMatchObject({ kind: 'deny' })
    expect(await decideForwardAuth(request(cookieOf(ADMIN_ID)), deps({ [ADMIN_ID]: cachedUser(ADMIN_ID, { role: 'user' }) }))).toMatchObject({ kind: 'deny' })
    expect(await decideForwardAuth(request(cookieOf(ADMIN_ID)), deps({ [ADMIN_ID]: cachedUser(ADMIN_ID, { banned: true }) }))).toMatchObject({ kind: 'deny' })
    expect(await decideForwardAuth(request(cookieOf(ADMIN_ID)), deps({}))).toMatchObject({ kind: 'deny' })
    expect(await decideForwardAuth(request(cookieOf(USER_ID)), deps({ [USER_ID]: cachedUser(USER_ID, { role: 'user' }) }))).toMatchObject({ kind: 'deny' })
  })

  it('rejects cookies signed with another secret', async () => {
    const foreign = createKeyring('other secret')
    const token = mintToolsJwt(ADMIN_ID, (input) => foreign.toolsCookieSignature(input)).token
    const decision = await decideForwardAuth({ forwardedHost: 'rabbitmq.scantor.example', accept: '*/*', cookie: `scantor_tools=${token}` }, deps())
    expect(decision).toMatchObject({ kind: 'deny' })
  })

  it('uses any valid cookie when several are sent', async () => {
    const decision = await decideForwardAuth(
      { forwardedHost: 'rabbitmq.scantor.example', accept: '*/*', cookie: `scantor_tools=junk; ${cookieOf(ADMIN_ID)}` },
      deps(),
    )
    expect(decision).toMatchObject({ kind: 'allow' })
  })
})
