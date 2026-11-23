import { describe, expect, it } from 'vitest'
import { type AuthTableMeta, authIndexesFrom, mergeAuthTables } from '../../server/utils/auth'

// Indexes of the better-auth collections, derived from better-auth's own table metadata.

describe('authIndexesFrom', () => {
  it('maps field and table indexes onto collections and keeps uniqueness only for required fields', () => {
    const indexes = authIndexesFrom({
      session: {
        modelName: 'session',
        fields: {
          id: { unique: true },
          token: { unique: true, required: true },
          userId: { index: true, fieldName: 'userId' },
          ipAddress: {},
        },
      },
      user: { modelName: 'user', fields: { email: { unique: true, required: true }, nickname: { unique: true, required: false } } },
      oauthClientResource: {
        modelName: 'oauthClientResource',
        fields: { clientId: { required: true, fieldName: 'client_id' }, resourceId: { required: true } },
        indexes: [{ fields: ['clientId', 'resourceId'], unique: true }],
      },
      plain: { modelName: 'plain', fields: { a: {} } },
    })
    // The names are better-auth's own: the MongoDB adapter creates table-level indexes lazily under exactly these
    // names, so any other name for the same key makes its createIndex fail with IndexOptionsConflict.
    expect(indexes).toEqual([
      {
        collection: 'session',
        specs: [
          { key: { token: 1 }, options: { name: 'session_token_uidx', unique: true } },
          { key: { userId: 1 }, options: { name: 'session_userId_idx' } },
        ],
      },
      {
        collection: 'user',
        specs: [
          { key: { email: 1 }, options: { name: 'user_email_uidx', unique: true } },
          { key: { nickname: 1 }, options: { name: 'user_nickname_idx' } },
        ],
      },
      {
        collection: 'oauthClientResource',
        specs: [{ key: { client_id: 1, resourceId: 1 }, options: { name: 'oauthClientResource_client_id_resourceId_uidx', unique: true } }],
      },
    ])
  })
})

describe('mergeAuthTables', () => {
  // One better-auth instance per origin (docs/auth.md §2.2): an http public URL without passkeys or MCP OAuth next to an
  // https tunnel URL knows fewer models, so the indexes come from the union of every instance's tables.
  const publicTables: Record<string, AuthTableMeta> = {
    user: { modelName: 'user', fields: { email: { unique: true, required: true } } },
    session: { modelName: 'session', fields: { token: { unique: true, required: true } } },
  }
  const tunnelTables: Record<string, AuthTableMeta> = {
    user: { modelName: 'user', fields: { email: { unique: true, required: true }, banned: { index: true } } },
    passkey: { modelName: 'passkey', fields: { credentialID: { unique: true, required: true } } },
    oauthClientResource: {
      modelName: 'oauthClientResource',
      fields: { clientId: { required: true }, resourceId: { required: true } },
      indexes: [{ fields: ['clientId', 'resourceId'], unique: true }],
    },
  }

  it('takes the union of the models and merges the fields of a model both instances know', () => {
    const merged = mergeAuthTables([publicTables, tunnelTables])
    expect(Object.keys(merged).sort()).toEqual(['oauthClientResource', 'passkey', 'session', 'user'])
    expect(merged.user).toEqual({ modelName: 'user', fields: { email: { unique: true, required: true }, banned: { index: true } } })
    expect(merged.session).toBe(publicTables.session)
    expect(merged.oauthClientResource).toBe(tunnelTables.oauthClientResource)
    expect(mergeAuthTables([tunnelTables, publicTables]).user!.fields).toEqual(merged.user!.fields)
  })

  it('keeps every index of every instance', () => {
    const collections = authIndexesFrom(mergeAuthTables([publicTables, tunnelTables])).map(({ collection, specs }) => [
      collection,
      specs.map((spec) => spec.options.name),
    ])
    expect(collections).toEqual([
      ['user', ['user_email_uidx', 'user_banned_idx']],
      ['session', ['session_token_uidx']],
      ['passkey', ['passkey_credentialID_uidx']],
      ['oauthClientResource', ['oauthClientResource_clientId_resourceId_uidx']],
    ])
  })

  it('is the tables themselves for a single instance and empty for none', () => {
    expect(mergeAuthTables([publicTables])).toEqual(publicTables)
    expect(mergeAuthTables([])).toEqual({})
  })
})
