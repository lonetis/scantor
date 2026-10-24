import type { Health } from '#shared/types/instance'
import { ok } from '../helpers/api-client'
import { jwtLikeToken, unknownApiKey, withAuthTenants } from '../helpers/api-auth'
import { expect, test as base } from '../fixtures'

const test = withAuthTenants(base)

// Public instance endpoints (docs/api.md §4.1, §4.2): the health report and the setup status need no credentials
// and never validate the ones a client sends. The zero-user side of the setup status runs against a throwaway
// orchestrator in security/setup-token.spec.ts.

/** Credentials that would be rejected on any user route; public routes must ignore them. */
const BOGUS_CREDENTIALS: Record<string, string>[] = [
  { Authorization: `Bearer ${unknownApiKey()}` },
  { 'x-api-key': unknownApiKey() },
  { Authorization: `Bearer ${jwtLikeToken()}` },
  { Cookie: '__Secure-scantor.session_token=forged.value' },
]

test.describe('health', () => {
  test('GET /api/health needs no credentials and reports every component', { tag: ['@PLAT-001'] }, async ({ anonApi }) => {
    const response = await anonApi.getHealth()
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toMatch(/^application\/json/)
    expect(response.headers['cache-control']).toBe('no-store')
    const health = response.body
    expect(Object.keys(health).sort()).toEqual(['alarms', 'components', 'status', 'version'])
    expect(Object.keys(health.components).sort()).toEqual(['mongo', 'rabbitmq', 'registry', 's3'])
    for (const [component, state] of Object.entries(health.components)) expect(['ok', 'down'], component).toContain(state)
    expect(Array.isArray(health.alarms)).toBe(true)
    expect(health.version).toEqual(expect.any(String))
    expect(health.version.length).toBeGreaterThan(0)
    // The overall status is a pure function of the components and the RabbitMQ alarms.
    const allOk = Object.values(health.components).every((state) => state === 'ok') && health.alarms.length === 0
    expect(health.status).toBe(allOk ? 'ok' : 'degraded')
    // The test stack is healthy.
    expect(health.status).toBe('ok')
    expect(health.alarms).toEqual([])
  })

  test('the health report ignores credentials and agrees with the instance version', { tag: ['@PLAT-001'] }, async ({ anonApi, api }) => {
    for (const headers of BOGUS_CREDENTIALS) {
      const response = await anonApi.call<Health>('getHealth', { headers })
      expect(response.status, JSON.stringify(Object.keys(headers))).toBe(200)
      expect(response.body.status).toBe('ok')
    }
    const health = ok(await anonApi.getHealth(), 'getHealth')
    expect(ok(await api.getInstanceInfo(), 'getInstanceInfo').version).toBe(health.version)
  })
})

test.describe('setup status', () => {
  test('GET /api/setup/status is public and reports a completed setup', { tag: ['@SETUP-001'] }, async ({ anonApi, env }) => {
    const response = await anonApi.call<{ needsSetup: boolean; passkeysEnabled: boolean; mcpUrl: string | null }>('getSetupStatus')
    expect(response.status).toBe(200)
    // Users exist on the test stack (the seeded admin), so setup is complete; passkeys work on its https origin.
    expect(response.body).toEqual({ needsSetup: false, passkeysEnabled: true, mcpUrl: env.mcpUrl })
    for (const headers of BOGUS_CREDENTIALS) {
      const again = await anonApi.call('getSetupStatus', { headers })
      expect(again.status, JSON.stringify(Object.keys(headers))).toBe(200)
      expect(again.body).toEqual(response.body)
    }
  })

  test('the setup mutations stay closed once a user exists', { tag: ['@SETUP-001'] }, async ({ anonApi }) => {
    // needsSetup is false, so the setup routes refuse before looking at any token.
    const admin = await anonApi.call('createSetupAdmin', {
      body: { email: 'nobody@scantor.test', name: 'nobody', password: 'a-long-password' },
      headers: { 'X-Scantor-Setup-Token': `sst_${'A'.repeat(43)}` },
    })
    expect(admin.status).toBe(409)
    expect((admin.body as { error: { code: string } }).error.code).toBe('setupCompleted')
    const passkey = await anonApi.call('createSetupPasskeyToken', { body: { email: 'nobody@scantor.test', name: 'nobody' } })
    expect(passkey.status).toBe(409)
    expect((passkey.body as { error: { code: string } }).error.code).toBe('setupCompleted')
  })
})
