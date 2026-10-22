import { describe, expect, it } from 'vitest'
import { isUserBanned, toCachedUser } from '../../server/utils/user-cache'

// Ban semantics (docs/auth.md §5.5 step 5): banned while `banned` and `banExpires` is unset or in the future.

describe('isUserBanned', () => {
  const now = new Date('2026-10-21T10:00:00Z')
  it.each([
    [false, null, false],
    [true, null, true],
    [true, new Date('2026-10-22T00:00:00Z'), true],
    [true, new Date('2026-10-20T00:00:00Z'), false],
  ])('banned=%s expires=%s → %s', (banned, banExpires, expected) => {
    expect(isUserBanned({ banned, banExpires }, now)).toBe(expected)
  })
})

describe('toCachedUser', () => {
  it('maps better-auth user records', () => {
    expect(
      toCachedUser({ id: 'u', email: 'a@x', name: 'A', role: 'admin', banned: true, banExpires: '2026-10-22T00:00:00Z', canRunPrivileged: true, maxWorkers: 4 }),
    ).toEqual({ id: 'u', email: 'a@x', name: 'A', role: 'admin', banned: true, banExpires: new Date('2026-10-22T00:00:00Z'), canRunPrivileged: true, maxWorkers: 4 })
    expect(toCachedUser({ _id: 'v', role: 'owner' })).toMatchObject({ id: 'v', role: 'user', banned: false, maxWorkers: 0 })
  })
})
