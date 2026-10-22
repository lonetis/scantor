import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobDoc, LockDoc } from '../../../server/types/documents'
import { FakeCollection } from '../../helpers/fake-collection'
import { recordingLogger } from '../nodes/helpers'

// Automatic registry garbage collection (docs/deployment.md §14.1): one round under the `registryGc` lock, skipped
// while another orchestrator holds the lock or the registry container is missing, and never while a revision build
// is pushing. The collection itself runs against a real registry in registry.integration.test.ts.

const inspect = vi.fn()
vi.mock('../../../server/utils/docker', () => ({ useDocker: () => ({ getContainer: () => ({ inspect }) }) }))

const { pushInProgress, runRegistryGc } = await import('../../../server/services/registry/gc')

function collections() {
  return { locks: new FakeCollection<LockDoc>('locks'), jobs: new FakeCollection<JobDoc>('jobs') }
}

function pushingJob(state: JobDoc['state'] = 'running'): JobDoc {
  const now = new Date()
  return {
    _id: 'job-1', kind: 'revisionBuild', userId: null, subject: { kind: 'revision', id: 'r1' }, state, active: true, params: {}, cursor: { phase: 'push' },
    progress: { done: 0, total: null }, attempts: 1, maxAttempts: 3, lease: null, notBefore: now, error: null, createdAt: now, startedAt: now, finishedAt: null, updatedAt: now,
  }
}

beforeEach(() => {
  inspect.mockReset()
})

describe('runRegistryGc', () => {
  it('skips the round while another orchestrator holds the lock', async () => {
    const { locks, jobs } = collections()
    locks.docs.push({ _id: 'registryGc', owner: 'someone-else', acquiredAt: new Date(), expiresAt: new Date(Date.now() + 30_000) })
    const result = await runRegistryGc({ locks: locks.asCollection(), jobs: jobs.asCollection(), log: recordingLogger(), signal: new AbortController().signal })
    expect(result).toBe('skippedLocked')
    expect(inspect).not.toHaveBeenCalled()
    expect(locks.docs[0]!.owner).toBe('someone-else')
  })

  it('skips without a registry container and releases the lock', async () => {
    const { locks, jobs } = collections()
    inspect.mockImplementation(async () => {
      throw Object.assign(new Error('no such container'), { statusCode: 404 })
    })
    const result = await runRegistryGc({ locks: locks.asCollection(), jobs: jobs.asCollection(), log: recordingLogger(), signal: new AbortController().signal })
    expect(result).toBe('skippedNoRegistry')
    expect(locks.docs).toEqual([])
  })

  it('waits for a pushing revision build and gives up when stopped', async () => {
    const { locks, jobs } = collections()
    inspect.mockResolvedValue({})
    jobs.docs.push(pushingJob() as never)
    const abort = new AbortController()
    abort.abort()
    const result = await runRegistryGc({ locks: locks.asCollection(), jobs: jobs.asCollection(), log: recordingLogger(), signal: abort.signal })
    expect(result).toBe('skippedPushing')
    expect(locks.docs).toEqual([])
  })
})

describe('pushInProgress', () => {
  it('counts only running revision builds in the push phase', async () => {
    const { jobs } = collections()
    expect(await pushInProgress(jobs.asCollection())).toBe(false)
    jobs.docs.push({ ...pushingJob(), cursor: { phase: 'waitRegistry' } } as never)
    expect(await pushInProgress(jobs.asCollection())).toBe(false)
    jobs.docs.push({ ...pushingJob('queued'), _id: 'job-2' } as never)
    expect(await pushInProgress(jobs.asCollection())).toBe(false)
    jobs.docs.push({ ...pushingJob(), _id: 'job-3' } as never)
    expect(await pushInProgress(jobs.asCollection())).toBe(true)
  })
})
