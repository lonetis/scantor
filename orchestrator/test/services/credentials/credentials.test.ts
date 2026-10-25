import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CredentialDoc } from '../../../server/types/documents'
import { FakeCollection } from '../../helpers/fake-collection'

// Git credentials (docs/api.md §4.5, docs/data-model.md §4.9, security.md WS-7): encrypted, write-only, sent only to
// their exact host through GIT_CONFIG_* variables.

const store = { credentials: new FakeCollection<CredentialDoc>('credentials', [{ keys: ['userId', 'name'] }]) }

vi.mock('../../../server/utils/mongo', () => ({ useCollections: () => ({ credentials: store.credentials.asCollection() }) }))
vi.mock('../../../server/utils/keys', async (original) => {
  const actual = await original<typeof import('../../../server/utils/keys')>()
  const keyring = actual.createKeyring('test-secret-for-credentials')
  return { ...actual, useKeys: () => keyring }
})

const { createCredential, credentialAad, credentialForGit, deleteCredential, gitCredentialEnv, listCredentials, updateCredential } = await import('../../../server/services/credentials')
const { decryptSecret } = await import('../../../server/utils/secrets')
const { ApiError } = await import('../../../server/utils/errors')
type UserPrincipal = import('../../../server/utils/principal').UserPrincipal

const alice = { kind: 'user', user: { id: '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11' }, isAdmin: false } as unknown as UserPrincipal
const bob = { kind: 'user', user: { id: '1b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c12' }, isAdmin: false } as unknown as UserPrincipal

async function errorCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error) {
    return error instanceof ApiError ? error.code : 'other'
  }
}

beforeEach(() => {
  store.credentials.docs.length = 0
})

describe('credentials', () => {
  it('stores the token encrypted and never returns it', async () => {
    const created = await createCredential(alice, { kind: 'gitToken', name: 'github', host: 'github.com', username: 'x-access-token', token: 'ghp_abcdefgh1234' })
    expect(created).toMatchObject({ name: 'github', host: 'github.com', username: 'x-access-token', last4: '1234', lastUsedAt: null })
    expect(JSON.stringify(created)).not.toContain('ghp_')
    const stored = store.credentials.docs[0] as unknown as CredentialDoc
    expect(stored.secretEnc).toMatch(/^enc:v1:/)
    expect(decryptSecret(stored.secretEnc, 'credentials', credentialAad(stored._id))).toBe('ghp_abcdefgh1234')
    expect((await listCredentials(alice)).items).toHaveLength(1)
    expect((await listCredentials(bob)).items).toHaveLength(0)
  })

  it('refuses duplicate names and hides other users\' credentials', async () => {
    const created = await createCredential(alice, { kind: 'gitToken', name: 'github', host: 'github.com', username: 'u', token: 'tttt' })
    expect(await errorCode(createCredential(alice, { kind: 'gitToken', name: 'github', host: 'gitlab.com', username: 'u', token: 'tttt' }))).toBe('alreadyExists')
    expect(await errorCode(updateCredential(bob, created.id, { name: 'x' }))).toBe('notFound')
    expect(await errorCode(deleteCredential(bob, created.id))).toBe('notFound')
  })

  it('re-encrypts a new token on update and keeps the old one otherwise', async () => {
    const created = await createCredential(alice, { kind: 'gitToken', name: 'github', host: 'github.com', username: 'u', token: 'first-token' })
    await updateCredential(alice, created.id, { name: 'gh' })
    const env1 = await credentialForGit(alice.user.id, created.id, 'github.com')
    expect(env1.secrets).toContain('first-token')
    const updated = await updateCredential(alice, created.id, { token: 'second-token' })
    expect(updated.last4).toBe('oken')
    const env2 = await credentialForGit(alice.user.id, created.id, 'github.com')
    expect(env2.secrets).toContain('second-token')
    expect((store.credentials.docs[0] as unknown as CredentialDoc).lastUsedAt).toBeInstanceOf(Date)
  })

  it('requires the token again when the host changes', async () => {
    const created = await createCredential(alice, { kind: 'gitToken', name: 'github', host: 'github.com', username: 'u', token: 'first-token' })
    try {
      await updateCredential(alice, created.id, { host: 'attacker.example' })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect((error as InstanceType<typeof ApiError>).code).toBe('validationFailed')
      expect((error as InstanceType<typeof ApiError>).details).toEqual({ issues: [{ path: 'token', message: 'is required when the host changes' }] })
    }
    expect(await errorCode(credentialForGit(alice.user.id, created.id, 'attacker.example'))).toBe('badRequest')
    // The same host (as normalised by the schema) needs no token.
    expect(await updateCredential(alice, created.id, { host: 'github.com', username: 'robot' })).toMatchObject({ host: 'github.com', username: 'robot', last4: 'oken' })
    const moved = await updateCredential(alice, created.id, { host: 'gitlab.com', token: 'gitlab-token-9999' })
    expect(moved).toMatchObject({ host: 'gitlab.com', last4: '9999' })
    expect((await credentialForGit(alice.user.id, created.id, 'gitlab.com')).secrets).toContain('gitlab-token-9999')
  })

  it('sends a token only to its exact host', async () => {
    const created = await createCredential(alice, { kind: 'gitToken', name: 'github', host: 'github.com', username: 'u', token: 'tttt' })
    expect(await errorCode(credentialForGit(alice.user.id, created.id, 'evil.example'))).toBe('badRequest')
    expect(await errorCode(credentialForGit(alice.user.id, created.id, 'github.com:8443'))).toBe('badRequest')
    expect(await errorCode(credentialForGit(bob.user.id, created.id, 'github.com'))).toBe('notFound')
  })

  it('builds the GIT_CONFIG_* environment of docs/editor.md §9.7', () => {
    const env = gitCredentialEnv('git.example.org:8443', 'x-access-token', 'tok')
    expect(env.env).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://git.example.org:8443/.extraheader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from('x-access-token:tok').toString('base64')}`,
    })
    expect(env.secrets).toEqual(['tok', Buffer.from('x-access-token:tok').toString('base64')])
  })
})
