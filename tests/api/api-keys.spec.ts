import type { ApiKey, CreatedApiKey } from '#shared/types/account'
import type { ItemList } from '#shared/types/common'
import { ApiClient, ok, type ApiResponse } from '../helpers/api-client'
import { API_KEY_PATTERN, createKey, deleteKey, expireApiKey, rootCount, unknownApiKey, withAuthTenants } from '../helpers/api-auth'
import { newApiContext } from '../helpers/users'
import { expect, test as base, unique } from '../fixtures'

const test = withAuthTenants(base)

// The caller's `default` API keys (docs/api.md §4.3, docs/auth.md §8): created with a session and shown once,
// listed without the secret, deleted, expiring, and accepted as a credential in `x-api-key` or
// `Authorization: Bearer`, where an explicit key alone decides. Every key a test creates is deleted again.

const DAY_MS = 86_400_000

function expectError(response: ApiResponse, status: number, code: string) {
  expect(response.status, response.raw.toString('utf8').slice(0, 300)).toBe(status)
  expect((response.body as { error: { code: string } }).error.code).toBe(code)
}

/** A key name of at most 32 characters. */
const keyName = (prefix: string) => unique(prefix).slice(-32)

/** An ApiClient on a context that sends only the given headers (and Origin). */
async function withHeaders<T>(openapi: ApiClient['openapi'], headers: Record<string, string>, fn: (client: ApiClient) => Promise<T>): Promise<T> {
  const context = await newApiContext({ headers })
  try {
    return await fn(new ApiClient(context, openapi))
  } finally {
    await context.dispose()
  }
}

async function listKeys(client: ApiClient, configId?: string): Promise<ApiKey[]> {
  return ok(await client.call<ItemList<ApiKey>>('listApiKeys', { query: { configId } }), 'listApiKeys').items
}

test.describe('API keys', () => {
  const created: { client: ApiClient; id: string }[] = []
  async function create(client: ApiClient, name: string, expiresInDays?: number): Promise<CreatedApiKey> {
    const key = await createKey(client, name, expiresInDays)
    created.push({ client, id: key.apiKey.id })
    return key
  }
  test.afterEach(async () => {
    for (const { client, id } of created.splice(0)) await deleteKey(client, id)
  })

  test('creating a key returns it once with its representation', { tag: ['@ACCT-008'] }, async ({ api, apiKeyApi }) => {
    const name = keyName('create')
    const response = await api.call<CreatedApiKey>('createApiKey', { body: { name } })
    expect(response.status).toBe(201)
    created.push({ client: api, id: response.body.apiKey.id })
    const { apiKey, key } = response.body
    expect(Object.keys(response.body).sort()).toEqual(['apiKey', 'key'])
    expect(key).toMatch(API_KEY_PATTERN)
    expect(apiKey).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name,
      start: key.slice(0, 15),
      configId: 'default',
      enabled: true,
      createdAt: expect.any(String),
      expiresAt: expect.any(String),
      lastRequest: null,
    })
    // The plain key appears nowhere afterwards.
    const listing = await api.call('listApiKeys')
    expect(listing.raw.toString('utf8')).not.toContain(key)
    expect(listing.raw.toString('utf8')).not.toContain(key.slice(15))
    const listed = (listing.body as ItemList<Record<string, unknown>>).items.find((item) => item.id === apiKey.id)
    expect(listed).toBeTruthy()
    expect(listed).not.toHaveProperty('key')

    // Only a browser session may create keys.
    expectError(await apiKeyApi.call('createApiKey', { body: { name: keyName('by-key') } }), 403, 'sessionRequired')
  })

  test('a new key expires after 90 days or after expiresInDays', { tag: ['@ACCT-009'] }, async ({ api }) => {
    const before = Date.now()
    const standard = await create(api, keyName('default-expiry'))
    const after = Date.now()
    const expiresAt = Date.parse(standard.apiKey.expiresAt!)
    expect(expiresAt).toBeGreaterThanOrEqual(before + 90 * DAY_MS - 60_000)
    expect(expiresAt).toBeLessThanOrEqual(after + 90 * DAY_MS + 60_000)
    expect(Math.abs(expiresAt - Date.parse(standard.apiKey.createdAt) - 90 * DAY_MS)).toBeLessThanOrEqual(60_000)

    for (const days of [1, 7, 365]) {
      const key = await create(api, keyName(`expiry-${days}`), days)
      expect(Math.abs(Date.parse(key.apiKey.expiresAt!) - Date.parse(key.apiKey.createdAt) - days * DAY_MS), `${days} days`).toBeLessThanOrEqual(60_000)
    }

    // The 32-character maximum is accepted.
    const longest = 'k'.repeat(32)
    expect((await create(api, longest)).apiKey.name).toBe(longest)

    const rejected: [Record<string, unknown>, string][] = [
      [{ name: keyName('zero'), expiresInDays: 0 }, 'expiresInDays'],
      [{ name: keyName('too-long'), expiresInDays: 366 }, 'expiresInDays'],
      [{ name: keyName('negative'), expiresInDays: -1 }, 'expiresInDays'],
      [{ name: keyName('fraction'), expiresInDays: 1.5 }, 'expiresInDays'],
      [{ name: 'k'.repeat(33) }, 'name'],
      [{ name: '' }, 'name'],
      [{}, 'name'],
    ]
    const names = (await listKeys(api)).length
    for (const [body, path] of rejected) {
      const response = await api.call('createApiKey', { body })
      expectError(response, 400, 'validationFailed')
      expect(
        (response.body as { error: { details: { issues: { path: string }[] } } }).error.details.issues.map((issue) => issue.path),
        JSON.stringify(body),
      ).toContain(path)
    }
    expect((await listKeys(api)).length, 'no rejected key was created').toBe(names)
  })

  test('listing shows only the caller’s keys, newest first, filtered by configuration', { tag: ['@ACCT-010'] }, async ({ api, otherApi, adminApi }) => {
    const first = await create(api, keyName('list-a'))
    const second = await create(api, keyName('list-b'))
    const foreign = await create(otherApi, keyName('list-other'))

    const mine = await listKeys(api)
    const ids = mine.map((key) => key.id)
    expect(ids).toEqual(expect.arrayContaining([first.apiKey.id, second.apiKey.id]))
    expect(ids).not.toContain(foreign.apiKey.id)
    expect(ids.indexOf(second.apiKey.id), 'newest first').toBeLessThan(ids.indexOf(first.apiKey.id))
    const times = mine.map((key) => Date.parse(key.createdAt))
    expect(times).toEqual([...times].sort((a, b) => b - a))
    for (const key of mine) {
      expect(Object.keys(key).sort()).toEqual(['configId', 'createdAt', 'enabled', 'expiresAt', 'id', 'lastRequest', 'name', 'start'])
      expect(key.start, key.id).toMatch(/^sk_scantor_/)
    }
    expect(mine.find((key) => key.id === first.apiKey.id)).toEqual(first.apiKey)

    // Another user and an admin see only their own keys: admins pass ownership checks, not this listing.
    const theirs = (await listKeys(otherApi)).map((key) => key.id)
    expect(theirs).toContain(foreign.apiKey.id)
    expect(theirs).not.toContain(first.apiKey.id)
    const admins = (await listKeys(adminApi)).map((key) => key.id)
    expect(admins).not.toContain(first.apiKey.id)
    expect(admins).not.toContain(foreign.apiKey.id)

    const defaults = await listKeys(api, 'default')
    expect(defaults.map((key) => key.id)).toEqual(expect.arrayContaining([first.apiKey.id, second.apiKey.id]))
    expect(defaults.every((key) => key.configId === 'default')).toBe(true)
    const editors = await listKeys(api, 'editor')
    expect(editors.every((key) => key.configId === 'editor')).toBe(true)
    expect(editors.map((key) => key.id)).not.toContain(first.apiKey.id)
    expectError(await api.call('listApiKeys', { query: { configId: 'admin' } }), 400, 'validationFailed')
  })

  test('a deleted key stops working and other users cannot delete it', { tag: ['@ACCT-011'] }, async ({ api, otherApi, openapi }) => {
    const key = await create(api, keyName('delete'))
    await withHeaders(openapi, { 'x-api-key': key.key }, async (client) => expect((await client.getAccount()).status).toBe(200))

    // Someone else's key id is not found and the key keeps working.
    expectError(await otherApi.call('deleteApiKey', { path: { keyId: key.apiKey.id } }), 404, 'notFound')
    await withHeaders(openapi, { 'x-api-key': key.key }, async (client) => expect((await client.getAccount()).status).toBe(200))

    const deleted = await api.call('deleteApiKey', { path: { keyId: key.apiKey.id } })
    expect(deleted.status).toBe(204)
    await withHeaders(openapi, { 'x-api-key': key.key }, async (client) => expectError(await client.getAccount(), 401, 'unauthorized'))
    await withHeaders(openapi, { Authorization: `Bearer ${key.key}` }, async (client) => expectError(await client.getAccount(), 401, 'unauthorized'))
    expect((await listKeys(api)).map((k) => k.id)).not.toContain(key.apiKey.id)

    expectError(await api.call('deleteApiKey', { path: { keyId: key.apiKey.id } }), 404, 'notFound')
    expectError(await api.call('deleteApiKey', { path: { keyId: 'not-a-uuid' } }), 404, 'notFound')
  })

  test('an expired key gets 401 and is deleted', { tag: ['@ACCT-012'] }, async ({ api, openapi }) => {
    const key = await create(api, keyName('expired'))
    await withHeaders(openapi, { Authorization: `Bearer ${key.key}` }, async (client) => expect((await client.getAccount()).status).toBe(200))
    await expireApiKey(key.apiKey.id)
    await withHeaders(openapi, { Authorization: `Bearer ${key.key}` }, async (client) => expectError(await client.getAccount(), 401, 'unauthorized'))
    // The verification deleted the expired key.
    await expect.poll(() => rootCount('apikey', { _id: key.apiKey.id }), { timeout: 10_000 }).toBe(0)
    expect((await listKeys(api)).map((k) => k.id)).not.toContain(key.apiKey.id)
  })
})

test.describe('API key credentials', () => {
  test('a default key in x-api-key or Bearer acts as its owner', { tag: ['@AUTH-001'] }, async ({ api, user, openapi }) => {
    const account = ok(await api.getAccount(), 'getAccount')
    const variants: Record<string, string>[] = [
      { 'x-api-key': user.apiKey },
      { Authorization: `Bearer ${user.apiKey}` },
      { authorization: `bearer ${user.apiKey}` },
    ]
    for (const headers of variants) {
      await withHeaders(openapi, headers, async (client) => {
        expect(ok(await client.getAccount(), 'getAccount'), JSON.stringify(Object.keys(headers))).toEqual(account)
        // What the key creates belongs to the owner and is visible to the owner's session.
        const name = unique('key-owned')
        const upload = await client.call<{ id: string }>('createUpload', {
          query: { name: `${name}.txt` },
          body: Buffer.from(`${name}\n`),
          headers: { 'Content-Type': 'text/plain' },
        })
        expect(upload.status, upload.raw.toString('utf8')).toBe(201)
        expect((await api.call('getUpload', { path: { uploadId: upload.body.id } })).status).toBe(200)
        expect((await client.call('deleteUpload', { path: { uploadId: upload.body.id } })).status).toBe(204)
      })
    }
  })

  test('an invalid or expired key next to a valid session cookie is 401', { tag: ['@AUTH-002'] }, async ({ api, user, openapi }) => {
    const expired = await createKey(api, keyName('auth-002'))
    try {
      await expireApiKey(expired.apiKey.id)
      const explicit: Record<string, string>[] = [
        { 'x-api-key': unknownApiKey() },
        { Authorization: `Bearer ${unknownApiKey()}` },
        { 'x-api-key': 'not-a-key' },
        { 'x-api-key': expired.key },
        { Authorization: `Bearer ${expired.key}` },
      ]
      for (const headers of explicit) {
        // The request also carries the tenant's valid session cookie.
        const context = await newApiContext({ storageState: user.storageState, headers })
        try {
          const client = new ApiClient(context, openapi)
          expectError(await client.getAccount(), 401, 'unauthorized')
          expectError(await client.call('updateAccount', { body: { name: 'never applied' } }), 401, 'unauthorized')
        } finally {
          await context.dispose()
        }
      }
      // The same session without the explicit credential works, and nothing was changed.
      expect(ok(await api.getAccount(), 'getAccount').name).toBe(user.name)
    } finally {
      await deleteKey(api, expired.apiKey.id)
    }
  })
})
