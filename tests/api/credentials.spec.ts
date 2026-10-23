import type { Credential } from '#shared/types/credentials'
import { ok } from '../helpers/api-client'
import { tenantFixture } from '../helpers/api-tasks-fixtures'
import { credentialsFixture, errorOf, issuePaths, token, type CredentialsFixture } from '../helpers/api-tasks-support'
import { expect, test as base, unique } from '../fixtures'

// Git credentials (docs/api.md §4.5, docs/security.md WS-7): HTTPS tokens for git import and pull, write-only,
// encrypted at rest, sent only to their exact host. Credentials a test creates are deleted at teardown.

const test = base.extend<{ credentials: CredentialsFixture }>({
  user: [tenantFixture('user'), { scope: 'worker', timeout: 180_000 }],
  otherUser: [tenantFixture('other'), { scope: 'worker', timeout: 180_000 }],
  credentials: credentialsFixture,
})

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const randomToken = () => `tok-${token(12)}`

test.describe('create', () => {
  test('returns the credential with the last 4 characters of the token and stores it encrypted', { tag: ['@CRED-001'] }, async ({ api, credentials, docker }) => {
    const secret = `ghp_${token(16)}`
    const name = unique('cred')
    const response = await credentials.create({ kind: 'gitToken', name, host: 'github.com', token: secret })
    expect(response.status).toBe(201)
    const credential = response.body
    expect(credential).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      kind: 'gitToken',
      name,
      host: 'github.com',
      username: 'x-access-token',
      last4: secret.slice(-4),
      lastUsedAt: null,
      createdAt: expect.stringMatching(ISO),
      updatedAt: expect.stringMatching(ISO),
    })
    expect(response.raw.toString('utf8')).not.toContain(secret)

    const listed = ok(await api.call<{ items: Credential[] }>('listCredentials'), 'listCredentials')
    expect(listed.items.find((item) => item.id === credential.id)).toEqual(credential)
    expect(JSON.stringify(listed)).not.toContain(secret)

    // At rest the document holds only a ciphertext: no field carries the token in plain text.
    const stored = await docker.mongosh(`print(EJSON.stringify(db.credentials.findOne({ _id: ${JSON.stringify(credential.id)} })))`, { as: 'root' })
    expect(stored).not.toContain(secret)
    const doc = JSON.parse(stored) as Record<string, unknown>
    expect(doc).toMatchObject({ _id: credential.id, last4: secret.slice(-4) })
    expect(doc.secretEnc).toBeTruthy()
    expect(doc).not.toHaveProperty('token')
  })

  test('keeps an explicit username', { tag: ['@CRED-001'] }, async ({ credentials }) => {
    const credential = await credentials.add({ name: unique('cred'), host: 'gitlab.example.com', username: 'deploy-bot', token: randomToken() })
    expect(credential.username).toBe('deploy-bot')
  })

  test('normalises the host to lowercase host[:port] without the default port', { tag: ['@CRED-002'] }, async ({ credentials }) => {
    const cases: [string, string][] = [
      ['GitHub.COM', 'github.com'],
      ['git.Example.org:443', 'git.example.org'],
      ['git.example.org:8443', 'git.example.org:8443'],
      ['  gitea.example.net  ', 'gitea.example.net'],
    ]
    for (const [input, normalised] of cases) {
      const credential = await credentials.add({ name: unique('cred'), host: input, token: randomToken() })
      expect(credential.host, input).toBe(normalised)
    }
  })

  test('rejects a host with a scheme, path, userinfo or whitespace', { tag: ['@CRED-002'] }, async ({ credentials }) => {
    for (const host of ['https://github.com', 'github.com/org/repo', 'user@github.com', 'user:pass@github.com', 'git hub.com', 'github.com\tx', 'github.com?x=1']) {
      const response = await credentials.create({ name: unique('cred'), host, token: randomToken() })
      expect(response.status, host).toBe(400)
      expect(errorOf(response).code, host).toBe('validationFailed')
      expect(issuePaths(response), host).toContain('host')
    }
  })

  test('rejects a token containing CR or LF', { tag: ['@CRED-002'] }, async ({ credentials }) => {
    for (const secret of ['abc\r\nInjected: 1', 'abc\ndef', 'abc\rdef']) {
      const response = await credentials.create({ name: unique('cred'), host: 'github.com', token: secret })
      expect(response.status, JSON.stringify(secret)).toBe(400)
      expect(errorOf(response).code).toBe('validationFailed')
      expect(issuePaths(response)).toContain('token')
    }
  })

  test('a name is unique per user, also when renaming, while another user may reuse it', { tag: ['@CRED-003'] }, async ({ api, credentials, otherApi }) => {
    const name = unique('cred')
    await credentials.add({ name, host: 'github.com', token: randomToken() })

    const duplicate = await credentials.create({ name, host: 'gitlab.com', token: randomToken() })
    expect(duplicate.status).toBe(409)
    expect(errorOf(duplicate).code).toBe('alreadyExists')

    const second = await credentials.add({ name: unique('cred'), host: 'gitlab.com', token: randomToken() })
    const renamed = await api.call('updateCredential', { path: { credentialId: second.id }, body: { name } })
    expect(renamed.status).toBe(409)
    expect(errorOf(renamed).code).toBe('alreadyExists')

    const otherUsers = await credentials.create({ name, host: 'github.com', token: randomToken() }, otherApi)
    expect(otherUsers.status).toBe(201)
    expect(otherUsers.body.name).toBe(name)
  })
})

test.describe('list', () => {
  test('returns only the caller’s credentials sorted by name, without a cursor', { tag: ['@CRED-004'] }, async ({ api, adminApi, credentials, otherApi }) => {
    const prefix = unique('list')
    const created = []
    for (const suffix of ['c', 'a', 'b']) created.push(await credentials.add({ name: `${prefix}-${suffix}`, host: 'github.com', token: randomToken() }))
    const foreign = await credentials.add({ name: `${prefix}-0`, host: 'github.com', token: randomToken() }, otherApi)

    const response = await api.call<{ items: Credential[] }>('listCredentials')
    expect(response.status).toBe(200)
    expect(Object.keys(response.body)).toEqual(['items'])
    const names = response.body.items.map((item) => item.name)
    expect(names).toEqual([...names].sort())
    expect(names.filter((name) => name.startsWith(prefix))).toEqual([`${prefix}-a`, `${prefix}-b`, `${prefix}-c`])
    expect(response.body.items.map((item) => item.id)).not.toContain(foreign.id)

    // Admins see only their own credentials as well.
    const admins = ok(await adminApi.call<{ items: Credential[] }>('listCredentials'), 'listCredentials')
    const adminIds = admins.items.map((item) => item.id)
    for (const credential of [...created, foreign]) expect(adminIds).not.toContain(credential.id)
  })
})

test.describe('update and delete', () => {
  test('updates name, host, username and token; a new token updates last4', { tag: ['@CRED-005'] }, async ({ api, credentials }) => {
    const credential = await credentials.add({ name: unique('cred'), host: 'github.com', token: 'first-1111' })
    const update = (body: Record<string, unknown>) => api.call<Credential>('updateCredential', { path: { credentialId: credential.id }, body })

    const name = unique('renamed')
    const renamed = ok(await update({ name }), 'updateCredential')
    expect(renamed).toMatchObject({ id: credential.id, name, host: 'github.com', username: 'x-access-token', last4: '1111' })
    expect(Date.parse(renamed.updatedAt)).toBeGreaterThanOrEqual(Date.parse(credential.updatedAt))

    expect(ok(await update({ host: 'Git.Example.com:443' }), 'updateCredential')).toMatchObject({ host: 'git.example.com', last4: '1111' })
    expect(ok(await update({ username: 'robot' }), 'updateCredential')).toMatchObject({ username: 'robot', last4: '1111' })
    const retokened = ok(await update({ token: 'second-2222' }), 'updateCredential')
    expect(retokened).toMatchObject({ name, host: 'git.example.com', username: 'robot', last4: '2222', createdAt: credential.createdAt })

    const listed = ok(await api.call<{ items: Credential[] }>('listCredentials'), 'listCredentials')
    expect(listed.items.find((item) => item.id === credential.id)).toEqual(retokened)
  })

  test('an empty update and invalid fields return 400', { tag: ['@CRED-005'] }, async ({ api, credentials }) => {
    const credential = await credentials.add({ name: unique('cred'), host: 'github.com', token: randomToken() })
    const empty = await api.call('updateCredential', { path: { credentialId: credential.id }, body: {} })
    expect(empty.status).toBe(400)
    expect(errorOf(empty).code).toBe('validationFailed')

    const badHost = await api.call('updateCredential', { path: { credentialId: credential.id }, body: { host: 'https://github.com' } })
    expect(badHost.status).toBe(400)
    expect(issuePaths(badHost)).toContain('host')
  })

  test('delete returns 204 and removes the credential', { tag: ['@CRED-005'] }, async ({ api, credentials }) => {
    const credential = await credentials.add({ name: unique('cred'), host: 'github.com', token: randomToken() })
    const deleted = await api.call('deleteCredential', { path: { credentialId: credential.id } })
    expect(deleted.status).toBe(204)
    expect(deleted.raw.length).toBe(0)

    const listed = ok(await api.call<{ items: Credential[] }>('listCredentials'), 'listCredentials')
    expect(listed.items.map((item) => item.id)).not.toContain(credential.id)

    const again = await api.call('deleteCredential', { path: { credentialId: credential.id } })
    expect(again.status).toBe(404)
    const update = await api.call('updateCredential', { path: { credentialId: credential.id }, body: { name: unique('gone') } })
    expect(update.status).toBe(404)
  })

  test('another user’s credential is 404 for update and delete', { tag: ['@CRED-005'] }, async ({ api, credentials, otherApi }) => {
    const foreign = await credentials.add({ name: unique('cred'), host: 'github.com', token: 'foreign-9999' }, otherApi)
    const update = await api.call('updateCredential', { path: { credentialId: foreign.id }, body: { token: 'stolen-0000' } })
    expect(update.status).toBe(404)
    expect(errorOf(update).code).toBe('notFound')
    const deleted = await api.call('deleteCredential', { path: { credentialId: foreign.id } })
    expect(deleted.status).toBe(404)
    expect(errorOf(deleted).code).toBe('notFound')

    const owners = ok(await otherApi.call<{ items: Credential[] }>('listCredentials'), 'listCredentials')
    expect(owners.items.find((item) => item.id === foreign.id)).toMatchObject({ last4: '9999' })
  })
})
