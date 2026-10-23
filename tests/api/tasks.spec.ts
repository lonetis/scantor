import type { Job } from '#shared/types/jobs'
import type { Revision } from '#shared/types/revisions'
import type { Task, UploadTaskResult } from '#shared/types/tasks'
import type { TestRun } from '#shared/types/test-runs'
import { ApiClient, ok } from '../helpers/api-client'
import { sharedTaskFixture, tenantFixture, type SharedTask } from '../helpers/api-tasks-fixtures'
import {
  archiveOf,
  byteSize,
  createTask,
  errorOf,
  getTaskWorkspace,
  ISO_DATE,
  issuePaths,
  listPaths,
  packSha256,
  pythonTaskFiles,
  readTarGz,
  readTaskFile,
  runInWorkspace,
  SHA256,
  sleepyTaskFiles,
  streamTaskUpload,
  tarGz,
  uploadFiles,
  waitForJob,
  waitForTestRunState,
  writeTaskFiles,
} from '../helpers/api-tasks-support'
import { docker as dockerCli, stackEnv } from '../helpers/docker'
import { waitForRevision } from '../helpers/tasks'
import { newApiContext } from '../helpers/users'
import { expect, test as base, unique, type TasksFixture } from '../fixtures'

// Tasks and uploads of task folders (docs/api.md §4.6, §5.3; docs/tasks.md §12–§13). Every task a test creates is
// registered with the tasks fixture (deleted at teardown); the caller's name space is the worker's tenant, so names
// come from unique(). Builds take one of the stack's few build slots: tests that only need some ready revision share
// one task per worker (`readyTask`), and only the deletion test builds a task of its own.

/** A task with a ready revision 1 whose analysis sleeps (task config `seconds`, default 600), shared per worker. */
interface ReadyTask extends SharedTask {
  files: Record<string, string>
  task: Task
  revision: Revision
}

const test = base.extend<object, { readyTask: ReadyTask }>({
  user: [tenantFixture('user'), { scope: 'worker', timeout: 180_000 }],
  otherUser: [tenantFixture('other'), { scope: 'worker', timeout: 180_000 }],
  readyTask: [
    sharedTaskFixture(async (api) => {
      const name = unique('ready')
      const files = sleepyTaskFiles(name)
      const uploaded = ok(await uploadFiles(api, files, { publish: true, wait: 120 }), 'uploadTask')
      const revision = await waitForRevision(api, uploaded.task.id, uploaded.revision!.id, 170_000)
      if (revision.state !== 'ready') throw new Error(`the shared task ${revision.ref} is ${revision.state}: ${JSON.stringify(revision.errors)}`)
      return { name, files, task: ok(await api.getTask(name), 'getTask'), revision }
    }),
    { scope: 'worker', timeout: 180_000 },
  ],
})

/** Uploads a file map (publish=false unless given) after registering its manifest name for cleanup. */
async function uploadNew(api: ApiClient, tasks: TasksFixture, name: string, files: Record<string, string>, query: Parameters<typeof uploadFiles>[2] = {}) {
  tasks.track(name)
  return uploadFiles(api, files, query)
}

/** Uploads and publishes a file map and waits until the revision is ready. */
async function uploadReady(api: ApiClient, tasks: TasksFixture, name: string, files: Record<string, string>): Promise<{ task: Task; revision: Revision }> {
  const uploaded = ok(await uploadNew(api, tasks, name, files, { publish: true, wait: 120 }), 'uploadTask')
  const revision = await waitForRevision(api, uploaded.task.id, uploaded.revision!.id, 150_000)
  expect(revision.state, JSON.stringify(revision.errors)).toBe('ready')
  return { task: ok(await api.getTask(name), 'getTask'), revision }
}

async function listNames(api: ApiClient, query: Record<string, string>): Promise<string[]> {
  return ok(await api.listTasks(query), 'listTasks').items.map((task) => task.name)
}

test.describe('create', () => {
  test('scaffolds the workspace from the single template by default', { tag: ['@TASK-001'] }, async ({ api, tasks, user }) => {
    const name = unique('create')
    tasks.track(name)
    const response = await createTask(api, { name, language: 'python', description: 'Created by the task API tests.' })
    expect(response.status).toBe(201)
    expect(response.body).toMatchObject({
      name,
      userId: user.id,
      language: 'python',
      description: 'Created by the task API tests.',
      source: { kind: 'scaffold', template: 'single' },
      revisionCount: 0,
      latestRevision: null,
      latestReadyRevision: null,
      privileged: false,
      workspace: { packSha256: expect.stringMatching(SHA256), dirty: true, lastSyncSha256: null, checkedAt: expect.stringMatching(ISO_DATE) },
    })
    expect(response.body.workspace.fileCount).toBeGreaterThan(3)
    expect(response.body.workspace.bytes).toBeGreaterThan(0)

    const paths = await listPaths(api, name)
    expect(paths).toEqual(expect.arrayContaining(['scantor.yaml', 'Dockerfile', 'main.py', 'AGENTS.md', '.dockerignore']))
    const manifest = ok(await readTaskFile(api, name, 'scantor.yaml'), 'readTaskFile').content
    expect(manifest).toMatch(new RegExp(`^name: ${name}$`, 'm'))
    expect(manifest).toMatch(/^language: python$/m)
    expect(ok(await api.getTask(name), 'getTask')).toEqual(response.body)
  })

  test('records an explicit template or custom as the source', { tag: ['@TASK-001'] }, async ({ api, tasks }) => {
    for (const template of ['range', 'custom']) {
      const name = unique(`tpl-${template}`)
      tasks.track(name)
      const created = ok(await createTask(api, { name, language: 'typescript', template }), 'createTask')
      expect(created.source).toEqual({ kind: 'scaffold', template })
      expect(await listPaths(api, name)).toEqual(expect.arrayContaining(['main.ts', 'package.json', 'tsconfig.json']))
    }
  })

  test('rejects reserved, uuid-shaped and malformed names', { tag: ['@TASK-002'] }, async ({ api, tasks }) => {
    const invalid = [
      'upload',
      'import-git',
      'new',
      'latest',
      '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11',
      'Echo',
      'echo_task',
      'echo.task',
      '-echo',
      'echo-',
      'ëcho',
      '',
      'a'.repeat(65),
    ]
    for (const name of invalid) {
      const response = await createTask(api, { name, language: 'python' })
      expect(response.status, JSON.stringify(name)).toBe(400)
      expect(errorOf(response).code, name).toBe('validationFailed')
      expect(issuePaths(response), name).toContain('name')
    }
    const reserved = await createTask(api, { name: 'latest', language: 'python' })
    expect(JSON.stringify(errorOf(reserved).details)).toContain('reserved')

    // The longest valid name has 64 characters.
    const longest = `${unique('max')}-${'a'.repeat(64)}`.slice(0, 64)
    tasks.track(longest)
    const created = await createTask(api, { name: longest, language: 'python' })
    expect(created.status).toBe(201)
    expect(created.body.name).toBe(longest)
  })

  test('rejects an unknown language or template', { tag: ['@TASK-003'] }, async ({ api }) => {
    const name = unique('unknown')
    const language = await createTask(api, { name, language: 'cobol' })
    expect(language.status).toBe(400)
    expect(errorOf(language).code).toBe('validationFailed')
    expect(issuePaths(language)).toEqual(['language'])

    for (const template of ['nosuchtemplate', 'Range', 'single!']) {
      const response = await createTask(api, { name, language: 'python', template })
      expect(response.status, template).toBe(400)
      expect(errorOf(response).code, template).toBe('validationFailed')
      expect(issuePaths(response), template).toEqual(['template'])
    }
    expect((await api.getTask(name)).status).toBe(404)
  })

  test('creates every language with every template and custom', { tag: ['@TASK-003'] }, async ({ api, tasks }) => {
    const scaffolds = ok(await api.call<{ items: { language: string; templates: string[] }[] }>('listScaffolds'), 'listScaffolds').items
    expect(scaffolds.map((s) => s.language).sort()).toEqual(['go', 'javascript', 'python', 'typescript'])
    const combinations = scaffolds.flatMap((s) => s.templates.map((template) => ({ language: s.language, template })))
    for (const s of scaffolds) expect(s.templates).toEqual(expect.arrayContaining(['single', 'list', 'range', 'repeat', 'tranco', 'crux', 'cidr', 'custom']))

    // Two at a time: every create runs workspace helpers, whose slots the whole suite shares.
    for (let index = 0; index < combinations.length; index += 2) {
      await Promise.all(
        combinations.slice(index, index + 2).map(async ({ language, template }) => {
          const name = unique(`${language.slice(0, 2)}-${template}`)
          tasks.track(name)
          const response = await createTask(api, { name, language, template })
          expect(response.status, `${language} × ${template}: ${JSON.stringify(response.body)}`).toBe(201)
          expect(response.body).toMatchObject({ language, source: { kind: 'scaffold', template } })
          expect(response.body.workspace.packSha256).toMatch(SHA256)
        }),
      )
    }
  })

  test('a taken name is 409 alreadyExists, while another user may own the same name', { tag: ['@TASK-004'] }, async ({ api, otherApi, tasks }) => {
    const name = unique('dup')
    tasks.track(name)
    ok(await createTask(api, { name, language: 'python' }), 'createTask')
    const again = await createTask(api, { name, language: 'go' })
    expect(again.status).toBe(409)
    expect(errorOf(again).code).toBe('alreadyExists')

    const other = await createTask(otherApi, { name, language: 'python' })
    try {
      expect(other.status).toBe(201)
      expect(other.body.name).toBe(name)
      expect(other.body.userId).not.toBe(ok(await api.getTask(name), 'getTask').userId)
    } finally {
      if (other.status === 201) ok(await otherApi.deleteTask(other.body.id), 'deleteTask')
    }
  })
})

test.describe('list and get', () => {
  test('lists the caller’s tasks newest first, filtered by q and language', { tag: ['@TASK-005'] }, async ({ api, otherApi, tasks }) => {
    const prefix = unique('list')
    const marker = unique('marker')
    const specs = [
      { name: `${prefix}-a`, language: 'python', description: 'first' },
      { name: `${prefix}-b`, language: 'go', description: `has the ${marker} in its description` },
      { name: `${prefix}-c`, language: 'javascript', description: 'third' },
    ]
    for (const spec of specs) {
      tasks.track(spec.name)
      ok(await createTask(api, spec), 'createTask')
    }

    expect(await listNames(api, { q: prefix })).toEqual([`${prefix}-c`, `${prefix}-b`, `${prefix}-a`])
    expect(await listNames(api, { q: prefix.toUpperCase() })).toEqual([`${prefix}-c`, `${prefix}-b`, `${prefix}-a`])
    expect(await listNames(api, { q: marker.toUpperCase() })).toEqual([`${prefix}-b`])
    expect(await listNames(api, { q: prefix, language: 'go' })).toEqual([`${prefix}-b`])
    expect(await listNames(api, { q: prefix, language: 'typescript' })).toEqual([])
    expect(await listNames(otherApi, { q: prefix })).toEqual([])

    const page = ok(await api.listTasks({ q: prefix, limit: 2 }), 'listTasks')
    expect(page.items.map((task) => task.name)).toEqual([`${prefix}-c`, `${prefix}-b`])
    expect(page.nextCursor).not.toBeNull()
  })

  test('accepts an id or a name and reports the workspace and the revisions', { tag: ['@TASK-006'] }, async ({ api, otherApi, readyTask }) => {
    const { name, revision } = readyTask
    const task = ok(await api.getTask(name), 'getTask')
    const pointer = { id: revision.id, number: 1, state: 'ready', packSha256: revision.source.packSha256, createdAt: revision.createdAt }
    expect(task).toMatchObject({
      name,
      language: 'python',
      source: { kind: 'upload' },
      workspace: {
        packSha256: revision.source.packSha256,
        fileCount: 4,
        bytes: expect.any(Number),
        dirty: false,
        lastSyncSha256: revision.source.packSha256,
        checkedAt: expect.stringMatching(ISO_DATE),
      },
      revisionCount: 1,
      latestRevision: pointer,
      latestReadyRevision: pointer,
      privileged: false,
    })
    expect(ok(await api.getTask(task.id), 'getTask')).toEqual(task)
    expect(ok(await api.getTask(task.id.toUpperCase()), 'getTask').id).toBe(task.id)

    for (const missing of [unique('missing'), '7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c']) {
      const response = await api.getTask(missing)
      expect(response.status, missing).toBe(404)
      expect(errorOf(response).code).toBe('notFound')
    }
    // Another user's task is not found by id or by name.
    expect((await otherApi.getTask(task.id)).status).toBe(404)
    expect((await otherApi.getTask(name)).status).toBe(404)
  })
})

test.describe('workspace status', () => {
  test('dirty turns true with an edit after a publish and false once that content is published', { tag: ['@TASK-007'] }, async ({ api, tasks }) => {
    const name = unique('dirty')
    const uploaded = ok(await uploadNew(api, tasks, name, pythonTaskFiles(name)), 'uploadTask')
    expect(uploaded.task.workspace.dirty).toBe(true)

    const first = ok(await api.publishRevision(name), 'publishRevision')
    expect(ok(await api.getTask(name), 'getTask').workspace.dirty).toBe(false)

    const edited = ok(await writeTaskFiles(api, name, { 'notes.txt': 'an edit after the publish\n' }), 'writeTaskFiles')
    expect(edited.workspace.dirty).toBe(true)
    expect(ok(await api.getTask(name), 'getTask').workspace).toMatchObject({ dirty: true, packSha256: edited.workspace.packSha256 })
    expect(ok(await getTaskWorkspace(api, name), 'getTaskWorkspace')).toMatchObject({ dirty: true, latestRevisionPackSha256: first.source.packSha256 })

    const second = ok(await api.publishRevision(name), 'publishRevision')
    expect(second.number).toBe(first.number + 1)
    expect(second.source.packSha256).toBe(edited.workspace.packSha256)
    const task = ok(await api.getTask(name), 'getTask')
    expect(task.workspace.dirty).toBe(false)
    expect(task.latestRevision).toMatchObject({ id: second.id, packSha256: edited.workspace.packSha256 })
  })

  test('getTaskWorkspace computes the hash fresh and refreshes the cached status', { tag: ['@TASK-008'] }, async ({ api, tasks, user }) => {
    const name = unique('fresh')
    const uploaded = ok(await uploadNew(api, tasks, name, pythonTaskFiles(name)), 'uploadTask')
    const synced = uploaded.task.workspace.packSha256!

    const status = ok(await getTaskWorkspace(api, name), 'getTaskWorkspace')
    expect(status).toEqual({
      packSha256: synced,
      fileCount: uploaded.task.workspace.fileCount,
      bytes: uploaded.task.workspace.bytes,
      dirty: true,
      latestRevisionPackSha256: null,
      lastSyncSha256: synced,
      checkedAt: expect.stringMatching(ISO_DATE),
    })

    // A change outside the API (as the editor makes it) leaves the cached status stale until the next fresh hash.
    await runInWorkspace(user.id, `printf 'x' > '/w/${name}/outside.txt'`)
    expect(ok(await api.getTask(name), 'getTask').workspace.packSha256).toBe(synced)

    const fresh = ok(await getTaskWorkspace(api, name), 'getTaskWorkspace')
    expect(fresh.packSha256).toMatch(SHA256)
    expect(fresh.packSha256).not.toBe(synced)
    expect(fresh).toMatchObject({ fileCount: status.fileCount + 1, dirty: true, latestRevisionPackSha256: null, lastSyncSha256: synced })
    expect(fresh.bytes).toBeGreaterThan(status.bytes)
    expect(Date.parse(fresh.checkedAt)).toBeGreaterThanOrEqual(Date.parse(status.checkedAt))

    const cached = ok(await api.getTask(name), 'getTask').workspace
    expect(cached).toEqual({ packSha256: fresh.packSha256, fileCount: fresh.fileCount, bytes: fresh.bytes, dirty: true, lastSyncSha256: synced, checkedAt: fresh.checkedAt })
  })

  test('the workspace archive is the deterministic pack of the workspace', { tag: ['@TASK-009'] }, async ({ api, tasks }) => {
    const name = unique('archive')
    const files = pythonTaskFiles(name, { extra: { 'lib/util.py': 'VALUE = 1\n' } })
    ok(await uploadNew(api, tasks, name, files), 'uploadTask')
    ok(await writeTaskFiles(api, name, { 'notes.txt': 'written through the API\n', '.scantor/cache.json': '{}\n' }), 'writeTaskFiles')
    const status = ok(await getTaskWorkspace(api, name), 'getTaskWorkspace')

    const download = await api.call('downloadTaskWorkspace', { path: { task: name } })
    expect(download.status).toBe(200)
    expect(download.headers['content-type']).toBe('application/gzip')
    expect(download.headers['content-disposition']).toBe(`attachment; filename="${name}.tar.gz"`)
    expect(packSha256(download.raw)).toBe(status.packSha256)

    const entries = await readTarGz(download.raw)
    const fileNames = entries.filter((entry) => entry.type === 'file').map((entry) => entry.name)
    expect(fileNames.sort()).toEqual([...Object.keys(files), 'notes.txt'].sort())
    expect(entries.find((entry) => entry.name === 'lib/util.py')?.content.toString('utf8')).toBe('VALUE = 1\n')

    const again = await api.call('downloadTaskWorkspace', { path: { task: name } })
    expect(packSha256(again.raw)).toBe(status.packSha256)
  })
})

test.describe('delete', () => {
  test('a deleted task disappears at once, keeps its name until its job removed everything', { tag: ['@TASK-010', '@TASK-012', '@TASK-005'] }, async ({
    api,
    docker,
    request,
    tasks,
  }) => {
    test.setTimeout(180_000)
    const name = unique('delete')
    const { task, revision } = await uploadReady(api, tasks, name, sleepyTaskFiles(name))
    const source = ok(await api.call<{ url: string }>('downloadRevisionSource', { path: { task: name, revision: 1 }, query: { redirect: false } }), 'downloadRevisionSource')

    // A running test run makes the deletion job wait before it removes anything, which keeps the deletion observable.
    const testRun = ok(await api.call<TestRun>('testTask', { path: { task: name }, body: { limit: 1 } }), 'testTask')
    await waitForTestRunState(api, testRun.id, ['building', 'running'])

    const deleted = await api.deleteTask(name)
    expect(deleted.status).toBe(202)
    expect(deleted.body.job).toMatchObject({ id: expect.any(String), kind: 'taskDelete' })

    for (const ref of [name, task.id]) expect((await api.getTask(ref)).status, ref).toBe(404)
    expect(await listNames(api, { q: name })).toEqual([])

    const recreate = await createTask(api, { name, language: 'python' })
    expect(recreate.status).toBe(409)
    expect(errorOf(recreate).code).toBe('alreadyExists')
    const reupload = await uploadFiles(api, pythonTaskFiles(name))
    expect(reupload.status).toBe(409)
    expect(errorOf(reupload).code).toBe('alreadyExists')
    expect(ok(await api.getJob(deleted.body.job.id), 'getJob').state, 'the deletion is still in progress').not.toBe('succeeded')

    const job: Job = await waitForJob(api, deleted.body.job.id, 120_000)
    expect(job).toMatchObject({ kind: 'taskDelete', state: 'succeeded', subject: { kind: 'task', id: task.id }, error: null })
    expect(job.progress.total).toBeGreaterThan(0)
    expect(job.progress.done).toBe(job.progress.total)

    // The running test run was stopped and deleted, the snapshot and the revisions are gone, and no image is left.
    expect((await api.call('getTestRun', { path: { testRunId: testRun.id } })).status).toBe(404)
    expect((await request.get(source.url)).status()).toBe(404)
    const counts = await docker.mongosh(
      `print(EJSON.stringify({ tasks: db.tasks.countDocuments({ _id: ${JSON.stringify(task.id)} }), revisions: db.revisions.countDocuments({ taskId: ${JSON.stringify(task.id)} }), testRuns: db.testRuns.countDocuments({ taskId: ${JSON.stringify(task.id)} }) }))`,
      { as: 'root' },
    )
    expect(JSON.parse(counts)).toEqual({ tasks: 0, revisions: 0, testRuns: 0 })
    // The revision image the build tagged locally is removed (the registry manifests are deleted in the same phase).
    expect(revision.image?.repository).toBe(`tasks/${task.id}`)
    const images = (await dockerCli(['images', '--format', '{{.Repository}}:{{.Tag}}'])).stdout
    expect(images).not.toContain(`tasks/${task.id}:${revision.id}`)

    // The name is free again, and the new task starts from a fresh scaffold.
    const reused = await createTask(api, { name, language: 'go' })
    expect(reused.status).toBe(201)
    expect(reused.body.id).not.toBe(task.id)
    expect(await listPaths(api, name)).toContain('main.go')
    expect(await listPaths(api, name)).not.toContain('main.py')
  })

  test('a task used by an active scan is 409 taskInUse', { tag: ['@TASK-011'] }, async ({ api, readyTask, scans }) => {
    test.setTimeout(180_000)
    const { name, revision } = readyTask
    const scan = await scans.start({ revision: revision.ref, taskConfig: { seconds: 600 } })

    const expectInUse = async (state: string) => {
      const response = await api.deleteTask(name)
      expect(response.status, state).toBe(409)
      expect(errorOf(response).code, state).toBe('taskInUse')
      expect(errorOf(response).details?.scanId, state).toBe(scan.id)
      expect((await api.getTask(name)).status, state).toBe(200)
    }

    await expectInUse(scan.state)
    await scans.wait(scan.id, { state: 'running', timeoutMs: 150_000 })
    await expectInUse('running')
    expect(ok(await api.call('pauseScan', { path: { scanId: scan.id } }), 'pauseScan')).toMatchObject({ state: 'paused' })
    await expectInUse('paused')

    // A scan being deleted still holds the task: its deletion job waits at least 10 s for in-flight results.
    ok(await api.cancelScan(scan.id), 'cancelScan')
    await scans.wait(scan.id, { state: 'cancelled', timeoutMs: 60_000 })
    expect((await api.deleteScan(scan.id)).status).toBe(202)
    expect(ok(await api.getScan(scan.id), 'getScan').state).toBe('deleting')
    await expectInUse('deleting')
  })
})

test.describe('upload', () => {
  test('creates the task named by the manifest and publishes the upload', { tag: ['@TASK-013'] }, async ({ api, tasks }) => {
    const name = unique('upload')
    tasks.track(name)
    const response = await api.uploadTask(await archiveOf(pythonTaskFiles(name)))
    expect(response.status).toBe(201)
    const body: UploadTaskResult = response.body
    expect(body.created).toBe(true)
    expect(body.task).toMatchObject({ name, language: 'python', description: 'A task of the task API tests.', source: { kind: 'upload' }, revisionCount: 1 })
    expect(body.revision).toMatchObject({ taskId: body.task.id, number: 1, ref: `${name}@1`, source: { kind: 'upload', packSha256: body.task.workspace.packSha256 } })
    expect(body.task.latestRevision?.id).toBe(body.revision!.id)

    const update = await api.uploadTask(await archiveOf(pythonTaskFiles(name, { text: 'second' })))
    expect(update.status).toBe(201)
    expect(update.body.created).toBe(false)
    expect(update.body.task.id).toBe(body.task.id)
    expect(update.body.revision).toMatchObject({ number: 2, source: { kind: 'upload' } })
  })

  test('publish=false only replaces the workspace; message and wait apply to the published revision', { tag: ['@TASK-014'] }, async ({ api, tasks }) => {
    const name = unique('nopublish')
    const response = await uploadNew(api, tasks, name, pythonTaskFiles(name), { publish: false })
    expect(response.status).toBe(201)
    expect(response.body).toMatchObject({ revision: null, created: true, task: { revisionCount: 0, latestRevision: null } })
    expect(ok(await getTaskWorkspace(api, name), 'getTaskWorkspace').packSha256).toBe(response.body.task.workspace.packSha256)

    // Without its entry file the revision fails its static check, which settles without an image build.
    const message = `published by the upload test ${unique('m')}`
    const { 'main.py': _entry, ...withoutEntry } = pythonTaskFiles(name, { text: 'published' })
    const started = Date.now()
    const published = await uploadFiles(api, withoutEntry, { publish: true, message, wait: 120 })
    expect(published.status).toBe(201)
    expect(published.headers['scantor-wait']).toBe('settled')
    expect(published.body.revision).toMatchObject({ number: 1, message, state: 'failed' })
    expect(published.body.revision!.errors.map((error) => error.phase)).toContain('static')
    expect(Date.now() - started).toBeLessThan(125_000)
    expect(ok(await api.getRevision(name, 1), 'getRevision').message).toBe(message)
  })

  test('accepts only gzip media types and caps the body size', { tag: ['@TASK-015'] }, async ({ api, openapi, tasks, user }) => {
    const name = unique('media')
    const archive = await archiveOf(pythonTaskFiles(name))
    for (const type of ['application/json', 'text/plain', 'application/octet-stream', 'application/zip']) {
      const response = await api.call('uploadTask', { body: archive, headers: { 'Content-Type': type }, query: { publish: false } })
      expect(response.status, type).toBe(415)
      expect(errorOf(response).code, type).toBe('unsupportedMediaType')
    }
    expect((await api.getTask(name)).status).toBe(404)
    tasks.track(name)
    const xgzip = await api.call<UploadTaskResult>('uploadTask', { body: archive, headers: { 'Content-Type': 'application/x-gzip' }, query: { publish: false } })
    expect(xgzip.status).toBe(201)

    // A body over the cap, as a declared length and while streaming without one. Each goes over a connection of its
    // own: the server answers before it read the body, so the connection is not reused.
    const limit = byteSize(stackEnv().SCANTOR_TASK_MAX_PACK_BYTES!)
    const oversized = await tarGz([{ name: 'big.bin', content: Buffer.alloc(limit + 1024 * 1024) }], { level: 0 })
    expect(oversized.length).toBeGreaterThan(limit)
    const context = await newApiContext({ headers: { Authorization: `Bearer ${user.apiKey}` } })
    try {
      const declared = await new ApiClient(context, openapi).call('uploadTask', {
        body: oversized,
        headers: { 'Content-Type': 'application/gzip' },
        query: { publish: false },
      })
      expect(declared.status).toBe(413)
      expect(errorOf(declared)).toMatchObject({ code: 'payloadTooLarge', details: { limit } })
    } finally {
      await context.dispose()
    }
    const streamed = await streamTaskUpload(user.apiKey, oversized)
    expect(streamed.status).toBe(413)
    expect(streamed.body).toMatchObject({ error: { code: 'payloadTooLarge', details: { limit } } })
    expect(ok(await getTaskWorkspace(api, name), 'getTaskWorkspace').packSha256).toBe(xgzip.body.task.workspace.packSha256)
  })

  test('an archive without a valid manifest is 422 manifestInvalid', { tag: ['@TASK-016'] }, async ({ api }) => {
    const name = unique('invalid')
    const files = pythonTaskFiles(name)
    const { 'scantor.yaml': _manifest, ...withoutManifest } = files
    const cases: [string, Record<string, string>, RegExp][] = [
      ['no scantor.yaml', withoutManifest, /scantor\.yaml/],
      ['scantor.yml instead', { ...withoutManifest, 'scantor.yml': files['scantor.yaml']! }, /scantor\.yaml/],
      ['an unknown key', { ...files, 'scantor.yaml': `${files['scantor.yaml']}unknownKey: true\n` }, /unknownKey/],
      ['invalid YAML', { ...files, 'scantor.yaml': 'scantor: 1\nname: [unclosed\n' }, /./],
      ['an unknown language', { ...files, 'scantor.yaml': `scantor: 1\nname: ${name}\nlanguage: cobol\n` }, /cobol|language/],
    ]
    for (const [label, tree, message] of cases) {
      const response = await uploadFiles(api, tree)
      expect(response.status, label).toBe(422)
      expect(errorOf(response).code, label).toBe('manifestInvalid')
      const errors = errorOf(response).details?.errors as { phase: string; file?: string; message: string }[]
      expect(errors.length, label).toBeGreaterThan(0)
      for (const error of errors) expect(error, label).toMatchObject({ phase: 'static', message: expect.any(String) })
      expect(errors.map((error) => `${error.file ?? ''} ${error.message}`).join('\n'), label).toMatch(message)
    }
    expect((await api.getTask(name)).status).toBe(404)
  })

  test('unpublished edits make an upload conflict until it is forced', { tag: ['@TASK-017'] }, async ({ api, tasks }) => {
    const name = unique('conflict')
    ok(await uploadNew(api, tasks, name, pythonTaskFiles(name)), 'uploadTask')
    const edited = ok(await writeTaskFiles(api, name, { 'edited.txt': 'an edit only the workspace has\n' }), 'writeTaskFiles')

    const replacement = pythonTaskFiles(name, { text: 'replacement' })
    const conflict = await uploadFiles(api, replacement)
    expect(conflict.status).toBe(409)
    expect(errorOf(conflict).code).toBe('workspaceDirty')
    expect(errorOf(conflict).details).toEqual({ current: edited.workspace.packSha256, uploaded: expect.stringMatching(SHA256) })
    expect(await listPaths(api, name)).toContain('edited.txt')
    expect(ok(await getTaskWorkspace(api, name), 'getTaskWorkspace').packSha256).toBe(edited.workspace.packSha256)

    const forced = await uploadFiles(api, replacement, { force: true })
    expect(forced.status).toBe(201)
    expect(forced.body.task.workspace.packSha256).toBe(errorOf(conflict).details?.uploaded)
    expect(await listPaths(api, name)).not.toContain('edited.txt')
    expect(ok(await readTaskFile(api, name, 'main.py'), 'readTaskFile').content).toContain('"replacement"')
  })

  test('uploads never conflict with synced, published or identical content', { tag: ['@TASK-018'] }, async ({ api, tasks }) => {
    const name = unique('sync')
    const first = ok(await uploadNew(api, tasks, name, pythonTaskFiles(name)), 'uploadTask')
    expect(first.task.workspace.lastSyncSha256).toBe(first.task.workspace.packSha256)

    // Unchanged since the last upload: the next upload replaces it and becomes the new sync point.
    const v2 = pythonTaskFiles(name, { text: 'v2' })
    const second = ok(await uploadFiles(api, v2), 'uploadTask')
    expect(second.task.workspace.packSha256).not.toBe(first.task.workspace.packSha256)
    expect(second.task.workspace.lastSyncSha256).toBe(second.task.workspace.packSha256)
    expect(ok(await uploadFiles(api, v2), 'uploadTask').task.workspace.packSha256).toBe(second.task.workspace.packSha256)

    // An edit makes the workspace differ from the sync point, but uploading exactly that content is no conflict.
    const edit = { 'edit.txt': 'edited in the workspace\n' }
    const edited = ok(await writeTaskFiles(api, name, edit), 'writeTaskFiles')
    expect(ok(await api.getTask(name), 'getTask').workspace.lastSyncSha256).toBe(second.task.workspace.packSha256)
    const identical = ok(await uploadFiles(api, { ...v2, ...edit }), 'uploadTask')
    expect(identical.task.workspace).toMatchObject({ packSha256: edited.workspace.packSha256, lastSyncSha256: edited.workspace.packSha256 })

    // Published content is no conflict either.
    const published = ok(await writeTaskFiles(api, name, { 'edit.txt': 'edited and published\n' }), 'writeTaskFiles')
    ok(await api.publishRevision(name), 'publishRevision')
    expect(ok(await api.getTask(name), 'getTask').latestRevision?.packSha256).toBe(published.workspace.packSha256)
    const v3 = ok(await uploadFiles(api, pythonTaskFiles(name, { text: 'v3' })), 'uploadTask')
    expect(v3.task.workspace.packSha256).not.toBe(published.workspace.packSha256)
    expect(v3.task.workspace.lastSyncSha256).toBe(v3.task.workspace.packSha256)
  })

  test('content identical to an existing revision returns that revision', { tag: ['@TASK-019'] }, async ({ api, readyTask, tasks }) => {
    // A ready revision.
    const again = ok(await uploadFiles(api, readyTask.files, { publish: true }), 'uploadTask')
    expect(again.created).toBe(false)
    expect(again.revision).toMatchObject({ id: readyTask.revision.id, number: 1, state: 'ready' })
    expect(again.task).toMatchObject({ revisionCount: 1, latestRevision: { id: readyTask.revision.id } })

    // A queued or building revision (its build is stopped when the task is deleted at teardown).
    const name = unique('dedupe')
    const files = pythonTaskFiles(name)
    const first = ok(await uploadNew(api, tasks, name, files, { publish: true }), 'uploadTask').revision!
    expect(first.number).toBe(1)
    expect(['queued', 'building']).toContain(first.state)
    const queued = ok(await uploadFiles(api, files, { publish: true }), 'uploadTask')
    expect(queued.created).toBe(false)
    expect(queued.revision).toMatchObject({ id: first.id, number: 1 })
    expect(queued.task).toMatchObject({ revisionCount: 1, latestRevision: { id: first.id } })
  })
})
