import { describe, expect, it } from 'vitest'
import { authIndexesFrom } from '../../server/utils/auth'

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
