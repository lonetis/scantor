import { randomBytes } from 'node:crypto'
import type { APIRequestContext, APIResponse } from '@playwright/test'
import { ThrowawayOrchestrator } from '../helpers/orchestrator'
import { withSecurityTenants } from '../helpers/security-tenants'
import { expect, test as base } from '../fixtures'

// The fixtures of the security specs (helpers/security-tenants.ts): `throwawayInfra` for the throwaway orchestrators.
const test = withSecurityTenants(base)

// Per-IP auth rate limits (docs/auth.md §2.7, §4.3; security.md AUTH-6) against throwaway orchestrators, so the
// shared stack's sign-in budget (helpers/limiter.ts) is untouched. better-auth keys its in-memory limiter by
// `<client IP>|<path>` with the client IP that scantor computes itself: the socket peer, or the rightmost
// X-Forwarded-For entry only with SCANTOR_TRUST_PROXY=true.

const password = () => randomBytes(18).toString('base64url')

/** Sends `count` requests one after the other (each with a different spoofed X-Forwarded-For) and returns the statuses. */
async function burst(count: number, send: (index: number, headers: Record<string, string>) => Promise<APIResponse>): Promise<APIResponse[]> {
  const responses: APIResponse[] = []
  for (let index = 0; index < count; index++) {
    responses.push(await send(index, { 'X-Forwarded-For': `203.0.113.${index + 1}` }))
  }
  return responses
}

function expectLimited(responses: APIResponse[], budget: number, label: string): void {
  const statuses = responses.map((response) => response.status())
  expect(
    statuses.slice(0, budget).filter((status) => status === 429),
    `${label}: ${statuses.join(',')}`,
  ).toEqual([])
  expect(statuses[budget], `${label}: ${statuses.join(',')}`).toBe(429)
  const limited = responses[budget]!
  expect(Number(limited.headers()['x-retry-after'])).toBeGreaterThan(0)
}

// These tests use no tenant of the shared stack: a signed-out storage state keeps the worker's tenant (and its
// sign-in on the shared stack) out of them.
test.use({ storageState: { cookies: [], origins: [] } })

test.describe('auth rate limits', () => {
  let orchestrator: ThrowawayOrchestrator | undefined

  test.afterEach(async () => {
    await orchestrator?.dispose()
    orchestrator = undefined
  })

  test(
    'without a trusted proxy the 11th sign-in within a minute is refused, whatever X-Forwarded-For says',
    { tag: ['@AUTH-010'] },
    async ({ throwawayInfra }) => {
      const adminPassword = password()
      orchestrator = await ThrowawayOrchestrator.start({
        name: 'rate-signin',
        infra: throwawayInfra,
        env: { SCANTOR_TRUST_PROXY: 'false', SCANTOR_ADMIN_EMAIL: 'limited@example.test', SCANTOR_ADMIN_PASSWORD: adminPassword },
      })
      await orchestrator.waitReady()
      const client = await orchestrator.context()
      // Ten wrong passwords and then the right one: the right one is the 11th and is refused all the same.
      const responses = await burst(11, (index, headers) =>
        client.post('/api/auth/sign-in/email', {
          headers,
          data: { email: 'limited@example.test', password: index < 10 ? `wrong-${index}-${password()}` : adminPassword },
        }),
      )
      expect(responses.slice(0, 10).map((response) => response.status())).toEqual(Array(10).fill(401))
      expectLimited(responses, 10, '/sign-in/email')
      expect(await responses[10]!.json()).toEqual({ message: 'Too many requests. Please try again later.' })

      // Every attempt was attributed to the socket peer, never to a spoofed address.
      const attempts = (await orchestrator.logLines()).filter((line) => line.msg === 'request' && line.path === '/api/auth/sign-in/email')
      expect(attempts).toHaveLength(11)
      expect(new Set(attempts.map((line) => line.clientIp)).size).toBe(1)
      expect(String(attempts[0]!.clientIp)).not.toMatch(/^203\.0\.113\./)
    },
  )

  test('with a trusted proxy the rightmost X-Forwarded-For entry is the client', { tag: ['@AUTH-010'] }, async ({ throwawayInfra }) => {
    // The contrast case: behind Traefik (SCANTOR_TRUST_PROXY=true) each forwarded address has its own bucket.
    orchestrator = await ThrowawayOrchestrator.start({
      name: 'rate-proxy',
      infra: throwawayInfra,
      env: { SCANTOR_TRUST_PROXY: 'true', SCANTOR_ADMIN_EMAIL: 'proxied@example.test', SCANTOR_ADMIN_PASSWORD: password() },
    })
    await orchestrator.waitReady()
    const client = await orchestrator.context()
    const responses = await burst(11, (index) =>
      client.post('/api/auth/sign-in/email', {
        headers: { 'X-Forwarded-For': `198.51.100.7, 203.0.113.${index + 1}` },
        data: { email: 'proxied@example.test', password: `wrong-${index}` },
      }),
    )
    expect(responses.map((response) => response.status())).toEqual(Array(11).fill(401))
    const attempts = (await orchestrator.logLines()).filter((line) => line.msg === 'request' && line.path === '/api/auth/sign-in/email')
    expect(attempts.map((line) => line.clientIp)).toEqual(Array.from({ length: 11 }, (_, index) => `203.0.113.${index + 1}`))
  })

  test(
    'passkey authentication, password and email changes and client registration have their own per-IP budgets',
    { tag: ['@AUTH-011'] },
    async ({ throwawayInfra }) => {
      const adminPassword = password()
      orchestrator = await ThrowawayOrchestrator.start({
        name: 'rate-budgets',
        infra: throwawayInfra,
        env: { SCANTOR_TRUST_PROXY: 'false', SCANTOR_ADMIN_EMAIL: 'budgets@example.test', SCANTOR_ADMIN_PASSWORD: adminPassword },
      })
      await orchestrator.waitReady()
      const session: APIRequestContext = await orchestrator.context()
      expect((await session.post('/api/auth/sign-in/email', { data: { email: 'budgets@example.test', password: adminPassword } })).status()).toBe(200)

      const budgets: { path: string; budget: number; body: (index: number) => Record<string, unknown> }[] = [
        {
          path: '/api/auth/passkey/verify-authentication',
          budget: 20,
          body: () => ({ response: { id: 'unknown', rawId: 'unknown', type: 'public-key', response: {} } }),
        },
        { path: '/api/auth/change-password', budget: 5, body: (index) => ({ currentPassword: `wrong-${index}-${password()}`, newPassword: password() }) },
        // The account's own address: refused (400) without a change, so the final sign-in still works.
        { path: '/api/auth/change-email', budget: 5, body: () => ({ newEmail: 'budgets@example.test' }) },
        {
          path: '/api/auth/oauth2/register',
          budget: 10,
          // Rejected by the redirect-URI policy (400): registration attempts count whether or not they succeed.
          body: (index) => ({ client_name: `client-${index}`, redirect_uris: ['https://attacker.example/callback'], token_endpoint_auth_method: 'none' }),
        },
      ]
      for (const { path, budget, body } of budgets) {
        const responses = await burst(budget + 1, (index, headers) => session.post(path, { headers, data: body(index) }))
        expectLimited(responses, budget, path)
      }

      // The budgets are per path: the session and the sign-in bucket still work.
      expect((await session.get('/api/account')).status()).toBe(200)
      expect((await session.post('/api/auth/sign-in/email', { data: { email: 'budgets@example.test', password: adminPassword } })).status()).toBe(200)
    },
  )
})
