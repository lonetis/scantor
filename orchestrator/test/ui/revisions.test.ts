import { describe, expect, it } from 'vitest'
import { revisionsVersion } from '../../app/composables/useRevisions'

// The task page re-reads its revision list when the polled task shows a published or changed revision
// (docs/ui.md §5.7).

const pointer = (id: string, state: string) => ({ id, number: 1, state, packSha256: 'sha256:x', createdAt: '2026-10-25T10:00:00.000Z' }) as never

describe('revisionsVersion', () => {
  it('changes when a revision is published, changes state or becomes the latest ready one', () => {
    const empty = revisionsVersion({ latestRevision: null, latestReadyRevision: null, revisionCount: 0 })
    const queued = revisionsVersion({ latestRevision: pointer('r1', 'queued'), latestReadyRevision: null, revisionCount: 1 })
    const ready = revisionsVersion({ latestRevision: pointer('r1', 'ready'), latestReadyRevision: pointer('r1', 'ready'), revisionCount: 1 })
    expect(new Set([empty, queued, ready]).size).toBe(3)
    expect(revisionsVersion({ latestRevision: pointer('r1', 'ready'), latestReadyRevision: pointer('r1', 'ready'), revisionCount: 1 })).toBe(ready)
  })

  it('is null without a task', () => {
    expect(revisionsVersion(null)).toBeNull()
    expect(revisionsVersion(undefined)).toBeNull()
  })
})
