import { describe, expect, it } from 'vitest'
import { isDirtyAgainst, isWorkspaceDirty, toApiTask } from '../../../server/services/tasks/mappers'
import { newTaskDoc } from '../../../server/services/tasks/store'

// The Task representation (docs/api.md §2): dirty compares with latestRevision (any state); revisionCount =
// revisionSeq; internal fields are omitted.

const pointer = (packSha256: string) => ({ id: 'r1', number: 2, state: 'failed' as const, packSha256, createdAt: new Date('2026-10-21T09:00:00Z') })

describe('task mappers', () => {
  it('is dirty without revisions and when the workspace differs from the latest revision', () => {
    const doc = newTaskDoc({ userId: 'u', name: 'echo', language: 'python', source: { kind: 'scaffold', template: 'single' } })
    expect(isWorkspaceDirty(doc)).toBe(true)
    doc.workspace.packSha256 = 'a'
    doc.latestRevision = pointer('a')
    expect(isWorkspaceDirty(doc)).toBe(false)
    expect(isDirtyAgainst('b', doc)).toBe(true)
  })

  it('maps the document', () => {
    const doc = newTaskDoc({ userId: 'u', name: 'echo', language: 'python', source: { kind: 'scaffold', template: 'single' } }, new Date('2026-10-21T08:30:00Z'))
    doc.revisionSeq = 3
    doc.latestRevision = pointer('a')
    const api = toApiTask(doc)
    expect(api).toMatchObject({
      name: 'echo',
      revisionCount: 3,
      source: { kind: 'scaffold', template: 'single' },
      workspace: { packSha256: null, fileCount: 0, bytes: 0, dirty: true, lastSyncSha256: null, checkedAt: null },
      latestRevision: { id: 'r1', number: 2, state: 'failed', packSha256: 'a', createdAt: '2026-10-21T09:00:00.000Z' },
      latestReadyRevision: null,
      createdAt: '2026-10-21T08:30:00.000Z',
    })
    expect(api).not.toHaveProperty('revisionSeq')
    expect(api).not.toHaveProperty('deletingAt')
  })
})
