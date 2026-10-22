import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CredentialDoc, TaskDoc } from '../../../server/types/documents'
import { FakeCollection } from '../../helpers/fake-collection'

// uploadTask and pullGitTask decisions (docs/api.md §5.3, docs/tasks.md §13–§14, docs/editor.md §9.6–§9.7) with
// the workspace helpers replaced by a recorder.

const store = {
  tasks: new FakeCollection<TaskDoc>('tasks', [{ keys: ['userId', 'name'] }]),
  credentials: new FakeCollection<CredentialDoc>('credentials'),
}
const calls: { op: string; input: unknown }[] = []
const helper = {
  extracted: { packSha256: 'up', fileCount: 2, bytes: 20 },
  manifest: { name: 'echo', language: 'python' } as Record<string, unknown>,
  current: null as { packSha256: string; fileCount: number; bytes: number } | null,
  pull: null as Record<string, unknown> | null,
}

vi.mock('../../../server/utils/mongo', () => ({ useCollections: () => ({ tasks: store.tasks.asCollection(), credentials: store.credentials.asCollection() }) }))
vi.mock('../../../server/utils/config', () => ({ useConfig: () => ({ gitAllowPrivate: true, caCert: null }) }))
vi.mock('../../../server/services/helpers/ops', () => ({
  extract: async (_userId: string, stagingId: string, body: Readable) => {
    for await (const _chunk of body) {
      // drain
    }
    calls.push({ op: 'extract', input: stagingId })
    return { staging: stagingId, manifest: helper.manifest, summary: helper.extracted }
  },
  snapshotHash: async () => {
    calls.push({ op: 'snapshotHash', input: null })
    return helper.current
  },
  commit: async (_userId: string, input: { expect: string; task: string; from?: string }) => {
    calls.push({ op: 'commit', input })
    return { task: input.task, changed: true, previousPackSha256: helper.current?.packSha256 ?? null, workspace: { packSha256: 'committed', fileCount: 2, bytes: 20 } }
  },
  discard: async () => {
    calls.push({ op: 'discard', input: null })
  },
  gitPull: async () => {
    calls.push({ op: 'gitPull', input: null })
    return helper.pull
  },
}))
vi.mock('../../../server/services/revisions/publish', () => ({
  publishRevision: async (task: TaskDoc) => {
    calls.push({ op: 'publish', input: task.name })
    return { revision: { _id: 'rev' }, created: true }
  },
}))

const { uploadTask } = await import('../../../server/services/tasks/upload')
const { pullGitTask } = await import('../../../server/services/tasks/git')
const { newTaskDoc } = await import('../../../server/services/tasks/store')
const { ApiError } = await import('../../../server/utils/errors')
type UserPrincipal = import('../../../server/utils/principal').UserPrincipal

const user = { kind: 'user', user: { id: 'u1' }, isAdmin: false } as unknown as UserPrincipal
const body = () => Readable.from([Buffer.from('tar.gz')])
const ops = () => calls.map((call) => call.op)
const commitInput = () => calls.find((call) => call.op === 'commit')?.input as { expect: string; from?: string } | undefined

async function errorCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error) {
    return error instanceof ApiError ? error.code : String(error)
  }
}

async function existingTask(fields: Partial<TaskDoc> = {}): Promise<TaskDoc> {
  const task = { ...newTaskDoc({ userId: 'u1', name: 'echo', language: 'python', source: { kind: 'scaffold', template: 'single' } }), ...fields }
  await store.tasks.insertOne(task)
  return task
}

beforeEach(() => {
  for (const collection of Object.values(store)) collection.docs.length = 0
  calls.length = 0
  helper.current = null
  helper.manifest = { name: 'echo', language: 'python' }
  helper.pull = null
})

describe('uploadTask', () => {
  it('creates the task from the manifest, commits and publishes', async () => {
    const outcome = await uploadTask(user, { body: body(), maxBytes: 1000, publish: true, force: false })
    expect(outcome.created).toBe(true)
    expect(outcome.task).toMatchObject({ name: 'echo', language: 'python', source: { kind: 'upload' } })
    expect(ops()).toEqual(['extract', 'commit', 'publish'])
    expect(commitInput()?.expect).toBe('any')
    const stored = (await store.tasks.findOne({ name: 'echo' }))!
    expect(stored.workspace).toMatchObject({ packSha256: 'committed', lastSyncSha256: 'committed' })
  })

  it('refuses unpublished workspace changes with workspaceDirty and discards the staging', async () => {
    await existingTask({ latestRevision: { id: 'r', number: 1, state: 'ready', packSha256: 'published', createdAt: new Date() } })
    helper.current = { packSha256: 'edited', fileCount: 1, bytes: 1 }
    expect(await errorCode(uploadTask(user, { body: body(), maxBytes: 1000, publish: true, force: false }))).toBe('workspaceDirty')
    expect(ops()).toEqual(['extract', 'snapshotHash', 'discard'])
  })

  it('replaces them with force (commit --expect any)', async () => {
    await existingTask()
    helper.current = { packSha256: 'edited', fileCount: 1, bytes: 1 }
    const outcome = await uploadTask(user, { body: body(), maxBytes: 1000, publish: false, force: true })
    expect(outcome.revision).toBeNull()
    expect(commitInput()?.expect).toBe('any')
    expect(ops()).toEqual(['extract', 'snapshotHash', 'commit'])
  })

  it('passes the decided hash to commit when the workspace is unchanged since the last sync', async () => {
    await existingTask({ workspace: { packSha256: 'synced', fileCount: 1, bytes: 1, checkedAt: null, lastSyncSha256: 'synced' } })
    helper.current = { packSha256: 'synced', fileCount: 1, bytes: 1 }
    await uploadTask(user, { body: body(), maxBytes: 1000, publish: false, force: false })
    expect(commitInput()?.expect).toBe('synced')
  })

  it('rejects a new task with an unknown language', async () => {
    helper.manifest = { name: 'rusty', language: 'rust' }
    expect(await errorCode(uploadTask(user, { body: body(), maxBytes: 1000, publish: true, force: false }))).toBe('manifestInvalid')
    expect(ops()).toEqual(['extract', 'discard'])
    expect(store.tasks.docs).toHaveLength(0)
  })

  it('answers 413 when the body exceeds the cap', async () => {
    expect(await errorCode(uploadTask(user, { body: Readable.from([Buffer.alloc(64)]), maxBytes: 10, publish: true, force: false }))).toBe('payloadTooLarge')
  })
})

describe('pullGitTask', () => {
  const git = { url: 'https://example.org/r.git', ref: 'main', path: 'echo', commit: 'c1', packSha256: 'pulled', pulledAt: new Date() }
  const candidate = { path: 'echo', name: 'echo', language: 'python', valid: true, errors: [], summary: { packSha256: 'new', fileCount: 1, bytes: 1 } }

  it('refuses tasks not imported from git', async () => {
    const task = await existingTask()
    expect(await errorCode(pullGitTask(task, { force: false }))).toBe('invalidState')
  })

  it('refuses non-fast-forward remotes and local changes unless forced', async () => {
    const task = await existingTask({ source: { kind: 'git', git } })
    helper.pull = { commit: 'c2', previousCommit: 'c1', fastForward: false, changed: true, candidate, current: { packSha256: 'pulled', fileCount: 1, bytes: 1 } }
    expect(await errorCode(pullGitTask(task, { force: false }))).toBe('gitDiverged')
    helper.pull = { ...helper.pull, fastForward: true, current: { packSha256: 'edited', fileCount: 1, bytes: 1 } }
    expect(await errorCode(pullGitTask(task, { force: false }))).toBe('gitDiverged')
    expect(ops().filter((op) => op === 'commit')).toEqual([])
    const forced = await pullGitTask(task, { force: true })
    expect(forced).toMatchObject({ previousCommit: 'c1', commit: 'c2', changed: true })
    expect(commitInput()?.expect).toBe('any')
  })

  it('fast-forwards, recording the commit, the pack hash and lastSyncSha256', async () => {
    const task = await existingTask({ source: { kind: 'git', git } })
    helper.pull = { commit: 'c2', previousCommit: 'c1', fastForward: true, changed: true, candidate, current: { packSha256: 'pulled', fileCount: 1, bytes: 1 } }
    const outcome = await pullGitTask(task, { force: false })
    expect(commitInput()).toMatchObject({ expect: 'pulled', from: 'echo' })
    expect(outcome.task.source.git).toMatchObject({ commit: 'c2', packSha256: 'committed' })
    expect(outcome.task.workspace.lastSyncSha256).toBe('committed')
  })

  it('reports an unchanged remote without committing', async () => {
    const task = await existingTask({ source: { kind: 'git', git } })
    helper.pull = { commit: 'c1', previousCommit: 'c1', fastForward: true, changed: false, candidate, current: { packSha256: 'pulled', fileCount: 1, bytes: 1 } }
    expect(await pullGitTask(task, { force: false })).toMatchObject({ changed: false, commit: 'c1' })
    expect(ops()).toEqual(['gitPull', 'discard'])
  })
})
