import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseConfig, setConfigForTesting } from '../../server/utils/config'
import { useLogger } from '../../server/utils/logger'

// Lockout hooks of bans and deletions (docs/auth.md §5.7): every hook runs, also after an earlier one failed.

const ctx = {
  internalAdapter: { updateUser: vi.fn(async () => ({ id: 'u' })), deleteUserSessions: vi.fn(async () => undefined) },
  adapter: { deleteMany: vi.fn(async () => 0) },
}
vi.mock('../../server/utils/auth', () => ({ useAuth: () => ({}), useAuthContext: async () => ctx }))

const users = await import('../../server/utils/users')
const log = useLogger('test')

beforeEach(() => {
  setConfigForTesting(parseConfig({}).config)
  users.resetUserLockoutHooks()
})

afterEach(() => {
  users.resetUserLockoutHooks()
  setConfigForTesting(null)
})

function hook(name: string, order: number, calls: string[], failure?: Error): users.UserLockoutHook {
  return {
    name,
    order,
    async run(userId, { reason }) {
      calls.push(`${name}:${reason}:${userId}`)
      if (failure) throw failure
    },
  }
}

describe('runLockoutHooks', () => {
  it('runs the hooks in order', async () => {
    const calls: string[] = []
    users.registerUserLockoutHook(hook('cancelScans', 60, calls))
    users.registerUserLockoutHook(hook('editor', 50, calls))
    await users.runLockoutHooks('u', { cancelScans: true, reason: 'ban' }, log)
    expect(calls).toEqual(['editor:ban:u', 'cancelScans:ban:u'])
  })

  it('runs every hook after a failure and throws the failures at the end', async () => {
    const calls: string[] = []
    const failure = new Error('docker daemon hiccup')
    users.registerUserLockoutHook(hook('editor', 50, calls, failure))
    users.registerUserLockoutHook(hook('cancelScans', 60, calls))
    const error = await users.runLockoutHooks('u', { cancelScans: true, reason: 'ban' }, log).catch((e: unknown) => e)
    expect(calls).toEqual(['editor:ban:u', 'cancelScans:ban:u'])
    expect(error).toBeInstanceOf(users.LockoutHooksError)
    expect((error as InstanceType<typeof users.LockoutHooksError>).hooks).toEqual(['editor'])
    expect((error as AggregateError).errors).toEqual([failure])
  })
})

describe('banUserAccount and lockOutDeletedUser', () => {
  it('a ban reports a failed hook after the others ran', async () => {
    const calls: string[] = []
    users.registerUserLockoutHook(hook('editor', 50, calls, new Error('stop failed')))
    users.registerUserLockoutHook(hook('cancelScans', 60, calls))
    await expect(users.banUserAccount('u', { reason: null, cancelScans: true }, log)).rejects.toBeInstanceOf(users.LockoutHooksError)
    expect(calls).toEqual(['editor:ban:u', 'cancelScans:ban:u'])
    expect(ctx.internalAdapter.updateUser).toHaveBeenCalledWith('u', expect.objectContaining({ banned: true }))
    expect(ctx.internalAdapter.deleteUserSessions).toHaveBeenCalledWith('u')
  })

  it('a deletion goes on when a hook fails, so the purge job still starts', async () => {
    const calls: string[] = []
    users.registerUserLockoutHook(hook('editor', 50, calls, new Error('stop failed')))
    await expect(users.lockOutDeletedUser('u', log)).resolves.toBeUndefined()
    expect(calls).toEqual(['editor:delete:u'])
    expect(ctx.internalAdapter.updateUser).toHaveBeenCalledWith('u', expect.objectContaining({ banned: true, banReason: 'deleted' }))
  })

  it('a deletion fails when the user cannot be locked out at all', async () => {
    ctx.internalAdapter.deleteUserSessions.mockRejectedValueOnce(new Error('not primary'))
    const calls: string[] = []
    users.registerUserLockoutHook(hook('editor', 50, calls))
    await expect(users.lockOutDeletedUser('u', log)).rejects.toThrow('not primary')
    expect(calls).toEqual([])
  })
})
