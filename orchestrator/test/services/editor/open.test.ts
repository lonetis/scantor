import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEditorSessionBody } from '#shared/schemas/editor'
import type { ScriptDoc, TaskDoc } from '../../../server/types/documents'
import { FakeCollection } from '../../helpers/fake-collection'

// The folder of an editor session (docs/editor.md §8.3, docs/scripts.md): `openScript` is looked up by name among the
// caller's own scripts only (never another user's, not even for admins, never a script being deleted), `open` among the
// caller's tasks; the two exclude each other, and the folder comes from the one (kind, name) → path mapping.

type UserPrincipal = import('../../../server/utils/principal').UserPrincipal

const store = {
  scripts: new FakeCollection<ScriptDoc>('scripts'),
  tasks: new FakeCollection<TaskDoc>('tasks'),
}

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => Object.fromEntries(Object.entries(store).map(([name, collection]) => [name, collection.asCollection()])),
}))

const { resolveEditorFolder, workspaceFolderPath } = await import('../../../server/services/editor/open')
const { editorLandingPath } = await import('../../../server/services/editor/sessions')

const ALICE = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const BOB = '6c9b1d2e-7f3a-4b5c-8d9e-0f1a2b3c4d5e'
const alice = { kind: 'user', via: 'session', user: { id: ALICE }, isAdmin: false } as unknown as UserPrincipal
const adminBob = { kind: 'user', via: 'session', user: { id: BOB }, isAdmin: true } as unknown as UserPrincipal

beforeEach(async () => {
  store.scripts.docs.length = 0
  store.tasks.docs.length = 0
  await store.scripts.insertOne({ _id: 's-alice', userId: ALICE, name: 'csp', deletingAt: null } as unknown as ScriptDoc)
  await store.scripts.insertOne({ _id: 's-gone', userId: ALICE, name: 'gone', deletingAt: new Date() } as unknown as ScriptDoc)
  await store.scripts.insertOne({ _id: 's-bob', userId: BOB, name: 'bobs', deletingAt: null } as unknown as ScriptDoc)
  await store.tasks.insertOne({ _id: 't-alice', userId: ALICE, name: 'echo', deletingAt: null } as unknown as TaskDoc)
})

describe('workspaceFolderPath', () => {
  it('maps a task to its name and a script to .scripts/<name>', () => {
    expect(workspaceFolderPath('task', 'echo')).toBe('echo')
    expect(workspaceFolderPath('script', 'csp')).toBe('.scripts/csp')
    expect(editorLandingPath(workspaceFolderPath('script', 'csp'))).toBe('/?folder=/home/coder/workspace/.scripts/csp')
  })
})

describe('resolveEditorFolder', () => {
  it('opens the workspace root without a folder', async () => {
    expect(await resolveEditorFolder(alice, {})).toBeNull()
  })

  it('opens a script folder of the caller by name', async () => {
    expect(await resolveEditorFolder(alice, { openScript: 'csp' })).toBe('.scripts/csp')
    expect(store.scripts.filters.at(-1)).toEqual({ userId: ALICE, name: 'csp', deletingAt: null })
  })

  it('never opens another user’s script, not even for admins, nor a script being deleted', async () => {
    await expect(resolveEditorFolder(alice, { openScript: 'bobs' })).rejects.toMatchObject({ code: 'notFound' })
    await expect(resolveEditorFolder(adminBob, { openScript: 'csp' })).rejects.toMatchObject({ code: 'notFound' })
    await expect(resolveEditorFolder(alice, { openScript: 'gone' })).rejects.toMatchObject({ code: 'notFound' })
  })

  it('opens a task folder of the caller by name', async () => {
    expect(await resolveEditorFolder(alice, { open: 'echo' })).toBe('echo')
    await expect(resolveEditorFolder(adminBob, { open: 'echo' })).rejects.toMatchObject({ code: 'notFound' })
  })
})

describe('createEditorSessionBody', () => {
  it('accepts open or openScript, not both, and names only (no ids, no paths)', () => {
    expect(createEditorSessionBody.parse({ openScript: 'csp' })).toEqual({ openScript: 'csp' })
    expect(createEditorSessionBody.parse({ open: 'echo' })).toEqual({ open: 'echo' })
    expect(createEditorSessionBody.safeParse({ open: 'echo', openScript: 'csp' }).success).toBe(false)
    for (const openScript of ['.scripts/csp', '../csp', '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11', 'upload', 'CSP']) {
      expect(createEditorSessionBody.safeParse({ openScript }).success).toBe(false)
    }
  })
})
