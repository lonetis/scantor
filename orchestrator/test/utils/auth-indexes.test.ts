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
    expect(indexes).toEqual([
      { collection: 'session', specs: [{ key: { token: 1 }, options: { unique: true } }, { key: { userId: 1 } }] },
      { collection: 'user', specs: [{ key: { email: 1 }, options: { unique: true } }, { key: { nickname: 1 } }] },
      { collection: 'oauthClientResource', specs: [{ key: { client_id: 1, resourceId: 1 }, options: { unique: true } }] },
    ])
  })
})
