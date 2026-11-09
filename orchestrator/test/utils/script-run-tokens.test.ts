import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScriptRunDoc } from '../../server/types/documents'
import type { CachedUser } from '../../server/utils/user-cache'
import { FakeCollection } from '../helpers/fake-collection'

// Script-run tokens (docs/scripts.md, docs/auth.md): valid only while the run is `running`, bound to the run, its
// script and its owner, and refused for a banned or deleted owner.

const scriptRuns = new FakeCollection<ScriptRunDoc>('scriptRuns')
const users = new Map<string, CachedUser | null>()
let failOwnerLookup = false

vi.mock('../../server/utils/mongo', () => ({ useCollections: () => ({ scriptRuns: scriptRuns.asCollection() }) }))
vi.mock('../../server/utils/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/utils/keys')>()
  const keys = actual.createKeyring('script-run token test secret')
  return { ...actual, useKeys: () => keys }
})
vi.mock('../../server/utils/user-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/utils/user-cache')>()
  return {
    ...actual,
    getCachedUser: async (id: string) => {
      if (failOwnerLookup) throw new Error('connection reset')
      return users.get(id) ?? null
    },
  }
})

const { mintScriptRunToken, resolveScriptRunToken } = await import('../../server/utils/script-run-tokens')
const { createKeyring } = await import('../../server/utils/keys')

const RUN = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f'
const SCRIPT = '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d'
const OWNER = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const OTHER = '1c7a7a1f-4d1f-4b7f-8a1f-6e2a9c1b8d22'
const SCAN = '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f'

function owner(overrides: Partial<CachedUser> = {}): CachedUser {
  return { id: OWNER, email: 'o@x', name: 'o', role: 'user', banned: false, banExpires: null, canRunPrivileged: false, maxWorkers: 0, ...overrides }
}

function run(overrides: Partial<ScriptRunDoc> = {}): ScriptRunDoc {
  return {
    _id: RUN,
    userId: OWNER,
    scriptId: SCRIPT,
    scriptName: 'csp',
    scanIds: [SCAN],
    state: 'running',
    input: { config: {}, settings: { timeoutMs: 60_000, resources: { cpus: 1, memoryMiB: 1024 }, limit: 100 } },
    ...overrides,
  } as ScriptRunDoc
}

beforeEach(async () => {
  await scriptRuns.deleteMany({})
  users.clear()
  users.set(OWNER, owner())
})

describe('script-run tokens', () => {
  it('resolves the token of a running run to its principal', async () => {
    await scriptRuns.insertOne(run())
    const token = mintScriptRunToken({ _id: RUN, scriptId: SCRIPT, userId: OWNER })
    expect(token).toMatch(/^ssr_3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f\.[A-Za-z0-9_-]{43}$/)
    expect(await resolveScriptRunToken(token)).toEqual({
      kind: 'scriptRun',
      scriptRun: { id: RUN, userId: OWNER, scriptId: SCRIPT, scanIds: [SCAN], limit: 100 },
    })
  })

  it('reports an unlimited run as limit null', async () => {
    await scriptRuns.insertOne(run({ input: { config: {}, settings: { timeoutMs: null, resources: { cpus: null, memoryMiB: null }, limit: null } } }))
    const principal = await resolveScriptRunToken(mintScriptRunToken({ _id: RUN, scriptId: SCRIPT, userId: OWNER }))
    expect(principal?.scriptRun.limit).toBeNull()
  })

  it.each(['queued', 'building', 'completed', 'failed', 'cancelled'] as const)('refuses the token of a %s run', async (state) => {
    await scriptRuns.insertOne(run({ state }))
    expect(await resolveScriptRunToken(mintScriptRunToken({ _id: RUN, scriptId: SCRIPT, userId: OWNER }))).toBeNull()
  })

  it('refuses unknown runs, malformed tokens and other credentials', async () => {
    expect(await resolveScriptRunToken(mintScriptRunToken({ _id: RUN, scriptId: SCRIPT, userId: OWNER }))).toBeNull()
    await scriptRuns.insertOne(run())
    const token = mintScriptRunToken({ _id: RUN, scriptId: SCRIPT, userId: OWNER })
    for (const value of ['', 'ssr_', `swt_${token.slice(4)}`, `${token}x`, token.slice(0, -1), `ssr_${RUN.toUpperCase()}.${token.split('.')[1]}`]) {
      expect(await resolveScriptRunToken(value), value).toBeNull()
    }
  })

  it('refuses a MAC over another script, another owner or from another secret', async () => {
    await scriptRuns.insertOne(run())
    const keys = createKeyring('script-run token test secret')
    expect(await resolveScriptRunToken(keys.scriptRunToken(RUN, '7a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d', OWNER))).toBeNull()
    expect(await resolveScriptRunToken(keys.scriptRunToken(RUN, SCRIPT, OTHER))).toBeNull()
    expect(await resolveScriptRunToken(createKeyring('another secret').scriptRunToken(RUN, SCRIPT, OWNER))).toBeNull()
  })

  it('answers 503 unavailable when the run or the owner cannot be read', async () => {
    await scriptRuns.insertOne(run())
    const token = mintScriptRunToken({ _id: RUN, scriptId: SCRIPT, userId: OWNER })
    const findOne = vi.spyOn(scriptRuns, 'findOne').mockRejectedValueOnce(new Error('not primary'))
    await expect(resolveScriptRunToken(token)).rejects.toMatchObject({ code: 'unavailable', statusCode: 503 })
    findOne.mockRestore()
    failOwnerLookup = true
    await expect(resolveScriptRunToken(token)).rejects.toMatchObject({ code: 'unavailable', statusCode: 503 })
    failOwnerLookup = false
    expect(await resolveScriptRunToken(token)).not.toBeNull()
  })

  it('refuses the runs of a banned or deleted owner, but not after the ban expired', async () => {
    await scriptRuns.insertOne(run())
    const token = mintScriptRunToken({ _id: RUN, scriptId: SCRIPT, userId: OWNER })
    users.set(OWNER, owner({ banned: true }))
    expect(await resolveScriptRunToken(token)).toBeNull()
    users.set(OWNER, owner({ banned: true, banExpires: new Date(Date.now() - 60_000) }))
    expect(await resolveScriptRunToken(token)).not.toBeNull()
    users.set(OWNER, null)
    expect(await resolveScriptRunToken(token)).toBeNull()
  })
})
