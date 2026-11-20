import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BundleDoc, JobDoc, RevisionDoc, TaskDoc } from '../../../server/types/documents'
import { FakeCollection } from '../../helpers/fake-collection'

// createRevisionBundle and getRevisionBundle (docs/api.md, docs/data-model.md §4.21): the refusals, one bundle per
// revision with the reuse rules (active, ready with the current runtime, rebuild, failed, expired, outdated, stale),
// a concurrent create that loses the unique index, and a job that cannot be created.

const store = {
  tasks: new FakeCollection<TaskDoc>('tasks'),
  bundles: new FakeCollection<BundleDoc>('bundles', [{ keys: ['revisionId'] }]),
  jobs: new FakeCollection<JobDoc>('jobs', [{ keys: ['kind', 'subject.id'], partialFilter: { active: true } }]),
}
const deleted: string[] = []

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => Object.fromEntries(Object.entries(store).map(([name, collection]) => [name, collection.asCollection()])),
}))
vi.mock('../../../server/utils/s3', () => ({
  deleteObject: async (key: string) => {
    deleted.push(key)
  },
  isS3NotFound: () => false,
}))

const { createBundle, loadBundle, reuseVerdict, STALE_BUNDLE_GRACE_MS } = await import('../../../server/services/bundles/service')
const { scantorVersion } = await import('../../../server/utils/version')

const USER_ID = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const TASK_ID = '7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c'
const REVISION_ID = 'c2a9e4b1-7d3f-4e5a-9b8c-1d2e3f4a5b6c'
const config = { bundleRetentionDays: 7 }
const DAY_MS = 86_400_000

function revision(overrides: Partial<RevisionDoc> = {}): RevisionDoc {
  return {
    _id: REVISION_ID,
    userId: USER_ID,
    taskId: TASK_ID,
    taskName: 'echo',
    number: 3,
    state: 'ready',
    privileged: false,
    image: { repository: `tasks/${TASK_ID}`, tag: REVISION_ID, digest: `sha256:${'d'.repeat(64)}`, bytes: 1, platform: { os: 'linux', arch: 'arm64' } },
    ...overrides,
  } as RevisionDoc
}

function only(): BundleDoc {
  expect(store.bundles.docs).toHaveLength(1)
  return store.bundles.docs[0] as unknown as BundleDoc
}

/** Puts the revision's only bundle into a state, without its job (a finished job). */
async function settle(fields: Partial<BundleDoc>): Promise<BundleDoc> {
  const doc = only()
  await store.bundles.updateOne({ _id: doc._id }, { $set: fields })
  await store.jobs.updateMany({ 'subject.id': doc._id }, { $set: { state: 'succeeded', active: false } })
  return only()
}

async function expectApiError(promise: Promise<unknown>, code: string, details?: Record<string, unknown>): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught as { code: string; details?: Record<string, unknown> },
  )
  expect(error?.code).toBe(code)
  if (details) expect(error?.details).toMatchObject(details)
}

beforeEach(async () => {
  for (const collection of Object.values(store)) collection.docs.length = 0
  deleted.length = 0
  await store.tasks.insertOne({ _id: TASK_ID, userId: USER_ID, name: 'echo', deletingAt: null } as unknown as TaskDoc)
})

describe('createBundle', () => {
  it('inserts a queued bundle with its names, key, expiry and bundle job', async () => {
    const before = Date.now()
    const { bundle, created } = await createBundle(revision(), {}, config)
    expect(created).toBe(true)
    expect(bundle).toMatchObject({
      userId: USER_ID,
      taskId: TASK_ID,
      taskName: 'echo',
      revisionId: REVISION_ID,
      revisionNumber: 3,
      state: 'queued',
      image: 'localhost/scantor/echo:3',
      platform: { os: 'linux', arch: 'arm64' },
      key: `bundles/${TASK_ID}/${bundle._id}.tar.gz`,
      fileName: 'echo-3-linux-arm64.bundle.tar.gz',
      bytes: null,
      sha256: null,
      scantorVersion: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    })
    expect(bundle.expiresAt.getTime() - bundle.createdAt.getTime()).toBe(7 * DAY_MS)
    expect(bundle.createdAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(store.jobs.docs).toHaveLength(1)
    expect(store.jobs.docs[0]).toMatchObject({
      kind: 'bundle',
      userId: USER_ID,
      subject: { kind: 'bundle', id: bundle._id },
      params: { bundleId: bundle._id },
      state: 'queued',
    })
    expect(only()).toMatchObject({ _id: bundle._id, jobId: store.jobs.docs[0]!._id })
    expect(bundle.jobId).toBe(store.jobs.docs[0]!._id)
  })

  it('refuses unready and privileged revisions and tasks being deleted', async () => {
    await expectApiError(createBundle(revision({ state: 'building', image: null }), {}, config), 'revisionNotReady', { state: 'building', allowed: ['ready'] })
    await expectApiError(createBundle(revision({ state: 'failed', image: null }), {}, config), 'revisionNotReady', { state: 'failed' })
    await expectApiError(createBundle(revision({ privileged: true }), {}, config), 'bundleUnsupported', { reason: 'privileged' })
    await store.tasks.updateOne({ _id: TASK_ID }, { $set: { deletingAt: new Date() } })
    await expectApiError(createBundle(revision(), {}, config), 'notFound')
    expect(store.bundles.docs).toHaveLength(0)
    expect(store.jobs.docs).toHaveLength(0)
  })

  it('returns an active bundle and a current ready one (200), also to concurrent requests', async () => {
    const first = await createBundle(revision(), {}, config)
    const again = await createBundle(revision(), { rebuild: true }, config)
    expect(again).toMatchObject({ created: false, bundle: { _id: first.bundle._id } })
    await store.bundles.updateOne({ _id: first.bundle._id }, { $set: { state: 'running' } })
    expect((await createBundle(revision(), {}, config)).created).toBe(false)

    await settle({ state: 'ready', scantorVersion, bytes: 10, sha256: 'a'.repeat(64), finishedAt: new Date() })
    expect(await createBundle(revision(), {}, config)).toMatchObject({ created: false, bundle: { _id: first.bundle._id, state: 'ready' } })
    expect(store.jobs.docs).toHaveLength(1)
    expect(deleted).toEqual([])
  })

  it.each([
    ['rebuild=true', { state: 'ready', scantorVersion }, true],
    ['a failed bundle', { state: 'failed', error: { code: 'bundleFailed', message: 'boom' } }, false],
    ['an expired bundle', { state: 'ready', scantorVersion, expiresAt: new Date(Date.now() - 1000) }, false],
    ['a bundle of another runtime version', { state: 'ready', scantorVersion: '0.0.1' }, false],
  ] as const)('replaces %s (201) and deletes the old archive and document', async (_label, fields, rebuild) => {
    const first = await createBundle(revision(), {}, config)
    await settle(fields as Partial<BundleDoc>)
    const second = await createBundle(revision(), { rebuild }, config)
    expect(second.created).toBe(true)
    expect(second.bundle._id).not.toBe(first.bundle._id)
    expect(only()).toMatchObject({ _id: second.bundle._id, state: 'queued' })
    expect(deleted).toEqual([first.bundle.key])
    expect(store.jobs.docs.filter((job) => job.active)).toHaveLength(1)
  })

  it('replaces an active bundle whose job is gone once the grace has passed', async () => {
    const first = await createBundle(revision(), {}, config)
    // The job vanished (its onFailed hook could not write), but the bundle is fresh: still answered as is.
    await store.jobs.updateMany({}, { $set: { state: 'failed', active: false } })
    expect((await createBundle(revision(), {}, config)).created).toBe(false)
    await store.bundles.updateOne({ _id: first.bundle._id }, { $set: { updatedAt: new Date(Date.now() - STALE_BUNDLE_GRACE_MS - 1000) } })
    const second = await createBundle(revision(), {}, config)
    expect(second.created).toBe(true)
    expect(deleted).toEqual([first.bundle.key])
  })

  it('returns the bundle of a concurrent request that won the unique index on revisionId', async () => {
    const insertOne = store.bundles.insertOne.bind(store.bundles)
    let winnerId = ''
    vi.spyOn(store.bundles, 'insertOne').mockImplementationOnce(async (doc) => {
      winnerId = 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b'
      await insertOne({ ...doc, _id: winnerId })
      return insertOne(doc)
    })
    const result = await createBundle(revision(), {}, config)
    expect(result).toMatchObject({ created: false, bundle: { _id: winnerId } })
    expect(store.jobs.docs).toHaveLength(0)
  })

  it('deletes the bundle again when its job cannot be created', async () => {
    vi.spyOn(store.jobs, 'insertOne').mockRejectedValueOnce(new Error('mongo down'))
    await expect(createBundle(revision(), {}, config)).rejects.toThrow('mongo down')
    expect(store.bundles.docs).toHaveLength(0)
  })
})

describe('loadBundle', () => {
  it('returns the bundle of the revision, 404 when there is none or it expired', async () => {
    await expectApiError(loadBundle({ _id: REVISION_ID }), 'notFound')
    const { bundle } = await createBundle(revision(), {}, config)
    expect((await loadBundle({ _id: REVISION_ID }))._id).toBe(bundle._id)
    await store.bundles.updateOne({ _id: bundle._id }, { $set: { expiresAt: new Date(Date.now() - 1) } })
    await expectApiError(loadBundle({ _id: REVISION_ID }), 'notFound')
  })
})

describe('reuseVerdict', () => {
  const now = new Date('2026-11-20T12:00:00Z')
  const doc = (fields: Partial<BundleDoc>) =>
    ({ state: 'ready', scantorVersion: '1.6.0', expiresAt: new Date(now.getTime() + DAY_MS), updatedAt: now, ...fields }) as BundleDoc
  const verdict = (fields: Partial<BundleDoc>, options: Partial<{ rebuild: boolean; version: string; jobActive: boolean }> = {}) =>
    reuseVerdict(doc(fields), { rebuild: false, version: '1.6.0', jobActive: false, now, ...options })

  it('reuses current ready bundles and active ones, replaces everything else', () => {
    expect(verdict({})).toBe('reuse')
    expect(verdict({}, { rebuild: true })).toBe('replace')
    expect(verdict({}, { version: '1.7.0' })).toBe('replace')
    expect(verdict({ scantorVersion: null })).toBe('replace')
    expect(verdict({ expiresAt: now })).toBe('replace')
    expect(verdict({ state: 'failed' })).toBe('replace')
    expect(verdict({ state: 'queued' }, { rebuild: true })).toBe('reuse')
    expect(verdict({ state: 'running', updatedAt: new Date(now.getTime() - DAY_MS) }, { jobActive: true })).toBe('reuse')
    expect(verdict({ state: 'running', updatedAt: new Date(now.getTime() - STALE_BUNDLE_GRACE_MS - 1) })).toBe('replace')
    // An expired bundle is replaced whatever its state: getRevisionBundle no longer shows it.
    expect(verdict({ state: 'running', expiresAt: now }, { jobActive: true })).toBe('replace')
  })
})
