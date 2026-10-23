import { randomBytes, randomUUID } from 'node:crypto'
import type { JobAccepted, Page } from '#shared/types/common'
import type { Job } from '#shared/types/jobs'
import type { User } from '#shared/types/users'
import { ApiClient, ok, type ApiResponse } from '../helpers/api-client'
import {
  createKey,
  insertDelayedUserPurge,
  mintToolsCookie,
  releaseJob,
  removeQueuedJob,
  rootCount,
  signInWithHeaders,
  stackValue,
  TestUsers,
  toolHostStatus,
  withAuthTenants,
} from '../helpers/api-auth'
import { connectMcpWithKey } from '../helpers/mcp'
import { newApiContext } from '../helpers/users'
import { expect, test as base, unique } from '../fixtures'

const test = withAuthTenants(base)

// User administration (docs/api.md §4.4, docs/auth.md §5.7, §6): listing, creation with defaults, reads, updates,
// admin-set passwords, bans and unbans, deletion with the userPurge job, the "being deleted" lock and the
// self-protection of admins. Every user is created by the test and deleted afterwards; the seeded admin is never
// the target of a change.

function expectError(response: ApiResponse, status: number, code: string) {
  expect(response.status, response.raw.toString('utf8').slice(0, 300)).toBe(status)
  expect((response.body as { error: { code: string } }).error.code).toBe(code)
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const password = () => randomBytes(18).toString('base64url')

async function withKey<T>(openapi: ApiClient['openapi'], key: string, fn: (client: ApiClient) => Promise<T>): Promise<T> {
  const context = await newApiContext({ headers: { Authorization: `Bearer ${key}` } })
  try {
    return await fn(new ApiClient(context, openapi))
  } finally {
    await context.dispose()
  }
}

test.describe('users', () => {
  const users = new TestUsers()
  test.afterEach(async ({ adminApi }) => users.cleanup(adminApi))

  test('listing is admin only, newest first, filtered by email or name and carries usage', { tag: ['@USER-001'] }, async ({ adminApi, api }) => {
    const marker = unique('list')
    const first = await users.create(adminApi, { prefix: `${marker}-a` })
    // The second one matches by email only: its name does not contain the marker.
    const secondEmail = `${marker}-b@scantor.test`
    const second = ok(await adminApi.createUser({ email: secondEmail, name: unique('other'), password: password() }), 'createUser')
    users.track(second.id)

    for (const q of [marker, marker.toUpperCase(), `${marker.slice(0, -3)}`]) {
      const page = ok(await adminApi.call<Page<User>>('listUsers', { query: { q } }), 'listUsers')
      expect(
        page.items.map((u) => u.id),
        `q=${q}`,
      ).toEqual([second.id, first.id])
      expect(page.nextCursor).toBeNull()
    }
    const byName = ok(await adminApi.call<Page<User>>('listUsers', { query: { q: first.name.toUpperCase() } }), 'listUsers')
    expect(byName.items.map((u) => u.id)).toEqual([first.id])
    const listed = byName.items[0]!
    expect(listed).toEqual({
      id: first.id,
      email: first.email,
      name: first.name,
      role: 'user',
      banned: false,
      banReason: null,
      canRunPrivileged: false,
      maxWorkers: Number(stackValue('SCANTOR_USER_MAX_WORKERS')),
      createdAt: expect.stringMatching(ISO),
      updatedAt: expect.stringMatching(ISO),
      usage: { activeWorkers: 0, tasks: 0, scans: 0 },
    })

    // Cursor pages within the filter.
    const one = ok(await adminApi.call<Page<User>>('listUsers', { query: { q: marker, limit: 1 } }), 'listUsers')
    expect(one.items.map((u) => u.id)).toEqual([second.id])
    expect(one.nextCursor).toEqual(expect.any(String))
    const two = ok(await adminApi.call<Page<User>>('listUsers', { query: { q: marker, limit: 1, cursor: one.nextCursor! } }), 'listUsers')
    expect(two.items.map((u) => u.id)).toEqual([first.id])
    expect(two.nextCursor).toBeNull()

    // The unfiltered list is newest first.
    const all = ok(await adminApi.call<Page<User>>('listUsers', { query: { limit: 200 } }), 'listUsers').items
    const times = all.map((u) => Date.parse(u.createdAt))
    expect(times).toEqual([...times].sort((a, b) => b - a))

    expectError(await api.call('listUsers'), 403, 'adminRequired')
  })

  test('creating a user lowercases the email, applies defaults and refuses duplicates', { tag: ['@USER-002'] }, async ({ adminApi, api }) => {
    const local = unique('Create-Mixed')
    const response = await adminApi.createUser({ email: `${local.toUpperCase()}@Scantor.TEST`, name: '  Created User  ' })
    expect(response.status, response.raw.toString('utf8')).toBe(201)
    users.track(response.body.id)
    expect(response.body).toMatchObject({
      email: `${local.toLowerCase()}@scantor.test`,
      name: 'Created User',
      role: 'user',
      banned: false,
      banReason: null,
      canRunPrivileged: false,
      maxWorkers: Number(stackValue('SCANTOR_USER_MAX_WORKERS')),
      usage: { activeWorkers: 0, tasks: 0, scans: 0 },
    })

    for (const email of [`${local}@scantor.test`, `${local.toUpperCase()}@SCANTOR.test`]) {
      expectError(await adminApi.createUser({ email, name: 'duplicate' }), 409, 'alreadyExists')
    }

    const explicit = await adminApi.createUser({
      email: `${unique('create-admin')}@scantor.test`,
      name: 'explicit',
      password: password(),
      role: 'admin',
      canRunPrivileged: true,
      maxWorkers: 3,
    })
    expect(explicit.status).toBe(201)
    users.track(explicit.body.id)
    expect(explicit.body).toMatchObject({ role: 'admin', canRunPrivileged: true, maxWorkers: 3 })

    const invalid: Record<string, unknown>[] = [
      { email: 'not-an-email', name: 'x' },
      { email: `${unique('short-pw')}@scantor.test`, name: 'x', password: 'seven77' },
      { email: `${unique('long-pw')}@scantor.test`, name: 'x', password: 'p'.repeat(129) },
      { email: `${unique('role')}@scantor.test`, name: 'x', role: 'owner' },
      { email: `${unique('workers')}@scantor.test`, name: 'x', maxWorkers: -1 },
      { email: `${unique('unknown')}@scantor.test`, name: 'x', banned: true },
      { name: 'x' },
    ]
    for (const body of invalid) expectError(await adminApi.call('createUser', { body }), 400, 'validationFailed')
    expectError(await api.createUser({ email: `${unique('by-user')}@scantor.test`, name: 'x' }), 403, 'adminRequired')
  })

  test('a user is read by id; unknown and malformed ids are 404', { tag: ['@USER-004'] }, async ({ adminApi, api }) => {
    const created = await users.create(adminApi, { prefix: 'get' })
    const user = ok(await adminApi.getUser(created.id), 'getUser')
    expect(user).toMatchObject({ id: created.id, email: created.email, name: created.name, role: 'user', banned: false })
    expect(Object.keys(user).sort()).toEqual(
      ['banReason', 'banned', 'canRunPrivileged', 'createdAt', 'email', 'id', 'maxWorkers', 'name', 'role', 'updatedAt', 'usage'].sort(),
    )
    for (const userId of [randomUUID(), 'not-a-uuid', `${created.id}x`]) expectError(await adminApi.getUser(userId), 404, 'notFound')
    expectError(await api.getUser(created.id), 403, 'adminRequired')
  })

  test('updating a user changes profile and admin fields', { tag: ['@USER-005'] }, async ({ adminApi, api }) => {
    const target = await users.create(adminApi, { prefix: 'update' })
    const other = await users.create(adminApi, { prefix: 'update-other' })
    const newLocal = unique('Updated')
    const updated = ok(
      await adminApi.call<User>('updateUser', {
        path: { userId: target.id },
        body: { name: 'Updated Name', email: `${newLocal}@Scantor.test`, role: 'admin', canRunPrivileged: true, maxWorkers: 7 },
      }),
      'updateUser',
    )
    expect(updated).toMatchObject({
      id: target.id,
      name: 'Updated Name',
      email: `${newLocal.toLowerCase()}@scantor.test`,
      role: 'admin',
      canRunPrivileged: true,
      maxWorkers: 7,
    })
    expect(ok(await adminApi.getUser(target.id), 'getUser')).toMatchObject({ role: 'admin', maxWorkers: 7, canRunPrivileged: true })
    const back = ok(await adminApi.call<User>('updateUser', { path: { userId: target.id }, body: { role: 'user', maxWorkers: 0 } }), 'updateUser')
    expect(back).toMatchObject({ role: 'user', maxWorkers: 0, canRunPrivileged: true, name: 'Updated Name' })

    expectError(await adminApi.call('updateUser', { path: { userId: target.id }, body: {} }), 400, 'validationFailed')
    expectError(await adminApi.call('updateUser', { path: { userId: target.id }, body: { email: other.email.toUpperCase() } }), 409, 'alreadyExists')
    expectError(await adminApi.call('updateUser', { path: { userId: target.id }, body: { banned: true } }), 400, 'validationFailed')
    expectError(await adminApi.call('updateUser', { path: { userId: randomUUID() }, body: { name: 'x' } }), 404, 'notFound')
    expectError(await api.call('updateUser', { path: { userId: target.id }, body: { name: 'x' } }), 403, 'adminRequired')
  })

  test(
    'an admin cannot demote, re-password, ban or delete themselves',
    { tag: ['@USER-005', '@USER-006', '@USER-007', '@USER-010'] },
    async ({ adminApi, openapi }) => {
      const admin = await users.signedIn(adminApi, openapi, { prefix: 'self', role: 'admin' })
      const self = { path: { userId: admin.id } }
      expectError(await admin.api.call('updateUser', { ...self, body: { role: 'user' } }), 400, 'badRequest')
      // Changes that are not a demotion are fine.
      expect(ok(await admin.api.call<User>('updateUser', { ...self, body: { name: 'Self Renamed', role: 'admin' } }), 'updateUser').name).toBe('Self Renamed')
      expectError(await admin.api.call('setUserPassword', { ...self, body: { password: password() } }), 400, 'badRequest')
      expectError(await admin.api.call('banUser', { ...self, body: {} }), 400, 'badRequest')
      expectError(await admin.api.call('deleteUser', self), 400, 'badRequest')
      expectError(await admin.api.call('deleteUser', { path: { userId: randomUUID() } }), 404, 'notFound')
      expect(ok(await adminApi.getUser(admin.id), 'getUser')).toMatchObject({ role: 'admin', banned: false })
      expect((await admin.api.getAccount()).status).toBe(200)
    },
  )

  test(
    'a password set by an admin enables sign-in, replaces the old one and revokes sessions',
    { tag: ['@USER-003', '@USER-006'] },
    async ({ adminApi, openapi }) => {
      const target = await users.create(adminApi, { prefix: 'pw', password: false })
      const context = await users.context()
      // Created without a password: no sign-in possible.
      expect((await signInWithHeaders(context, target.email, target.password)).status()).toBe(401)

      const first = password()
      expect((await adminApi.call('setUserPassword', { path: { userId: target.id }, body: { password: first } })).status).toBe(204)
      const session = await users.signIn({ ...target, password: first }, openapi)
      expect(ok(await session.api.getAccount(), 'getAccount').credentials.hasPassword).toBe(true)

      const second = password()
      expect((await adminApi.call('setUserPassword', { path: { userId: target.id }, body: { password: second } })).status).toBe(204)
      expectError(await session.api.getAccount(), 401, 'unauthorized')
      const again = await users.signIn({ ...target, password: second }, openapi)
      expect(ok(await again.api.getAccount(), 'getAccount').id).toBe(target.id)

      for (const bad of ['seven77', 'p'.repeat(129)]) {
        expectError(await adminApi.call('setUserPassword', { path: { userId: target.id }, body: { password: bad } }), 400, 'validationFailed')
      }
      expectError(await adminApi.call('setUserPassword', { path: { userId: randomUUID() }, body: { password: password() } }), 404, 'notFound')
      // The newest session survived the rejected changes.
      expect((await again.api.getAccount()).status).toBe(200)
    },
  )

  test('ban revokes access and unban clears only the flag', { tag: ['@USER-007', '@USER-009'] }, async ({ adminApi, openapi }) => {
    const target = await users.signedIn(adminApi, openapi, { prefix: 'ban' })
    const key = await createKey(target.api, 'before-ban')
    expect(await rootCount('session', { userId: target.id })).toBeGreaterThan(0)

    const banned = ok(await adminApi.call<User>('banUser', { path: { userId: target.id }, body: { reason: 'abuse report 42' } }), 'banUser')
    expect(banned).toMatchObject({ id: target.id, banned: true, banReason: 'abuse report 42' })
    expectError(await target.api.getAccount(), 401, 'unauthorized')
    await withKey(openapi, key.key, async (client) => expectError(await client.getAccount(), 401, 'unauthorized'))
    expect(await rootCount('session', { userId: target.id })).toBe(0)
    expect(await rootCount('apikey', { referenceId: target.id })).toBe(0)
    expect(ok(await adminApi.getUser(target.id), 'getUser')).toMatchObject({ banned: true, banReason: 'abuse report 42' })

    // A banned user cannot sign in.
    const blocked = await signInWithHeaders(await users.context(), target.email, target.password)
    expect(blocked.status(), await blocked.text()).toBe(403)

    const unbanned = ok(await adminApi.call<User>('unbanUser', { path: { userId: target.id } }), 'unbanUser')
    expect(unbanned).toMatchObject({ id: target.id, banned: false, banReason: null })
    // Unbanning a user who is not banned changes nothing.
    const unchanged = ok(await adminApi.call<User>('unbanUser', { path: { userId: target.id } }), 'unbanUser')
    expect(unchanged).toEqual(unbanned)

    // The old session and key stay revoked; signing in and creating keys works again.
    expectError(await target.api.getAccount(), 401, 'unauthorized')
    await withKey(openapi, key.key, async (client) => expectError(await client.getAccount(), 401, 'unauthorized'))
    const back = await users.signIn(target, openapi)
    const fresh = await createKey(back.api, 'after-unban')
    await withKey(openapi, fresh.key, async (client) => expect(ok(await client.getAccount(), 'getAccount').id).toBe(target.id))

    // Ban without a reason, and the error cases.
    expect(ok(await adminApi.call<User>('banUser', { path: { userId: target.id }, body: {} }), 'banUser')).toMatchObject({ banned: true, banReason: null })
    expectError(await adminApi.call('banUser', { path: { userId: target.id }, body: { reason: 'r'.repeat(501) } }), 400, 'validationFailed')
    expectError(await adminApi.call('banUser', { path: { userId: randomUUID() }, body: {} }), 404, 'notFound')
    expectError(await adminApi.call('unbanUser', { path: { userId: randomUUID() } }), 404, 'notFound')
  })

  test(
    'deleting a user locks them out at once, refuses changes during the purge and removes their data',
    { tag: ['@USER-010', '@USER-011'] },
    async ({ adminApi, openapi }) => {
      test.setTimeout(180_000)
      const target = await users.signedIn(adminApi, openapi, { prefix: 'purge' })
      const key = await createKey(target.api, 'purge-key')
      const upload = await target.api.call<{ id: string }>('createUpload', {
        query: { name: 'purge.txt' },
        body: Buffer.from(`${target.id}\n`),
        headers: { 'Content-Type': 'text/plain' },
      })
      expect(upload.status).toBe(201)
      const credential = await target.api.call<{ id: string }>('createCredential', {
        body: { kind: 'gitToken', name: unique('purge-cred'), host: 'git.example.com', token: 'purge-token-value' },
      })
      expect(credential.status, credential.raw.toString('utf8')).toBe(201)

      // A userPurge job that no runner claims yet: the user is "being deleted".
      const jobId = await insertDelayedUserPurge(target.id)
      let released = false
      try {
        const path = { userId: target.id }
        expectError(await adminApi.call('updateUser', { path, body: { name: 'during purge' } }), 409, 'invalidState')
        expectError(await adminApi.call('setUserPassword', { path, body: { password: password() } }), 409, 'invalidState')
        expectError(await adminApi.call('banUser', { path, body: {} }), 409, 'invalidState')
        expectError(await adminApi.call('unbanUser', { path }), 409, 'invalidState')
        const details = ((await adminApi.call('updateUser', { path, body: { name: 'x' } })).body as { error: { details: { state: string } } }).error.details
        expect(details.state).toBe('deleting')

        // deleteUser locks the user out at once and answers with the (single) active purge job.
        const deleted = await adminApi.call<JobAccepted>('deleteUser', { path })
        expect(deleted.status, deleted.raw.toString('utf8')).toBe(202)
        expect(deleted.body.job).toEqual({ id: jobId, kind: 'userPurge', state: 'queued' })
        expect(ok(await adminApi.getUser(target.id), 'getUser')).toMatchObject({ banned: true, banReason: 'deleted' })
        expectError(await target.api.getAccount(), 401, 'unauthorized')
        await withKey(openapi, key.key, async (client) => expectError(await client.getAccount(), 401, 'unauthorized'))
        expectError(await adminApi.call('unbanUser', { path }), 409, 'invalidState')

        await releaseJob(jobId)
        released = true
        await expect
          .poll(async () => ok(await adminApi.getJob(jobId, 30), 'getJob').state, { message: 'the userPurge job finishes', timeout: 150_000, intervals: [0] })
          .toBe('succeeded')
        expectError(await adminApi.getUser(target.id), 404, 'notFound')
        for (const [collection, filter] of [
          ['user', { _id: target.id }],
          ['session', { userId: target.id }],
          ['account', { userId: target.id }],
          ['apikey', { referenceId: target.id }],
          ['uploads', { userId: target.id }],
          ['credentials', { userId: target.id }],
        ] as const) {
          expect(await rootCount(collection, filter), `${collection} of the purged user`).toBe(0)
        }
        const job = ok(await adminApi.getJob(jobId), 'getJob') as Job
        expect(job.kind).toBe('userPurge')
      } finally {
        if (!released) await removeQueuedJob(jobId)
      }
    },
  )

  test('role changes reach the session, the API key, MCP and the tools cookie within 30 s', { tag: ['@AUTH-018'] }, async ({ adminApi, openapi }) => {
    test.setTimeout(180_000)
    const target = await users.signedIn(adminApi, openapi, { prefix: 'role' })
    const key = await createKey(target.api, 'role-key')
    const mcp = await connectMcpWithKey(key.key)
    try {
      const adminToolVisible = async () => (await mcp.listTools()).tools.some((tool) => tool.name === 'list_nodes')
      expect(await adminToolVisible()).toBe(false)
      expectError(await target.api.call('listUsers'), 403, 'adminRequired')

      ok(await adminApi.call('updateUser', { path: { userId: target.id }, body: { role: 'admin' } }), 'promote')
      await expect.poll(async () => (await target.api.call('listUsers', { query: { limit: 1 } })).status, { timeout: 30_000 }).toBe(200)
      await expect
        .poll(() => withKey(openapi, key.key, async (client) => (await client.call('listUsers', { query: { limit: 1 } })).status), { timeout: 30_000 })
        .toBe(200)
      await expect.poll(adminToolVisible, { timeout: 30_000 }).toBe(true)
      const tools = await mintToolsCookie(target.api)
      expect(await toolHostStatus(tools.value)).toBe(200)

      ok(await adminApi.call('updateUser', { path: { userId: target.id }, body: { role: 'user' } }), 'demote')
      await expect.poll(async () => (await target.api.call('listUsers')).status, { timeout: 30_000 }).toBe(403)
      await expect.poll(() => withKey(openapi, key.key, async (client) => (await client.call('listUsers')).status), { timeout: 30_000 }).toBe(403)
      await expect.poll(adminToolVisible, { timeout: 30_000 }).toBe(false)
      await expect.poll(() => toolHostStatus(tools.value), { timeout: 35_000, message: 'the tools cookie stops working' }).toBe(401)
    } finally {
      await mcp.close()
    }
  })
})
