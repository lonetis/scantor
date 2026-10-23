import type { BuildLogLine, Revision, RevisionSummary } from '#shared/types/revisions'
import { ok, type ApiClient } from '../helpers/api-client'
import { sharedTaskFixture, tenantFixture, type SharedTask } from '../helpers/api-tasks-fixtures'
import {
  errorOf,
  getBuildLog,
  getTaskWorkspace,
  ISO_DATE,
  issuePaths,
  listRevisions,
  packSha256,
  pythonTaskFiles,
  readTarGz,
  readTaskFile,
  SHA256,
  uploadFiles,
  writeTaskFiles,
} from '../helpers/api-tasks-support'
import { waitForRevision } from '../helpers/tasks'
import { expect, test as base, unique, type TasksFixture } from '../fixtures'

// Revisions (docs/api.md §4.10, docs/tasks.md §9.8, §10): publishing snapshots the workspace at the request,
// de-duplicates by pack hash and numbers revisions without reuse; ready and failed revisions, their summaries, build
// logs and stored sources. Tests publish small Python tasks of their own (unique names, deleted at teardown); the
// read-only tests share one task per worker (`revisions`) with a ready revision 1 and a failed revision 2. Failures
// that need no image build use a manifest renaming the task (a static error).

/** A manifest that renames the task: a fast static failure. */
const renamedManifest = (name: string) => `scantor: 1\nname: ${name}-renamed\nlanguage: python\n`

/** Publishes the workspace and waits until the revision is ready or failed. */
async function publishSettled(api: ApiClient, task: string, message?: string): Promise<Revision> {
  const published = ok(await api.publishRevision(task, { message }), 'publishRevision')
  return waitForRevision(api, task, published.id, 150_000)
}

/** The worker's task with a ready revision 1 and a failed revision 2. */
interface RevisionsTask extends SharedTask {
  files: Record<string, string>
  ready: Revision
  failed: Revision
}

const test = base.extend<object, { revisions: RevisionsTask }>({
  user: [tenantFixture('user'), { scope: 'worker', timeout: 180_000 }],
  revisions: [
    sharedTaskFixture(async (api) => {
      const name = unique('revs')
      const files = pythonTaskFiles(name)
      ok(await uploadFiles(api, files), 'uploadTask')
      const ready = await publishSettled(api, name, 'ready one')
      if (ready.state !== 'ready') throw new Error(`${ready.ref} is ${ready.state}: ${JSON.stringify(ready.errors)}`)
      ok(await writeTaskFiles(api, name, { 'scantor.yaml': renamedManifest(name) }), 'writeTaskFiles')
      const failed = await publishSettled(api, name, 'failing one')
      if (failed.state !== 'failed') throw new Error(`${failed.ref} is ${failed.state}, expected failed`)
      return { name, files, ready, failed }
    }),
    { scope: 'worker', timeout: 180_000 },
  ],
})

/** Uploads a task folder without publishing, under a tracked unique name. */
async function newTask(api: ApiClient, tasks: TasksFixture, prefix: string, options: Parameters<typeof pythonTaskFiles>[1] = {}) {
  const name = unique(prefix)
  tasks.track(name)
  const files = pythonTaskFiles(name, options)
  const uploaded = ok(await uploadFiles(api, files), 'uploadTask')
  return { name, files, task: uploaded.task }
}

test.describe('publish', () => {
  test('snapshots the workspace at the request and numbers the revision', { tag: ['@REV-001', '@REV-006'] }, async ({ api, tasks }) => {
    test.setTimeout(180_000)
    const { name, files, task } = await newTask(api, tasks, 'publish')
    const message = 'the first revision'
    const response = await api.publishRevision(name, { message })
    expect(response.status).toBe(201)
    const revision = response.body
    expect(revision).toMatchObject({
      id: expect.any(String),
      userId: task.userId,
      taskId: task.id,
      taskName: name,
      number: 1,
      ref: `${name}@1`,
      state: 'queued',
      message,
      source: { kind: 'workspace', packSha256: task.workspace.packSha256, fileCount: 4 },
      image: null,
      errors: [],
      privileged: false,
      createdAt: expect.stringMatching(ISO_DATE),
    })
    expect(revision.source.packBytes).toBeGreaterThan(0)

    // An edit right after the request does not reach the build: it uses the snapshot taken by the request.
    const edited = ok(await writeTaskFiles(api, name, { 'main.py': files['main.py']!.replace('"hello"', '"edited"') }), 'writeTaskFiles')
    // wait holds the unsettled revision until its build is done.
    const waited = await api.getRevision(name, revision.number, 120)
    expect(waited.status).toBe(200)
    expect(waited.headers['scantor-wait']).toBe('settled')
    const built = waited.body
    expect(built.state, JSON.stringify(built.errors)).toBe('ready')
    expect(built.source.packSha256).toBe(task.workspace.packSha256)
    expect(built.source.packSha256).not.toBe(edited.workspace.packSha256)
    expect(ok(await readTaskFile(api, name, 'main.py', 1), 'readTaskFile').content).toBe(files['main.py'])
    expect(built.description?.schemas.taskConfig).toMatchObject({ properties: { text: { default: 'hello' } } })

    const second = ok(await api.publishRevision(name), 'publishRevision')
    expect(second).toMatchObject({ number: 2, ref: `${name}@2`, source: { packSha256: edited.workspace.packSha256 } })
    expect(ok(await api.getTask(name), 'getTask')).toMatchObject({ revisionCount: 2, latestRevision: { id: second.id, number: 2 } })
  })

  test('identical content returns its revision; failed builds consume numbers and are rebuilt', { tag: ['@REV-002', '@REV-001'] }, async ({ api, tasks }) => {
    test.setTimeout(180_000)
    const { name, files } = await newTask(api, tasks, 'dedupe')
    const first = ok(await api.publishRevision(name), 'publishRevision')
    const repeated = await api.publishRevision(name)
    expect(repeated.status).toBe(201)
    expect(repeated.body).toMatchObject({ id: first.id, number: 1 })
    expect(ok(await api.getTask(name), 'getTask').revisionCount).toBe(1)
    expect((await waitForRevision(api, name, first.id, 150_000)).state).toBe('ready')
    expect(ok(await api.publishRevision(name), 'publishRevision')).toMatchObject({ id: first.id, number: 1, state: 'ready' })

    // A failed revision does not de-duplicate: publishing the same content again builds a new number.
    ok(await writeTaskFiles(api, name, { 'scantor.yaml': renamedManifest(name) }), 'writeTaskFiles')
    const failed = await publishSettled(api, name)
    expect(failed).toMatchObject({ number: 2, state: 'failed' })
    const retried = await publishSettled(api, name)
    expect(retried).toMatchObject({ number: 3, state: 'failed', source: { packSha256: failed.source.packSha256 } })
    expect(retried.id).not.toBe(failed.id)

    // Restoring the first content returns the first revision; new content takes the next number, never a used one
    // (it renames the task again, so it fails without an image build).
    ok(await writeTaskFiles(api, name, { 'scantor.yaml': files['scantor.yaml']! }), 'writeTaskFiles')
    expect(ok(await api.publishRevision(name), 'publishRevision')).toMatchObject({ id: first.id, number: 1 })
    ok(await writeTaskFiles(api, name, { 'notes.txt': 'new content\n', 'scantor.yaml': renamedManifest(name) }), 'writeTaskFiles')
    expect(ok(await api.publishRevision(name), 'publishRevision').number).toBe(4)
    const numbers = ok(await listRevisions(api, name), 'listRevisions').items.map((item) => item.number)
    expect(numbers).toEqual([4, 3, 2, 1])
  })
})

test.describe('ready and failed revisions', () => {
  test('a ready revision carries its image, description, settings and manifest', { tag: ['@REV-003', '@REV-009'] }, async ({ api, tasks }) => {
    test.setTimeout(180_000)
    const { task, revision } = await tasks.fixture('schema-zoo')
    const ready = ok(await api.getRevision(task.name, revision.number), 'getRevision')
    expect(ready).toMatchObject({
      state: 'ready',
      errors: [],
      privileged: false,
      language: 'python',
      manifest: { scantor: 1, name: task.name, language: 'python' },
      image: { repository: `tasks/${task.id}`, tag: revision.id, digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), platform: { os: 'linux' } },
      baseImage: { ref: expect.stringContaining('scantor-base-python'), digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
      settingsDefaults: { workers: expect.any(Number), processes: expect.any(Number), timeoutMs: expect.any(Number), maxAttempts: expect.any(Number), privileged: false },
      startedAt: expect.stringMatching(ISO_DATE),
      finishedAt: expect.stringMatching(ISO_DATE),
    })
    expect(ready.image!.bytes).toBeGreaterThan(0)
    expect(ready.image!.platform.arch).toMatch(/^(amd64|arm64)$/)

    const description = ready.description!
    expect(Object.keys(description).sort()).toEqual(['connector', 'fileRefPaths', 'protocolVersion', 'schedule', 'schemas', 'secretPaths', 'uploadPaths', 'warnings'])
    expect(Object.keys(description.schemas).sort()).toEqual(['analysisConfig', 'result', 'scanConfig', 'taskConfig'])
    expect(description.schedule).toEqual({ kind: 'template', template: 'single' })
    expect(description.secretPaths.taskConfig).toEqual(['/api_token'])
    expect(description.uploadPaths.taskConfig).toEqual(['/wordlist'])
    expect(description.fileRefPaths).toEqual(['/report'])
    expect(Array.isArray(description.warnings)).toBe(true)
    // The described schema keeps the order in which the task declares its fields.
    expect(Object.keys(description.schemas.taskConfig.properties as Record<string, unknown>)).toEqual([
      'text',
      'count',
      'ratio',
      'step',
      'enabled',
      'level',
      'note',
      'tags',
      'weights',
      'address',
      'notify',
      'api_token',
      'wordlist',
    ])
  })

  test('a failed revision has its errors with phase, file and line, and a build log', { tag: ['@REV-004'] }, async ({ api, tasks }) => {
    test.setTimeout(180_000)
    const { name, files } = await newTask(api, tasks, 'failed')
    const cases: { phase: string; change: Record<string, string>; file?: string; line?: number; message: RegExp }[] = [
      { phase: 'static', change: { 'scantor.yaml': renamedManifest(name) }, file: 'scantor.yaml', line: 2, message: /task names are immutable/ },
      { phase: 'build', change: { Dockerfile: `${files.Dockerfile}RUN exit 3\n` }, message: /exit code: 3|exit 3/ },
      { phase: 'describe', change: { 'main.py': `raise RuntimeError("broken at import")\n${files['main.py']}` }, message: /broken at import/ },
      {
        phase: 'check',
        change: { 'main.py': files['main.py']!.replace('return Result(echo=task_config.text)', 'return Result(echo=len(task_config.text))') },
        file: 'main.py',
        line: 17,
        message: /int.*str|str.*int/,
      },
    ]
    // Each publish snapshots the workspace at the request, so the four revisions are published one after the other
    // and then build side by side.
    const published = []
    for (const failure of cases) {
      ok(await writeTaskFiles(api, name, { ...files, ...failure.change }), 'writeTaskFiles')
      published.push(ok(await api.publishRevision(name), 'publishRevision'))
    }
    const settled = await Promise.all(published.map((revision) => waitForRevision(api, name, revision.id, 150_000)))
    for (const [index, failure] of cases.entries()) {
      const revision = settled[index]!
      expect(revision, failure.phase).toMatchObject({ number: index + 1, state: 'failed', image: null })
      expect(revision.errors.length, failure.phase).toBeGreaterThan(0)
      const error = revision.errors.find((e) => e.phase === failure.phase)
      expect(error, `${failure.phase}: ${JSON.stringify(revision.errors)}`).toBeDefined()
      expect(error!.message, failure.phase).toMatch(failure.message)
      if (failure.file) expect(error, failure.phase).toMatchObject({ file: failure.file, line: failure.line })
      if (failure.phase === 'check') expect(error!.column, failure.phase).toBeGreaterThan(0)
      for (const e of revision.errors) expect(['static', 'build', 'describe', 'check'], JSON.stringify(e)).toContain(e.phase)

      const log = ok(await getBuildLog(api, name, revision.number, { limit: 5000 }), 'getRevisionBuildLog')
      expect(log.complete, failure.phase).toBe(true)
      expect(log.lines.some((line) => line.type === 'error' && line.error?.phase === failure.phase), failure.phase).toBe(true)
      const result = log.lines.at(-1)!
      expect(result, failure.phase).toMatchObject({ type: 'result', result: { ok: false } })
    }
  })
})

test.describe('list and get', () => {
  test('lists summaries by number descending and filters by state', { tag: ['@REV-005'] }, async ({ api, revisions }) => {
    const { name, ready, failed } = revisions
    const summary = (revision: Revision): RevisionSummary => ({
      id: revision.id,
      number: revision.number,
      ref: revision.ref,
      state: revision.state,
      source: { kind: revision.source.kind, packSha256: revision.source.packSha256 },
      privileged: revision.privileged,
      errorsCount: revision.errors.length,
      createdAt: revision.createdAt,
      finishedAt: revision.finishedAt ?? null,
    })

    const all = ok(await listRevisions(api, name), 'listRevisions')
    expect(all).toEqual({ items: [summary(failed), summary(ready)], nextCursor: null })
    expect(all.items[0]!.errorsCount).toBeGreaterThan(0)
    expect(all.items[1]).toMatchObject({ state: 'ready', errorsCount: 0, source: { kind: 'workspace', packSha256: expect.stringMatching(SHA256) } })

    expect(ok(await listRevisions(api, name, { state: 'ready' }), 'listRevisions').items.map((item) => item.number)).toEqual([1])
    expect(ok(await listRevisions(api, name, { state: 'failed' }), 'listRevisions').items.map((item) => item.number)).toEqual([2])
    expect(ok(await listRevisions(api, name, { state: 'building' }), 'listRevisions').items).toEqual([])

    const first = ok(await listRevisions(api, name, { limit: 1 }), 'listRevisions')
    expect(first.items.map((item) => item.number)).toEqual([2])
    expect(first.nextCursor).not.toBeNull()
    const next = ok(await listRevisions(api, name, { limit: 1, cursor: first.nextCursor! }), 'listRevisions')
    expect(next).toEqual({ items: [summary(ready)], nextCursor: null })

    const invalid = await listRevisions(api, name, { state: 'done' })
    expect(invalid.status).toBe(400)
    expect(issuePaths(invalid)).toContain('state')
  })

  test('getRevision accepts a number, latest or an id and can wait', { tag: ['@REV-006'] }, async ({ api, revisions, tasks }) => {
    const { name, ready, failed } = revisions
    for (const ref of [1, 'latest', ready.id, ready.id.toUpperCase()]) {
      const response = await api.getRevision(name, ref)
      expect(response.status, String(ref)).toBe(200)
      expect(response.body.id, String(ref)).toBe(ready.id)
      expect(response.headers['scantor-wait'], String(ref)).toBeUndefined()
    }
    expect(ok(await api.getRevision(name, 2), 'getRevision')).toMatchObject({ id: failed.id, state: 'failed' })
    expect(ok(await api.getRevision(name, failed.id), 'getRevision').number).toBe(2)

    const other = await newTask(api, tasks, 'other')
    expect((await api.getRevision(other.name, 'latest')).status, 'latest without any revision').toBe(404)
    ok(await writeTaskFiles(api, other.name, { 'scantor.yaml': renamedManifest(other.name) }), 'writeTaskFiles')
    const onlyFailed = await publishSettled(api, other.name)
    expect(onlyFailed.state).toBe('failed')
    const notFound: [string, string | number][] = [
      ['latest with only a failed revision', 'latest'],
      ['an unknown number', 3],
      ['an unknown id', '7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c'],
    ]
    for (const [label, ref] of notFound) {
      const response = await api.getRevision(other.name, ref)
      expect(response.status, label).toBe(404)
      expect(errorOf(response).code, label).toBe('notFound')
    }
    // The id of another task's revision is not found under this task.
    expect((await api.getRevision(other.name, ready.id)).status).toBe(404)
    expect((await api.getRevision(name, onlyFailed.id)).status).toBe(404)

    // wait returns at once for a settled revision (the publish test waits for an unsettled one).
    const started = Date.now()
    const settled = await api.getRevision(name, 1, 30)
    expect(settled.headers['scantor-wait']).toBe('settled')
    expect(settled.body.id).toBe(ready.id)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test('build logs page by line, end with the result and follow a running build', { tag: ['@REV-007'] }, async ({ api, tasks }) => {
    test.setTimeout(180_000)
    const { name } = await newTask(api, tasks, 'logs')
    const revision = ok(await api.publishRevision(name), 'publishRevision')

    const lines: BuildLogLine[] = []
    let afterLine = 0
    let sawRunning = false
    const deadline = Date.now() + 150_000
    for (;;) {
      const page = ok(await getBuildLog(api, name, revision.number, { afterLine, limit: 3 }), 'getRevisionBuildLog')
      expect(page.lines.length).toBeLessThanOrEqual(3)
      lines.push(...page.lines)
      expect(page.nextLine).toBe(page.lines.at(-1)?.line ?? afterLine)
      afterLine = page.nextLine
      if (page.complete) break
      if (page.lines.length === 0) sawRunning = true
      if (Date.now() > deadline) throw new Error(`the build log of ${revision.ref} is not complete after 150 s (${lines.length} lines)`)
      // An empty page means the build is still running: poll again shortly.
      if (page.lines.length === 0) await new Promise((resolve) => setTimeout(resolve, 500))
    }
    expect(sawRunning || lines.length > 3, 'the log was read while the build was running').toBe(true)

    expect(lines.map((line) => line.line)).toEqual(Array.from({ length: lines.length }, (_, i) => i + 1))
    for (const line of lines) {
      expect(line.at).toMatch(ISO_DATE)
      expect(['pack', 'static', 'build', 'describe', 'check', 'push', 'platform']).toContain(line.phase)
      if (line.type === 'log') expect(line, JSON.stringify(line)).toMatchObject({ stream: expect.any(String), level: expect.stringMatching(/^(info|warning)$/), text: expect.any(String) })
    }
    const last = lines.at(-1)!
    expect(last).toMatchObject({ type: 'result', result: { ok: true } })
    expect(lines.filter((line) => line.type === 'result')).toHaveLength(1)
    expect((await waitForRevision(api, name, revision.id, 30_000)).state).toBe('ready')

    const whole = ok(await getBuildLog(api, name, revision.number), 'getRevisionBuildLog')
    expect(whole).toEqual({ lines, nextLine: last.line, complete: true })
    expect(ok(await getBuildLog(api, name, 'latest', { afterLine: last.line }), 'getRevisionBuildLog')).toEqual({ lines: [], nextLine: last.line, complete: true })
    expect(ok(await getBuildLog(api, name, revision.id, { afterLine: 1, limit: 2 }), 'getRevisionBuildLog')).toEqual({ lines: lines.slice(1, 3), nextLine: 3, complete: false })

    expect((await getBuildLog(api, name, 1, { limit: 5000 })).status).toBe(200)
    for (const limit of [5001, 0]) {
      const response = await getBuildLog(api, name, 1, { limit })
      expect(response.status, String(limit)).toBe(400)
      expect(errorOf(response).code).toBe('validationFailed')
      expect(issuePaths(response)).toContain('limit')
    }
  })

  test('the source download is the stored snapshot as a gzip attachment', { tag: ['@REV-008'] }, async ({ api, request, revisions }) => {
    const { name, files, ready } = revisions
    const redirect = await api.call('downloadRevisionSource', { path: { task: name, revision: ready.number } })
    expect(redirect.status).toBe(302)
    const location = redirect.headers.location!
    expect(location).toMatch(/^https:\/\//)

    const download = await request.get(location, { headers: {} })
    expect(download.status()).toBe(200)
    expect(download.headers()['content-type']).toBe('application/gzip')
    expect(download.headers()['content-disposition']).toMatch(new RegExp(`^attachment;.*${name}-1\\.tar\\.gz`))
    const body = await download.body()
    expect(packSha256(body)).toBe(ready.source.packSha256)
    const entries = (await readTarGz(body)).filter((entry) => entry.type === 'file')
    expect(entries.map((entry) => entry.name).sort()).toEqual(Object.keys(files).sort())
    expect(entries.find((entry) => entry.name === 'scantor.yaml')?.content.toString('utf8')).toBe(files['scantor.yaml'])

    const json = await api.call<{ url: string; expiresAt: string }>('downloadRevisionSource', { path: { task: name, revision: ready.id }, query: { redirect: false } })
    expect(json.status).toBe(200)
    expect(Object.keys(json.body).sort()).toEqual(['expiresAt', 'url'])
    expect(json.body.expiresAt).toMatch(ISO_DATE)
    expect(Date.parse(json.body.expiresAt)).toBeGreaterThan(Date.now())
    const again = await request.get(json.body.url)
    expect(again.status()).toBe(200)
    expect(packSha256(await again.body())).toBe(ready.source.packSha256)
    // The workspace has moved on (it renames the task, revision 2); the snapshot has not.
    expect(ok(await getTaskWorkspace(api, name), 'getTaskWorkspace').packSha256).toBe(revisions.failed.source.packSha256)
  })

  test('described schemas keep the property order of the source', { tag: ['@REV-009'] }, async ({ api, tasks }) => {
    test.setTimeout(180_000)
    const { task, revision } = await tasks.example('power')
    const described = ok(await api.getRevision(task.name, revision.id), 'getRevision').description!
    expect(Object.keys(described.schemas.scanConfig.properties as Record<string, unknown>)).toEqual(['start', 'end', 'onlyOdd'])
    expect(Object.keys(described.schemas.taskConfig.properties as Record<string, unknown>)).toEqual(['exponent', 'report'])
    expect(Object.keys(described.schemas.result.properties as Record<string, unknown>)).toEqual(['base', 'power', 'report'])
  })
})
