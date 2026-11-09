import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScriptDoc, ScriptRunDoc } from '../../../server/types/documents'
import { ApiError } from '../../../server/utils/errors'
import { FakeCollection } from '../../helpers/fake-collection'

// Scripts (docs/scripts.md, docs/api.md tag `scripts`): createScript renders the script scaffold and rolls the document
// back when the helper fails, names are unique per owner, the list filter escapes `q` and hides scripts being deleted,
// and the Script representation embeds the newest runs through the run summary of the script-run lifecycle (a test
// double here).

type UserPrincipal = import('../../../server/utils/principal').UserPrincipal

const store = {
  scripts: new FakeCollection<ScriptDoc>('scripts', [{ keys: ['userId', 'name'] }]),
  scriptRuns: new FakeCollection<ScriptRunDoc>('scriptRuns'),
}
const scaffolds: unknown[] = []
let scaffoldError: Error | null = null

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => Object.fromEntries(Object.entries(store).map(([name, collection]) => [name, collection.asCollection()])),
}))
vi.mock('../../../server/services/helpers/ops', () => ({
  scaffold: async (_userId: string, input: unknown) => {
    scaffolds.push(input)
    if (scaffoldError) throw scaffoldError
    return { workspace: { packSha256: 'sha-scaffold', fileCount: 9, bytes: 4096 } }
  },
}))
vi.mock('../../../server/services/script-runs/mappers', () => ({
  toScriptRunSummary: (doc: Pick<ScriptRunDoc, '_id' | 'state'>) => ({ id: doc._id, state: doc.state }),
}))

const { createScript, listScriptsFilter, recentScriptRuns, scriptRepresentation } = await import('../../../server/services/scripts')
const { RECENT_RUNS_LIMIT, RUN_SUMMARY_PROJECTION, toApiScript } = await import('../../../server/services/scripts/mappers')
const { newScriptDoc } = await import('../../../server/services/scripts/store')
const { scriptLanguageNames } = await import('../../../server/services/catalog/languages')

const USER_ID = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const OTHER_ID = '6c9b1d2e-7f3a-4b5c-8d9e-0f1a2b3c4d5e'
const alice = { kind: 'user', via: 'session', user: { id: USER_ID }, isAdmin: false } as unknown as UserPrincipal
const admin = { kind: 'user', via: 'session', user: { id: OTHER_ID }, isAdmin: true } as unknown as UserPrincipal

beforeEach(() => {
  store.scripts.docs.length = 0
  store.scriptRuns.docs.length = 0
  scaffolds.length = 0
  scaffoldError = null
})

describe('createScript', () => {
  it('renders the script scaffold of the first script language and caches the folder summary', async () => {
    const script = await createScript(alice, { name: 'csp', description: 'counts CSP headers' })
    const [language] = scriptLanguageNames()
    expect(scaffolds).toEqual([{ script: 'csp', language, description: 'counts CSP headers' }])
    expect(script).toMatchObject({
      userId: USER_ID,
      name: 'csp',
      language,
      description: 'counts CSP headers',
      source: { kind: 'scaffold' },
      workspace: { packSha256: 'sha-scaffold', fileCount: 9, bytes: 4096 },
      describe: null,
      latestRun: null,
      recentRuns: [],
    })
    expect(store.scripts.docs[0]).toMatchObject({ deletingAt: null, workspace: { lastSyncSha256: null } })
  })

  it('answers 409 alreadyExists for a taken name without rendering anything', async () => {
    await createScript(alice, { name: 'csp' })
    await expect(createScript(alice, { name: 'csp' })).rejects.toMatchObject({ code: 'alreadyExists', statusCode: 409 })
    expect(scaffolds).toHaveLength(1)
  })

  it('removes the document when the scaffold fails, so the name stays free', async () => {
    scaffoldError = new ApiError('payloadTooLarge', 'the workspace is full')
    await expect(createScript(alice, { name: 'csp' })).rejects.toMatchObject({ code: 'payloadTooLarge' })
    expect(store.scripts.docs).toHaveLength(0)
    scaffoldError = null
    await expect(createScript(alice, { name: 'csp' })).resolves.toMatchObject({ name: 'csp' })
  })
})

describe('listScriptsFilter', () => {
  it('limits users to their own scripts, hides scripts being deleted and escapes q', () => {
    const filter = listScriptsFilter(alice, { q: 'a.b(c' }) as { $and: Record<string, unknown>[] }
    expect(filter.$and[0]).toEqual({ userId: USER_ID })
    expect(filter.$and[1]).toEqual({ deletingAt: null })
    const pattern = (filter.$and[2] as { $or: { name: RegExp }[] }).$or[0]!.name
    expect(pattern.source).toBe('a\\.b\\(c')
    expect(pattern.flags).toBe('i')
    expect(pattern.test('xA.B(Cx')).toBe(true)
    expect(pattern.test('aXb(c')).toBe(false)
  })

  it('lets admins list everyone or one user, and refuses another user for non-admins', () => {
    expect((listScriptsFilter(admin, {}) as { $and: unknown[] }).$and[0]).toEqual({})
    expect((listScriptsFilter(admin, { userId: USER_ID }) as { $and: unknown[] }).$and[0]).toEqual({ userId: USER_ID })
    let refused: unknown
    try {
      listScriptsFilter(alice, { userId: OTHER_ID })
    } catch (error) {
      refused = error
    }
    expect(refused).toMatchObject({ code: 'adminRequired', statusCode: 403 })
  })
})

describe('Script representation', () => {
  it('embeds at most 10 newest runs of the script, loading only the summary fields', async () => {
    const script = newScriptDoc({ userId: USER_ID, name: 'csp', language: 'python', source: { kind: 'scaffold' } })
    for (let index = 0; index < 12; index++) {
      await store.scriptRuns.insertOne({
        _id: `run-${String(index).padStart(2, '0')}`,
        scriptId: script._id,
        state: 'completed',
        result: { large: true },
        createdAt: new Date(Date.UTC(2026, 10, 1, 0, index)),
      } as unknown as ScriptRunDoc)
    }
    await store.scriptRuns.insertOne({ _id: 'foreign', scriptId: 'other', state: 'running', createdAt: new Date() } as unknown as ScriptRunDoc)

    const runs = await recentScriptRuns(script._id)
    expect(runs.map((run) => run._id)).toEqual(['run-11', 'run-10', 'run-09', 'run-08', 'run-07', 'run-06', 'run-05', 'run-04', 'run-03', 'run-02'])
    expect(runs[0]).not.toHaveProperty('result')
    expect(Object.keys(RUN_SUMMARY_PROJECTION).sort()).toEqual(['_id', 'cancelRequest', 'createdAt', 'finishedAt', 'progress', 'state'])

    const representation = await scriptRepresentation(script)
    expect(representation.recentRuns).toHaveLength(RECENT_RUNS_LIMIT)
    expect(representation.recentRuns?.[0]).toEqual({ id: 'run-11', state: 'completed' })
  })

  it('maps the document without internal fields', () => {
    const doc: ScriptDoc = {
      ...newScriptDoc(
        { userId: USER_ID, name: 'csp', language: 'python', description: null, source: { kind: 'upload' } },
        new Date('2026-11-01T10:00:00.000Z'),
      ),
      workspace: { packSha256: 'sha-ws', fileCount: 4, bytes: 512, checkedAt: new Date('2026-11-01T11:00:00.000Z'), lastSyncSha256: 'sha-sync' },
      describe: { packSha256: 'sha-ws', configSchema: { type: 'object' }, resultSchema: null, at: new Date('2026-11-01T12:00:00.000Z') },
      latestRun: { id: 'run-1', state: 'running', createdAt: new Date('2026-11-01T12:00:00.000Z'), finishedAt: null },
      deletingAt: null,
    }
    const script = toApiScript(doc)
    expect(script).toEqual({
      id: doc._id,
      userId: USER_ID,
      name: 'csp',
      language: 'python',
      description: null,
      source: { kind: 'upload' },
      workspace: { packSha256: 'sha-ws', fileCount: 4, bytes: 512, checkedAt: '2026-11-01T11:00:00.000Z' },
      describe: { packSha256: 'sha-ws', configSchema: { type: 'object' }, resultSchema: null, at: '2026-11-01T12:00:00.000Z' },
      latestRun: { id: 'run-1', state: 'running', createdAt: '2026-11-01T12:00:00.000Z', finishedAt: null },
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
    })
    expect(script).not.toHaveProperty('recentRuns')
  })
})
