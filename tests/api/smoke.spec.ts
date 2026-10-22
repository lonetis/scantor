import { ok } from '../helpers/api-client'
import { expect, test } from '../fixtures'

// Smoke test of the API plumbing: the stack answers through Traefik with the test CA, and the fixtures provide the
// admin, the worker's tenant (session) and its API key as distinct principals.

test.describe('API plumbing', () => {
  test('health reports every component ok', { tag: ['@F1.1'] }, async ({ anonApi }) => {
    const health = ok(await anonApi.getHealth(), 'getHealth')
    expect(health.status).toBe('ok')
    for (const [component, state] of Object.entries(health.components)) expect(state, component).toBe('ok')
  })

  test('the session, the API key and the admin act as their own principals', { tag: ['@F2.2'] }, async ({ api, apiKeyApi, adminApi, user }) => {
    const account = ok(await api.getAccount(), 'getAccount')
    expect(account.email).toBe(user.email)
    expect(account.role).toBe('user')
    expect(ok(await apiKeyApi.getAccount(), 'getAccount').id).toBe(account.id)
    expect(ok(await adminApi.getInstanceInfo(), 'getInstanceInfo').user.role).toBe('admin')
  })
})
