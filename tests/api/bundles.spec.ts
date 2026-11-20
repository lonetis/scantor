import type { Bundle } from '#shared/types/bundles'
import { ok, type ApiClient } from '../helpers/api-client'
import { createBundle, fetchArchive, getBundle, readyBundle, waitForBundle } from '../helpers/api-bundles'
import { exampleWithDefaults } from '../helpers/api-scans-tasks'
import { deleteTaskAndWait, errorOf, issuePaths, pythonTaskFiles, uploadFiles, writeTaskFiles } from '../helpers/api-tasks-support'
import { docker, innerDocker, stackEnv } from '../helpers/docker'
import { publishAndWait, removeDir, uploadAndPublish } from '../helpers/tasks'
import { expect, test, unique } from '../fixtures'

// Bundles of revisions (docs/api.md createRevisionBundle and getRevisionBundle, docs/data-model.md §4.21, security.md
// §6.21 BDL-3…5): one bundle per revision, created by a `bundle` job on the master from the revision image, stored in
// S3 and downloaded through a presigned gzip attachment. Every test builds the `echo` example (or a variant) as a task
// of its own, because creating and replacing bundles changes what later reads see; the runs of a bundle are in
// e2e/bundles.spec.ts and the contents of the archive in security/bundles.spec.ts. Replacing a failed or expired bundle
// is tested by changing the document directly (as root), because neither happens on its own within a test.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/
const DAY_MS = 86_400_000
/** Bundle jobs share the build slots of the stack and run one per user at a time. */
const BUNDLE_TIMEOUT_MS = 480_000

function retentionMs(): number {
  return Number(stackEnv().SCANTOR_BUNDLE_RETENTION_DAYS || '7') * DAY_MS
}

/** Changes a bundle document as root (white-box: failures and expiry do not happen on their own in a test). */
async function setBundleFields(bundleId: string, fields: string): Promise<void> {
  if (!UUID.test(bundleId)) throw new Error(`not a bundle id: ${bundleId}`)
  await innerDocker.mongosh(`db.bundles.updateOne({ _id: ${JSON.stringify(bundleId)} }, { $set: ${fields} })`, { as: 'root' })
}

function expectApiError(response: { status: number; body: unknown }, status: number, code: string): Record<string, unknown> | undefined {
  expect(response.status, JSON.stringify(response.body)).toBe(status)
  const error = errorOf(response as never)
  expect(error.code).toBe(code)
  return error.details
}

async function expectNoBundle(api: ApiClient, task: string, revision: string | number): Promise<void> {
  expectApiError(await getBundle(api, task, revision), 404, 'notFound')
}

test.describe('create and get', () => {
  test(
    'a create on a ready revision returns 201 queued; it becomes ready with a presigned gzip attachment and the commands',
    { tag: ['@BUNDLE-001'] },
    async ({ api, tasks }) => {
      test.setTimeout(BUNDLE_TIMEOUT_MS)
      const { task, revision } = await tasks.example('echo')
      const arch = revision.image!.platform.arch
      const image = `localhost/scantor/${task.name}:${revision.number}`
      const fileName = `${task.name}-${revision.number}-linux-${arch}.bundle.tar.gz`
      await expectNoBundle(api, task.name, revision.number)

      const response = await createBundle(api, task.name, revision.number)
      expect(response.status, JSON.stringify(response.body)).toBe(201)
      const queued = response.body
      expect(queued).toMatchObject({
        id: expect.stringMatching(UUID),
        revision: { id: revision.id, number: revision.number, ref: `${task.name}@${revision.number}` },
        state: 'queued',
        image,
        platform: { os: 'linux', arch },
        bytes: null,
        sha256: null,
        scantorVersion: null,
        error: null,
        startedAt: null,
        finishedAt: null,
        download: null,
      })
      expect(queued.commands).toEqual({
        load: `docker load -i ${fileName}`,
        run: `docker run --rm -v "$PWD:/work" ${image}`,
        describe: `docker run --rm ${image} --describe`,
      })
      expect(Date.parse(queued.expiresAt) - Date.parse(queued.createdAt)).toBe(retentionMs())
      expect(arch).toMatch(/^(amd64|arm64)$/)

      // The revision is addressed by number, id or latest alike.
      const ready = await waitForBundle(api, task.id, revision.id)
      expect(ready, JSON.stringify(ready.error)).toMatchObject({
        id: queued.id,
        state: 'ready',
        image,
        platform: { os: 'linux', arch },
        sha256: expect.stringMatching(SHA256),
        scantorVersion: expect.any(String),
        error: null,
        startedAt: expect.any(String),
        finishedAt: expect.any(String),
        download: { url: expect.stringMatching(/^https:\/\//), fileName, expiresAt: expect.any(String) },
        commands: queued.commands,
      })
      expect(ready.bytes).toBeGreaterThan(0)
      expect(Date.parse(ready.expiresAt) - Date.parse(ready.finishedAt!)).toBe(retentionMs())
      expect(Date.parse(ready.download!.expiresAt)).toBeGreaterThan(Date.now())
      expect(ok(await getBundle(api, task.name, 'latest'), 'getRevisionBundle').id).toBe(queued.id)
      const settled = await getBundle(api, task.name, revision.number, 30)
      expect(settled.headers['scantor-wait']).toBe('settled')

      // A presigned GET of the archive: a gzip attachment named after the revision and its platform (a range suffices
      // for the headers), and the whole archive has the size and SHA-256 of the bundle.
      const first = await fetchArchive(ready.download!.url, { range: 'bytes=0-1' })
      expect(first.status).toBe(206)
      expect(first.headers['content-type']).toBe('application/gzip')
      expect(first.headers['content-disposition']).toMatch(new RegExp(`^attachment; filename="${fileName.replaceAll('.', '\\.')}"`))
      expect(first.head).toEqual(Buffer.from([0x1f, 0x8b]))
      const whole = await fetchArchive(ready.download!.url)
      expect(whole.status).toBe(200)
      expect(whole.bytes).toBe(ready.bytes)
      expect(whole.sha256).toBe(ready.sha256)
    },
  )

  test(
    'a create returns the active or ready bundle (200); rebuild, a failure or the expiry replace it (201)',
    { tag: ['@BUNDLE-002'] },
    async ({ api, tasks }) => {
      test.setTimeout(BUNDLE_TIMEOUT_MS)
      const { task, revision } = await tasks.example('echo')
      const ready = await readyBundle(api, task.name, revision.number)
      expect(ready.created).toBe(201)

      const reused = await createBundle(api, task.name, revision.number)
      expect(reused.status).toBe(200)
      expect(reused.body).toMatchObject({ id: ready.id, state: 'ready', sha256: ready.sha256 })

      // rebuild replaces a ready bundle; the new one is active, so even rebuild returns it now.
      const rebuilt = await createBundle(api, task.name, revision.number, { rebuild: true })
      expect(rebuilt.status).toBe(201)
      expect(rebuilt.body.id).not.toBe(ready.id)
      expect(['queued', 'running']).toContain(rebuilt.body.state)
      const active = await createBundle(api, task.name, revision.number, { rebuild: true })
      expect(active.status).toBe(200)
      expect(active.body.id).toBe(rebuilt.body.id)

      // A failed bundle is replaced.
      await setBundleFields(rebuilt.body.id, `{ state: 'failed', error: { code: 'bundleFailed', message: 'failed by the test' } }`)
      const failed = ok(await getBundle(api, task.name, revision.number), 'getRevisionBundle')
      expect(failed).toMatchObject({ id: rebuilt.body.id, state: 'failed', error: { code: 'bundleFailed', message: 'failed by the test' }, download: null })
      const afterFailure = await createBundle(api, task.name, revision.number)
      expect(afterFailure.status).toBe(201)
      expect(afterFailure.body.id).not.toBe(rebuilt.body.id)

      // An expired bundle is gone for getRevisionBundle and replaced by a create.
      await setBundleFields(afterFailure.body.id, '{ expiresAt: new Date(Date.now() - 60000) }')
      await expectNoBundle(api, task.name, revision.number)
      const afterExpiry = await createBundle(api, task.name, revision.number)
      expect(afterExpiry.status).toBe(201)
      expect(afterExpiry.body.id).not.toBe(afterFailure.body.id)
      expect(ok(await getBundle(api, task.name, revision.number), 'getRevisionBundle').id).toBe(afterExpiry.body.id)
    },
  )

  test(
    'unready revisions answer 409 revisionNotReady and privileged ones 409 bundleUnsupported',
    { tag: ['@BUNDLE-003'] },
    async ({ api, tasks, adminApi, freshApi, freshUser }) => {
      test.setTimeout(BUNDLE_TIMEOUT_MS)
      // A failed revision: renaming the task in the manifest fails the static checks without an image build.
      const name = unique('bundle-failed')
      tasks.track(name)
      ok(await uploadFiles(api, pythonTaskFiles(name)), 'uploadTask')
      ok(await writeTaskFiles(api, name, { 'scantor.yaml': `scantor: 1\nname: ${name}-renamed\nlanguage: python\n` }), 'writeTaskFiles')
      const failed = await publishAndWait(api, name, { expectState: 'failed' })
      const notReady = expectApiError(await createBundle(api, name, failed.number), 409, 'revisionNotReady')
      expect(notReady).toMatchObject({ state: 'failed' })
      await expectNoBundle(api, name, failed.number)

      // A privileged revision (the fresh user may run privileged tasks; it is purged at teardown).
      ok(await adminApi.call('updateUser', { path: { userId: freshUser.id }, body: { canRunPrivileged: true } }), 'updateUser')
      const dir = await exampleWithDefaults('echo', { privileged: true })
      try {
        const { task, revision } = await uploadAndPublish(freshApi, dir, unique('bundle-privileged'))
        expect(revision.privileged).toBe(true)
        const unsupported = expectApiError(await createBundle(freshApi, task.name, revision.number), 409, 'bundleUnsupported')
        expect(unsupported).toEqual({ reason: 'privileged' })
        await expectNoBundle(freshApi, task.name, revision.number)
      } finally {
        await removeDir(dir)
      }
    },
  )

  test(
    'a revision without a bundle answers 404, and another user’s revision is 404 on both routes',
    { tag: ['@BUNDLE-004'] },
    async ({ api, otherApi, tasks }) => {
      test.setTimeout(BUNDLE_TIMEOUT_MS)
      const { task, revision } = await tasks.example('echo')
      await expectNoBundle(api, task.name, revision.number)
      await expectNoBundle(api, task.name, revision.id)
      expectApiError(await createBundle(api, task.name, revision.number + 1), 404, 'notFound')

      // Another user: by task id and revision id, and by name (looked up among the caller's own tasks).
      for (const [taskRef, revisionRef] of [
        [task.id, revision.id],
        [task.id, revision.number],
        [task.name, revision.number],
      ] as const) {
        expectApiError(await createBundle(otherApi, taskRef, revisionRef), 404, 'notFound')
        expectApiError(await getBundle(otherApi, taskRef, revisionRef), 404, 'notFound')
      }
      // The other user's attempts created nothing.
      await expectNoBundle(api, task.name, revision.number)

      // Invalid queries are 400 and create nothing either.
      const badWait = await createBundle(api, task.name, revision.number, { wait: 999 })
      expectApiError(badWait, 400, 'validationFailed')
      expect(issuePaths(badWait)).toContain('wait')
      const badRebuild = await api.call('createRevisionBundle', { path: { task: task.name, revision: revision.number }, query: { rebuild: 'maybe' } })
      expectApiError(badRebuild, 400, 'validationFailed')
      expect(issuePaths(badRebuild)).toContain('rebuild')
      await expectNoBundle(api, task.name, revision.number)
    },
  )
})

test.describe('the revision image and the task', () => {
  test('a bundle is created after the master lost its local revision image', { tag: ['@BUNDLE-005'] }, async ({ api, tasks }) => {
    test.setTimeout(BUNDLE_TIMEOUT_MS)
    const { task, revision } = await tasks.example('echo')
    const repository = `localhost:${stackEnv().SCANTOR_REGISTRY_PORT || '5000'}/tasks/${task.id}`
    const tag = `${repository}:${revision.id}`
    // Remove the image with every name it has (the build tag and a digest reference of a pull), as the built-in
    // node's image GC or a manual prune would: the bundle step has to pull it from the registry by digest.
    const imageId = (await docker(['image', 'inspect', tag, '--format', '{{.Id}}'])).stdout.trim()
    await docker(['rmi', '--force', imageId])
    expect((await docker(['image', 'inspect', tag], { allowFailure: true })).exitCode, 'the local revision image is gone').not.toBe(0)

    const bundle: Bundle = await readyBundle(api, task.name, revision.number)
    expect(bundle).toMatchObject({
      state: 'ready',
      image: `localhost/scantor/${task.name}:${revision.number}`,
      platform: { os: 'linux', arch: revision.image!.platform.arch },
    })
    expect(bundle.bytes).toBeGreaterThan(0)
    expect((await docker(['image', 'inspect', `${repository}@${revision.image!.digest}`], { allowFailure: true })).exitCode, 'pulled by digest').toBe(0)
  })

  test('deleting the task removes the bundle object, so an issued download URL stops working', { tag: ['@BUNDLE-006'] }, async ({ api, tasks }) => {
    test.setTimeout(BUNDLE_TIMEOUT_MS)
    const { task, revision } = await tasks.example('echo')
    const bundle = await readyBundle(api, task.name, revision.number)
    const url = bundle.download!.url
    expect((await fetchArchive(url, { range: 'bytes=0-1' })).status).toBe(206)

    await deleteTaskAndWait(api, task.name)
    expect((await fetchArchive(url, { range: 'bytes=0-1' })).status, 'the issued URL of the deleted archive').toBe(404)
    expectApiError(await getBundle(api, task.id, revision.id), 404, 'notFound')
  })
})
