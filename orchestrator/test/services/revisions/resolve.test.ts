import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RevisionDoc, TaskDoc } from '../../../server/types/documents'
import { FakeCollection } from '../../helpers/fake-collection'

// Revision references in create bodies (docs/api.md §1.4, §5.1 steps 2–3): only the caller's own ready revisions of
// visible tasks resolve; a task being deleted behaves as not found, also for a revision addressed by its id
// (docs/data-model.md §4.1), so no scan can start on what the taskDelete job is removing.

const store = {
  tasks: new FakeCollection<TaskDoc>('tasks'),
  revisions: new FakeCollection<RevisionDoc>('revisions'),
}

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => ({ tasks: store.tasks.asCollection(), revisions: store.revisions.asCollection() }),
}))

const { resolveRevisionRef } = await import('../../../server/services/revisions/resolve')
const { newTaskDoc } = await import('../../../server/services/tasks/store')
type UserPrincipal = import('../../../server/utils/principal').UserPrincipal

const alice = { kind: 'user', user: { id: '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11' }, isAdmin: false } as unknown as UserPrincipal
const REVISION_ID = '7d0a3c52-8f4e-4b55-9a51-3c1e2f6b8d90'
let task: TaskDoc

async function code(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? 'other'
  }
}

beforeEach(async () => {
  for (const collection of Object.values(store)) collection.docs.length = 0
  task = newTaskDoc({ userId: alice.user.id, name: 'echo', language: 'python', source: { kind: 'scaffold', template: 'single' } })
  await store.tasks.insertOne(task)
  await store.revisions.insertOne({ _id: REVISION_ID, taskId: task._id, userId: alice.user.id, taskName: 'echo', number: 1, state: 'ready' } as unknown as RevisionDoc)
})

describe('resolveRevisionRef', () => {
  it('resolves a ready revision by id, by number and as latest', async () => {
    for (const ref of [REVISION_ID, 'echo@1', 'echo@latest', 'echo']) expect((await resolveRevisionRef(alice, ref))._id).toBe(REVISION_ID)
  })

  it('treats every revision of a task being deleted as not found, also by id', async () => {
    await store.tasks.updateOne({ _id: task._id }, { $set: { deletingAt: new Date() } })
    for (const ref of [REVISION_ID, 'echo@1', 'echo@latest']) expect(await code(resolveRevisionRef(alice, ref))).toBe('notFound')
  })

  it('answers revisionNotReady for an unfinished revision', async () => {
    await store.revisions.updateOne({ _id: REVISION_ID }, { $set: { state: 'building' } })
    expect(await code(resolveRevisionRef(alice, REVISION_ID))).toBe('revisionNotReady')
  })
})
