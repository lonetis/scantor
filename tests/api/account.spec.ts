import { randomBytes } from 'node:crypto'
import type { Account } from '#shared/types/account'
import { ApiClient, ok, type ApiResponse } from '../helpers/api-client'
import { createKey, registerPasskey, signInWithHeaders, stackValue, TestUsers, withAuthTenants } from '../helpers/api-auth'
import { installVirtualAuthenticator } from '../helpers/webauthn'
import { newApiContext } from '../helpers/users'
import { expect, test as base } from '../fixtures'

const test = withAuthTenants(base)

// The caller's own account (docs/api.md §4.3, docs/auth.md §6.3, §6.4): the account representation, the display
// name, setting and removing the password, and the credential invariant (never remove the last password or
// passkey). Password and passkey changes run on a dedicated user; the display-name test restores the tenant's name.

function expectError(response: ApiResponse, status: number, code: string) {
  expect(response.status, response.raw.toString('utf8').slice(0, 300)).toBe(status)
  expect((response.body as { error: { code: string } }).error.code).toBe(code)
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

test.describe('account', () => {
  test('GET /api/account returns the caller with the credential summary', { tag: ['@ACCT-001'] }, async ({ api, apiKeyApi, user }) => {
    const account = ok(await api.getAccount(), 'getAccount')
    expect(Object.keys(account).sort()).toEqual(['canRunPrivileged', 'createdAt', 'credentials', 'email', 'id', 'maxWorkers', 'name', 'role'])
    expect(account).toEqual({
      id: user.id,
      email: user.email,
      name: user.name,
      role: 'user',
      canRunPrivileged: false,
      maxWorkers: Number(stackValue('SCANTOR_USER_MAX_WORKERS')),
      credentials: { hasPassword: true, passkeyCount: 0 },
      createdAt: expect.stringMatching(ISO),
    })
    expect(Date.parse(account.createdAt)).toBeLessThanOrEqual(Date.now())
    // An API key resolves to the same account.
    expect(ok(await apiKeyApi.getAccount(), 'getAccount')).toEqual(account)
  })

  test('PATCH /api/account updates only the trimmed display name', { tag: ['@ACCT-002'] }, async ({ api, apiKeyApi, user }) => {
    try {
      const renamed = ok(await api.call<Account>('updateAccount', { body: { name: '  Renamed Tenant  ' } }), 'updateAccount')
      expect(renamed.name).toBe('Renamed Tenant')
      expect(renamed.email).toBe(user.email)
      expect(ok(await api.getAccount(), 'getAccount').name).toBe('Renamed Tenant')

      // 100 characters are the maximum, also through an API key.
      const longest = 'n'.repeat(100)
      expect(ok(await apiKeyApi.call<Account>('updateAccount', { body: { name: longest } }), 'updateAccount').name).toBe(longest)

      for (const name of ['', '   ', 'n'.repeat(101)]) {
        const response = await api.call('updateAccount', { body: { name } })
        expectError(response, 400, 'validationFailed')
        expect((response.body as { error: { details: { issues: { path: string }[] } } }).error.details.issues[0]!.path, JSON.stringify(name)).toBe('name')
      }
      for (const body of [
        { name: 'x', email: 'other@scantor.test' },
        { name: 'x', role: 'admin' },
        { name: 'x', canRunPrivileged: true },
        { name: 'x', maxWorkers: 5 },
      ]) {
        const field = Object.keys(body)[1]!
        const response = await api.call('updateAccount', { body })
        expectError(response, 400, 'validationFailed')
        expect((response.body as { error: { details: { issues: unknown[] } } }).error.details.issues).toContainEqual({ path: field, message: 'unknown field' })
      }
      const account = ok(await api.getAccount(), 'getAccount')
      expect(account).toMatchObject({ name: longest, email: user.email, role: 'user', canRunPrivileged: false })
    } finally {
      ok(await api.call('updateAccount', { body: { name: user.name } }), 'restore the tenant name')
    }
  })

  test('setting a password needs a session and is refused while one exists', { tag: ['@ACCT-003'] }, async ({ api, apiKeyApi }) => {
    expectError(await api.call('setAccountPassword', { body: { newPassword: 'another-long-password' } }), 409, 'alreadyExists')
    expectError(await apiKeyApi.call('setAccountPassword', { body: { newPassword: 'another-long-password' } }), 403, 'sessionRequired')
    expectError(await apiKeyApi.call('removeAccountPassword'), 403, 'sessionRequired')
    expect(ok(await api.getAccount(), 'getAccount').credentials.hasPassword).toBe(true)
  })
})

test.describe('credential invariant', () => {
  const users = new TestUsers()
  test.afterEach(async ({ adminApi }) => users.cleanup(adminApi))

  test(
    'password and passkeys can be removed only while the other credential remains',
    { tag: ['@ACCT-003', '@ACCT-004', '@ACCT-005'] },
    async ({ adminApi, openapi, browser, env }) => {
      test.setTimeout(180_000)
      const owner = await users.signedIn(adminApi, openapi, { prefix: 'acct-cred' })
      const account = async () => ok(await owner.api.getAccount(), 'getAccount').credentials
      expect(await account()).toEqual({ hasPassword: true, passkeyCount: 0 })

      // Without a passkey the password is the last credential.
      expectError(await owner.api.call('removeAccountPassword'), 409, 'lastCredential')

      // Register a passkey with the user's session in a browser that has a virtual authenticator.
      const context = await browser.newContext({ baseURL: env.publicUrl, storageState: await owner.api.request.storageState() })
      try {
        const page = await context.newPage()
        const authenticator = await installVirtualAuthenticator(page)
        try {
          await registerPasskey(page, 'acct passkey')
          expect(await authenticator.listCredentials()).toHaveLength(1)
        } finally {
          await authenticator.dispose()
        }
      } finally {
        await context.close()
      }
      expect(await account()).toEqual({ hasPassword: true, passkeyCount: 1 })
      const passkeys = (await (await owner.api.request.get('/api/auth/passkey/list-user-passkeys')).json()) as { id: string }[]
      expect(passkeys).toHaveLength(1)

      // Both operations are session only.
      const key = await createKey(owner.api, 'acct-key')
      const keyContext = await newApiContext({ headers: { 'x-api-key': key.key } })
      try {
        const viaKey = new ApiClient(keyContext, openapi)
        expectError(await viaKey.call('removeAccountPassword'), 403, 'sessionRequired')
        expectError(await viaKey.call('setAccountPassword', { body: { newPassword: 'from-an-api-key' } }), 403, 'sessionRequired')
      } finally {
        await keyContext.dispose()
      }

      // With a passkey the password can go; the session stays valid.
      const removed = await owner.api.call('removeAccountPassword')
      expect(removed.status, removed.raw.toString('utf8')).toBe(204)
      expect(await account()).toEqual({ hasPassword: false, passkeyCount: 1 })

      // Now the passkey is the last credential.
      const lastPasskey = await owner.api.request.post('/api/auth/passkey/delete-passkey', { data: { id: passkeys[0]!.id } })
      expect(lastPasskey.status(), await lastPasskey.text()).toBe(409)
      expect(((await lastPasskey.json()) as { error: { code: string } }).error.code).toBe('lastCredential')
      expect(await account()).toEqual({ hasPassword: false, passkeyCount: 1 })

      // A user without a password may set one (8–128 characters), once.
      expectError(await owner.api.call('setAccountPassword', { body: { newPassword: 'short' } }), 400, 'validationFailed')
      const newPassword = randomBytes(18).toString('base64url')
      const set = await owner.api.call('setAccountPassword', { body: { newPassword } })
      expect(set.status, set.raw.toString('utf8')).toBe(204)
      expect(await account()).toEqual({ hasPassword: true, passkeyCount: 1 })
      expectError(await owner.api.call('setAccountPassword', { body: { newPassword: 'yet-another-password' } }), 409, 'alreadyExists')

      // With the password back, the passkey may go, and then the password is the last credential again.
      const deleted = await owner.api.request.post('/api/auth/passkey/delete-passkey', { data: { id: passkeys[0]!.id } })
      expect(deleted.status(), await deleted.text()).toBe(200)
      expect(await account()).toEqual({ hasPassword: true, passkeyCount: 0 })
      expectError(await owner.api.call('removeAccountPassword'), 409, 'lastCredential')

      // The password set through the account works for sign-in.
      const signIn = await users.context()
      expect((await signInWithHeaders(signIn, owner.email, newPassword)).status()).toBe(200)
    },
  )
})
