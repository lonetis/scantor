import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeAssignmentWaiters, waitForAssignments } from '../../../server/services/nodes/assignments'
import { resetBootRegistry, stopComponents } from '../../../server/utils/boot'
import { useLogger } from '../../../server/utils/logger'
import { NODE_ID, nodeDoc } from './helpers'

// The assignments long-poll answers as soon as the orchestrator begins to stop (docs/api.md §7.2), so Nitro's drain
// does not wait SCANTOR_NODE_ASSIGNMENTS_WAIT for the node long-polls. MongoDB is replaced by a node that never changes
// and a change stream that cannot be opened (the waits then re-read every second).

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => ({
    nodes: {
      findOne: async () => nodeDoc({ assignmentsRev: 7 }),
      watch: () => {
        throw new Error('no change streams in unit tests')
      },
    },
  }),
}))

afterEach(async () => {
  await closeAssignmentWaiters()
  resetBootRegistry()
})

describe('waitForAssignments', () => {
  it('holds the long-poll while nothing changes', async () => {
    const started = Date.now()
    const node = await waitForAssignments(NODE_ID, { rev: 7, waitMs: 1200, signal: new AbortController().signal })
    expect(node?.assignmentsRev).toBe(7)
    expect(Date.now() - started).toBeGreaterThanOrEqual(1100)
  })

  it('answers at once with the current node when the shutdown begins', async () => {
    const started = Date.now()
    const waiting = waitForAssignments(NODE_ID, { rev: 7, waitMs: 25_000, signal: new AbortController().signal })
    setTimeout(() => void stopComponents(useLogger('test')), 50)
    const node = await waiting
    expect(node?.assignmentsRev).toBe(7)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('does not wait at all once the shutdown began', async () => {
    await stopComponents(useLogger('test'))
    const started = Date.now()
    expect((await waitForAssignments(NODE_ID, { rev: 7, waitMs: 25_000, signal: new AbortController().signal }))?._id).toBe(NODE_ID)
    expect(Date.now() - started).toBeLessThan(500)
  })
})
