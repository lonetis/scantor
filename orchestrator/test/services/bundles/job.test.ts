import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskBundleOptions, TaskBundleOutcome } from '../../../server/services/pipeline/task-bundle'
import type { BundleDoc, JobDoc, RevisionDoc, TaskDoc } from '../../../server/types/documents'
import type { JobContext } from '../../../server/utils/jobs'
import { FakeCollection } from '../../helpers/fake-collection'
import { readRepoFile } from '../../helpers/repo'

// The `bundle` job (docs/data-model.md §4.12, §4.21; docs/tasks.md §9.11) with a fake `scantor task bundle`: the
// arguments and environment of the step, the archive streamed through the counter into S3, `ready` only with matching
// counts, content errors failing at once, platform errors retried (the last attempt fails), every failed attempt
// deleting what it stored, a stopped job storing nothing, and the onFailed and onRequeued hooks.

const FAKE = fileURLToPath(new URL('../pipeline/fake-task-bundle.mjs', import.meta.url))

const store = {
  bundles: new FakeCollection<BundleDoc>('bundles', [{ keys: ['revisionId'] }]),
  revisions: new FakeCollection<RevisionDoc>('revisions'),
  tasks: new FakeCollection<TaskDoc>('tasks'),
  jobs: new FakeCollection<JobDoc>('jobs'),
}
const objects = new Map<string, { body: Buffer; contentType: string }>()
const deleted: string[] = []
const runs: TaskBundleOptions[] = []
let mode = 'ok'
let uploadHook: ((key: string) => Promise<void>) | null = null
// Called once the body was read; resolving stores the object, as a CompleteMultipartUpload that returns.
let uploadEnd: ((signal: AbortSignal | undefined) => Promise<void>) | null = null

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => Object.fromEntries(Object.entries(store).map(([name, collection]) => [name, collection.asCollection()])),
}))
vi.mock('../../../server/utils/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/utils/s3')>()),
  uploadStream: async (key: string, body: Readable, contentType: string, _metadata?: Record<string, string>, signal?: AbortSignal) => {
    const chunks: Buffer[] = []
    for await (const chunk of body) {
      chunks.push(chunk as Buffer)
      if (uploadHook) await uploadHook(key)
    }
    if (uploadEnd) await uploadEnd(signal)
    objects.set(key, { body: Buffer.concat(chunks), contentType })
  },
  deleteObject: async (key: string) => {
    deleted.push(key)
    objects.delete(key)
  },
}))
vi.mock('../../../server/utils/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/utils/keys')>()
  const keys = actual.createKeyring('bundle job test secret')
  return { ...actual, useKeys: () => keys }
})
vi.mock('../../../server/services/pipeline/slots', () => ({ useBuildSlots: () => ({ acquire: async () => () => {} }) }))
vi.mock('../../../server/services/pipeline/task-bundle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/pipeline/task-bundle')>()
  return {
    ...actual,
    runTaskBundle: (options: TaskBundleOptions): Promise<TaskBundleOutcome> => {
      runs.push(options)
      return actual.runTaskBundle({ ...options, binary: FAKE, env: { ...options.env, PATH: process.env.PATH ?? '', FAKE_MODE: mode } })
    },
  }
})

const { bundleJobKind, classifyBundleRun } = await import('../../../server/services/bundles/job')
const { bundleInfo } = await import('../../../server/services/bundles/info')
const { parseConfig } = await import('../../../server/utils/config')
const { FatalJobError } = await import('../../../server/utils/jobs')
const { useKeys } = await import('../../../server/utils/keys')

const config = parseConfig({}).config
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => quiet }
const USER_ID = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const TASK_ID = '7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c'
const REVISION_ID = 'c2a9e4b1-7d3f-4e5a-9b8c-1d2e3f4a5b6c'
const BUNDLE_ID = '5d0c7a4e-2b1f-4c3d-9e8a-7f6b5c4d3e2f'
const DIGEST = `sha256:${'d'.repeat(64)}`
const KEY = `bundles/${TASK_ID}/${BUNDLE_ID}.tar.gz`
const DAY_MS = 86_400_000

function job(attempts = 1): JobDoc {
  return {
    _id: 'job-1',
    kind: 'bundle',
    userId: USER_ID,
    subject: { kind: 'bundle', id: BUNDLE_ID },
    params: { bundleId: BUNDLE_ID },
    attempts,
    maxAttempts: 3,
  } as unknown as JobDoc
}

function context(signal: AbortSignal = new AbortController().signal): JobContext {
  return { job: job(), log: quiet as never, config, signal, saveCursor: async () => {}, setProgress: async () => {} }
}

function bundle(): BundleDoc {
  return store.bundles.docs.find((doc) => doc._id === BUNDLE_ID) as unknown as BundleDoc
}

async function fatal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(FatalJobError)
  return error as { code: string; message: string }
}

beforeEach(async () => {
  for (const collection of Object.values(store)) collection.docs.length = 0
  objects.clear()
  deleted.length = 0
  runs.length = 0
  mode = 'ok'
  uploadHook = null
  uploadEnd = null
  const canonical = JSON.parse(readRepoFile('internal/bundle/testdata/bundle.json')) as { description: RevisionDoc['description'] }
  await store.tasks.insertOne({ _id: TASK_ID, userId: USER_ID, name: 'echo', deletingAt: null } as unknown as TaskDoc)
  await store.revisions.insertOne({
    _id: REVISION_ID,
    userId: USER_ID,
    taskId: TASK_ID,
    taskName: 'echo',
    number: 3,
    state: 'ready',
    privileged: false,
    manifest: { scantor: 1, name: 'echo', language: 'python', entry: 'main.py' },
    language: 'python',
    image: { repository: `tasks/${TASK_ID}`, tag: REVISION_ID, digest: DIGEST, bytes: 1, platform: { os: 'linux', arch: 'amd64' } },
    description: canonical.description,
    settingsDefaults: null,
  } as unknown as RevisionDoc)
  const now = new Date()
  await store.bundles.insertOne({
    _id: BUNDLE_ID,
    userId: USER_ID,
    taskId: TASK_ID,
    taskName: 'echo',
    revisionId: REVISION_ID,
    revisionNumber: 3,
    state: 'queued',
    image: 'localhost/scantor/echo:3',
    platform: { os: 'linux', arch: 'amd64' },
    key: KEY,
    fileName: 'echo-3-linux-amd64.bundle.tar.gz',
    bytes: null,
    sha256: null,
    scantorVersion: null,
    jobId: 'job-1',
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    expiresAt: new Date(now.getTime() + 7 * DAY_MS),
  })
})

describe('the bundle job', () => {
  it('runs the bundle step for the revision image and stores the counted archive', async () => {
    await bundleJobKind.handler(job(), context())
    expect(runs).toHaveLength(1)
    const options = runs[0]!
    expect(options.image).toBe(`localhost:${config.registryPort}/tasks/${TASK_ID}:${REVISION_ID}`)
    expect(options.pull).toBe(`localhost:${config.registryPort}/tasks/${TASK_ID}@${DIGEST}`)
    expect(options.info).toEqual(bundleInfo((await store.revisions.findOne({ _id: REVISION_ID }))!, config))
    // The push password only, to pull the image again; never SCANTOR_SECRET.
    expect(options.env.SCANTOR_REGISTRY_PUSH_PASSWORD).toBe(useKeys().registryPushPassword())
    expect(Object.keys(options.env).filter((name) => name.includes('SECRET'))).toEqual([])
    expect(options.timeoutMs).toBe(config.buildTimeoutMs + 30 * 60_000)

    const stored = objects.get(KEY)!
    expect(stored.contentType).toBe('application/gzip')
    const doc = bundle()
    expect(doc).toMatchObject({
      state: 'ready',
      bytes: stored.body.length,
      sha256: createHash('sha256').update(stored.body).digest('hex'),
      platform: { os: 'linux', arch: 'amd64' },
      scantorVersion: 'dev',
      error: null,
    })
    expect(doc.startedAt).toBeInstanceOf(Date)
    expect(doc.expiresAt.getTime() - doc.finishedAt!.getTime()).toBe(7 * DAY_MS)
    expect(deleted).toEqual([])
  })

  it('fails at once on a content error and deletes what it stored', async () => {
    mode = 'content'
    const error = await fatal(bundleJobKind.handler(job(), context()))
    expect(error).toMatchObject({ code: 'bundleFailed', message: 'the derived image exceeds SCANTOR_MAX_IMAGE_BYTES' })
    expect(deleted).toEqual([KEY])
    expect(objects.has(KEY)).toBe(false)
  })

  it('retries platform errors and mismatching archives, and fails the last attempt', async () => {
    mode = 'crash'
    const retried = await bundleJobKind.handler(job(1), context()).catch((caught: unknown) => caught)
    expect(retried).toBeInstanceOf(Error)
    expect(retried).not.toBeInstanceOf(FatalJobError)
    expect((retried as Error).message).toMatch(/exit 3.*docker save failed/)
    expect(deleted).toEqual([KEY])

    mode = 'mismatch'
    const mismatched = await bundleJobKind.handler(job(2), context()).catch((caught: unknown) => caught)
    expect(mismatched).not.toBeInstanceOf(FatalJobError)
    expect((mismatched as Error).message).toMatch(/differs from the written one/)
    expect(objects.has(KEY)).toBe(false)

    mode = 'crash'
    expect(await fatal(bundleJobKind.handler(job(3), context()))).toMatchObject({ code: 'bundleFailed' })
    expect(bundle().state).toBe('running')
  })

  it('retries when storing the archive fails', async () => {
    uploadHook = async () => {
      throw new Error('S3 unavailable')
    }
    const error = await bundleJobKind.handler(job(1), context()).catch((caught: unknown) => caught)
    expect((error as Error).message).toMatch(/storing the archive failed: S3 unavailable/)
    expect(objects.has(KEY)).toBe(false)
  })

  it('stores nothing when it is stopped and leaves the requeue to the runner', async () => {
    mode = 'hang'
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    await bundleJobKind.handler(job(), context(controller.signal))
    expect(objects.has(KEY)).toBe(false)
    expect(bundle().state).toBe('running')
  })

  it('stops an upload that hangs after the archive was written', async () => {
    const controller = new AbortController()
    uploadEnd = (signal) =>
      new Promise<void>((_resolve, reject) => {
        expect(signal).toBeInstanceOf(AbortSignal)
        signal!.addEventListener('abort', () => reject(new Error('Upload aborted.')), { once: true })
        setTimeout(() => controller.abort(), 300)
      })
    await bundleJobKind.handler(job(), context(controller.signal))
    expect(objects.has(KEY)).toBe(false)
    expect(bundle().state).toBe('running')
  })

  it('discards the archive when the bundle failed while it was written (its task is being deleted)', async () => {
    uploadHook = async () => {
      await store.bundles.updateOne({ _id: BUNDLE_ID }, { $set: { state: 'failed' } })
    }
    await bundleJobKind.handler(job(), context())
    expect(bundle().state).toBe('failed')
    expect(deleted).toEqual([KEY])
  })

  it('needs its revision and a task that is not being deleted, and skips gone or settled bundles', async () => {
    await store.tasks.updateOne({ _id: TASK_ID }, { $set: { deletingAt: new Date() } })
    expect(await fatal(bundleJobKind.handler(job(), context()))).toMatchObject({ code: 'revisionUnavailable' })
    await store.tasks.updateOne({ _id: TASK_ID }, { $set: { deletingAt: null } })
    store.revisions.docs.length = 0
    expect(await fatal(bundleJobKind.handler(job(), context()))).toMatchObject({ code: 'revisionUnavailable' })

    await store.bundles.updateOne({ _id: BUNDLE_ID }, { $set: { state: 'ready' } })
    await bundleJobKind.handler(job(), context())
    store.bundles.docs.length = 0
    await bundleJobKind.handler(job(), context())
    expect(runs).toEqual([])
  })

  it('fails the bundle in onFailed and queues it again in onRequeued', async () => {
    await store.bundles.updateOne({ _id: BUNDLE_ID }, { $set: { state: 'running' } })
    await bundleJobKind.onRequeued!(job(), { log: quiet as never, config })
    expect(bundle().state).toBe('queued')

    await bundleJobKind.onFailed!(job(), { code: 'leaseExpired', message: 'the job lease expired too often' }, { log: quiet as never, config })
    expect(bundle()).toMatchObject({ state: 'failed', error: { code: 'leaseExpired', message: 'the job lease expired too often' } })
    expect(bundle().finishedAt).toBeInstanceOf(Date)
    expect(deleted).toEqual([KEY])

    // A settled bundle is left alone.
    await bundleJobKind.onFailed!(job(), { code: 'jobFailed', message: 'again' }, { log: quiet as never, config })
    expect(bundle().error).toEqual({ code: 'leaseExpired', message: 'the job lease expired too often' })
  })

  it('runs as an api job in the build slots, one per user', () => {
    expect(bundleJobKind).toMatchObject({ component: 'api', perUserConcurrency: 1, maxAttempts: 3, backoff: { initialMs: 10_000, maxMs: 60_000 } })
    expect(typeof bundleJobKind.concurrency === 'function' && bundleJobKind.concurrency({ ...config, buildConcurrency: 5 })).toBe(5)
  })
})

describe('classifyBundleRun', () => {
  const archive = {
    image: 'localhost/scantor/echo:3',
    platform: { os: 'linux', arch: 'amd64' },
    imageBytes: 1,
    bytes: 10,
    sha256: 'a'.repeat(64),
    scantorVersion: 'dev',
  }
  const outcome = (fields: Partial<TaskBundleOutcome>): TaskBundleOutcome => ({
    exitCode: 0,
    result: { ok: true, bundle: archive, errors: [], warnings: [], durationsMs: {} },
    timedOut: false,
    aborted: false,
    stderrTail: '',
    outputError: null,
    ...fields,
  })
  const stored = { bytes: 10, sha256: 'a'.repeat(64) }

  it('is ready only when the pipeline succeeded and the stored archive matches', () => {
    expect(classifyBundleRun(outcome({}), stored, 1000)).toEqual({ state: 'ready', archive })
    expect(classifyBundleRun(outcome({}), null, 1000)).toMatchObject({ state: 'retry', message: /not stored completely/ })
    expect(classifyBundleRun(outcome({}), { ...stored, bytes: 11 }, 1000)).toMatchObject({ state: 'retry', message: /differs/ })
    expect(classifyBundleRun(outcome({ result: null }), stored, 1000)).toMatchObject({ state: 'retry', message: /without an archive/ })
  })

  it('fails content errors and retries platform errors, timeouts and failed uploads', () => {
    const content = { ok: false, bundle: null, errors: [{ phase: 'build' as const, message: 'too large' }], warnings: [], durationsMs: {} }
    expect(classifyBundleRun(outcome({ exitCode: 2, result: content }), null, 1000)).toEqual({ state: 'failed', message: 'too large' })
    expect(classifyBundleRun(outcome({ exitCode: 2, result: null }), null, 1000)).toMatchObject({ state: 'failed' })
    const platform = { ...content, errors: [{ phase: 'platform' as const, message: 'pull failed: unauthorized' }] }
    expect(classifyBundleRun(outcome({ exitCode: 3, result: platform }), null, 1000)).toEqual({ state: 'retry', message: 'pull failed: unauthorized' })
    expect(classifyBundleRun(outcome({ exitCode: null, result: null, stderrTail: 'boom\n' }), null, 1000)).toEqual({
      state: 'retry',
      message: 'the bundle pipeline failed (exit none): boom',
    })
    expect(classifyBundleRun(outcome({ exitCode: null, timedOut: true }), null, 120_000)).toEqual({
      state: 'retry',
      message: 'the bundle pipeline exceeded 120 s',
    })
    expect(classifyBundleRun(outcome({ exitCode: null, outputError: new Error('S3 down') }), null, 1000)).toEqual({
      state: 'retry',
      message: 'storing the archive failed: S3 down',
    })
  })
})
