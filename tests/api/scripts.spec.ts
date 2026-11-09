import type { JobAccepted, Page } from '#shared/types/common'
import type { Script } from '#shared/types/scripts'
import { ok, type ApiClient } from '../helpers/api-client'
import { createTask, errorOf, ISO_DATE, listTaskFiles, packSha256, readTarGz, SHA256, sha256, waitForJob } from '../helpers/api-tasks-support'
import {
  cancelScriptRun,
  createScript,
  deleteScriptFile,
  editScriptManifest,
  fixtureScriptDir,
  getScript,
  getScriptRun,
  imageExists,
  listScriptFiles,
  probeScriptFiles,
  probeWaiting,
  readScriptFile,
  readScriptFiles,
  renameScript,
  scriptArchive,
  scriptFileText,
  SCRIPT_MANIFEST,
  scriptImageRef,
  scriptManifestValue,
  scriptsTest,
  startRun,
  uploadScript,
  waitForScriptRun,
  waitForScriptRunContainerGone,
  waitForScriptRunLog,
  writeScriptFiles,
} from '../helpers/scripts'
import { expect, test as base, unique } from '../fixtures'

// Scripts (docs/scripts.md, docs/api.md tags `scripts` and `script-files`): creating a script from the scaffold,
// listing and reading scripts, uploading script folders with the workspaceDirty rule, the file routes on the folder
// .scripts/<name>/, the workspace archive and the deletion cascade. Runs are in script-runs.spec.ts; only the deletion
// test starts one (the probe script waiting on the worker's files scan).

const test = scriptsTest(base)

test.describe.configure({ timeout: 180_000 })

const FILES_REPORT = fixtureScriptDir('files-report')

test.describe('creating and reading scripts', () => {
  test(
    'createScript renders the scaffold; names are unique among the owner’s scripts and validated',
    { tag: ['@SCRIPT-001'] },
    async ({ api, user, scripts, tasks }) => {
      const name = unique('scaffold')
      const script = await scripts.create({ name, description: 'Counts the analyses of a scan.' })
      expect(script).toMatchObject({
        userId: user.id,
        name,
        language: 'python',
        description: 'Counts the analyses of a scan.',
        source: { kind: 'scaffold' },
        describe: null,
        latestRun: null,
        recentRuns: [],
      })
      expect(script.workspace.packSha256).toMatch(SHA256)
      expect(script.workspace.fileCount).toBeGreaterThanOrEqual(5)
      expect(script.workspace.checkedAt).toMatch(ISO_DATE)

      const paths = ok(await listScriptFiles(api, name), 'listScriptFiles').entries.map((entry) => entry.path)
      expect(paths).toEqual(expect.arrayContaining([SCRIPT_MANIFEST, 'Dockerfile', 'main.py', 'models.py', 'requirements.txt']))
      const manifest = ok(await readScriptFile(api, name, SCRIPT_MANIFEST), 'readScriptFile').content
      expect(manifest).toMatch(new RegExp(`^name: ${name}$`, 'm'))
      expect(manifest).toMatch(/^language: python$/m)
      expect(manifest).toContain('Counts the analyses of a scan.')
      expect(ok(await readScriptFile(api, name, 'main.py'), 'readScriptFile').content).toContain('script = Script(')

      const taken = await createScript(api, { name })
      expect(taken.status).toBe(409)
      expect(errorOf(taken).code).toBe('alreadyExists')
      for (const invalid of ['upload', 'latest', '0f8fad5b-d9cb-469f-a165-70867728950e', 'Not_A_Slug', '-dash', 'x'.repeat(65)]) {
        const response = await createScript(api, { name: invalid })
        expect(response.status, invalid).toBe(400)
        expect(errorOf(response).code, invalid).toBe('validationFailed')
      }

      // Tasks and scripts live in different folders, so a task may have the script's name.
      tasks.track(name)
      ok(await createTask(api, { name, language: 'python' }), 'createTask')
      const taskPaths = ok(await listTaskFiles(api, name), 'listTaskFiles').entries.map((entry) => entry.path)
      expect(taskPaths).toContain('scantor.yaml')
      expect(taskPaths).not.toContain(SCRIPT_MANIFEST)
      expect(ok(await getScript(api, name), 'getScript').id).toBe(script.id)
    },
  )

  test('listScripts and getScript find the caller’s own scripts by id or name', { tag: ['@SCRIPT-002'] }, async ({ api, otherApi, scripts }) => {
    const marker = unique('marker')
    const first = await scripts.create({ description: `first ${marker}` })
    const second = await scripts.create({ description: 'second without the marker' })

    const all = ok(await api.call<Page<Script>>('listScripts', { query: { limit: 200 } }), 'listScripts')
    const ids = all.items.map((script) => script.id)
    expect(ids).toEqual(expect.arrayContaining([first.id, second.id]))
    // Newest first.
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id))
    const filtered = ok(await api.call<Page<Script>>('listScripts', { query: { q: marker } }), 'listScripts')
    expect(filtered.items.map((script) => script.id)).toEqual([first.id])
    const byName = ok(await api.call<Page<Script>>('listScripts', { query: { q: second.name } }), 'listScripts')
    expect(byName.items.map((script) => script.id)).toEqual([second.id])

    const byId = ok(await getScript(api, first.id), 'getScript')
    expect(byId).toEqual(ok(await getScript(api, first.name), 'getScript'))
    expect(byId).toMatchObject({ id: first.id, name: first.name, latestRun: null, recentRuns: [] })
    expect((await getScript(api, unique('missing'))).status).toBe(404)

    // Another user sees nothing of them.
    for (const ref of [first.id, first.name]) {
      const foreign = await getScript(otherApi, ref)
      expect(foreign.status, ref).toBe(404)
      expect(errorOf(foreign).code).toBe('notFound')
    }
    const theirs = ok(await otherApi.call<Page<Script>>('listScripts', { query: { limit: 200 } }), 'listScripts')
    expect(theirs.items.map((script) => script.id)).not.toContain(first.id)
    expect((await listScriptFiles(otherApi, first.id)).status).toBe(404)
  })
})

test.describe('uploading script folders', () => {
  test('uploadScript creates the script named in its manifest or replaces its folder', { tag: ['@SCRIPT-003'] }, async ({ api, scripts }) => {
    const files = await readScriptFiles(FILES_REPORT)
    const name = unique('report')
    scripts.track(name)
    const archive = await scriptArchive(renameScript(files, name))

    const created = await uploadScript(api, archive)
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      created: true,
      script: { name, language: 'python', source: { kind: 'upload' }, description: scriptManifestValue(files, 'description'), latestRun: null },
    })
    const listed = ok(await listScriptFiles(api, name), 'listScriptFiles').entries.filter((entry) => entry.type === 'file')
    expect(listed.map((entry) => entry.path).sort()).toEqual(Object.keys(files).sort())
    expect(ok(await readScriptFile(api, name, 'main.py'), 'readScriptFile').content).toBe(scriptFileText(files, 'main.py'))

    // A new upload of the same script replaces its folder; the manifest sets the description.
    const changed = renameScript({ ...files, 'notes.txt': 'added by the second upload\n' }, name)
    changed[SCRIPT_MANIFEST] = editScriptManifest(scriptFileText(changed, SCRIPT_MANIFEST), { description: 'A new description.' })
    const replaced = await uploadScript(api, await scriptArchive(changed))
    expect(replaced.status).toBe(201)
    expect(replaced.body).toMatchObject({ created: false, script: { id: created.body.script.id, description: 'A new description.' } })
    expect(replaced.body.script.workspace.packSha256).not.toBe(created.body.script.workspace.packSha256)
    expect(ok(await readScriptFile(api, name, 'notes.txt'), 'readScriptFile').content).toBe('added by the second upload\n')

    // Invalid manifests and bodies.
    const unsupported = renameScript(files, unique('cobol'))
    unsupported[SCRIPT_MANIFEST] = editScriptManifest(scriptFileText(unsupported, SCRIPT_MANIFEST), { language: 'cobol' })
    const noManifest = { ...files }
    delete noManifest[SCRIPT_MANIFEST]
    for (const [label, broken] of [
      ['language without script support', unsupported],
      ['no manifest', noManifest],
    ] as const) {
      const response = await uploadScript(api, await scriptArchive(broken))
      expect(response.status, label).toBe(422)
      expect(errorOf(response).code, label).toBe('manifestInvalid')
    }
    const notGzip = await api.call('uploadScript', { body: Buffer.from('plain text'), headers: { 'Content-Type': 'text/plain' } })
    expect(notGzip.status).toBe(415)
    expect(errorOf(notGzip).code).toBe('unsupportedMediaType')
  })

  test('an upload over changes that exist only in the folder is workspaceDirty unless forced', { tag: ['@SCRIPT-004'] }, async ({ api, scripts }) => {
    const files = await readScriptFiles(FILES_REPORT)
    // The untouched scaffold counts as changes that were never uploaded.
    const scaffold = await scripts.create()
    const scaffoldMain = ok(await readScriptFile(api, scaffold.name, 'main.py'), 'readScriptFile').content
    const report = await scriptArchive(renameScript(files, scaffold.name))
    const dirty = await uploadScript(api, report)
    expect(dirty.status).toBe(409)
    expect(errorOf(dirty)).toMatchObject({
      code: 'workspaceDirty',
      details: { current: scaffold.workspace.packSha256, uploaded: expect.stringMatching(SHA256) },
    })
    expect(ok(await readScriptFile(api, scaffold.name, 'main.py'), 'readScriptFile').content).toBe(scaffoldMain)

    const forced = await uploadScript(api, report, { force: true })
    expect(forced.status).toBe(201)
    expect(forced.body).toMatchObject({ created: false, script: { id: scaffold.id } })
    expect(ok(await readScriptFile(api, scaffold.name, 'main.py'), 'readScriptFile').content).toBe(scriptFileText(files, 'main.py'))
    // The same content again, and new content over a folder unchanged since the last upload, need no force.
    expect((await uploadScript(api, report)).status).toBe(201)
    const second = await scriptArchive(renameScript({ ...files, 'notes.txt': 'second upload\n' }, scaffold.name))
    expect((await uploadScript(api, second)).status).toBe(201)

    // A write through the file routes makes the folder differ from every upload.
    ok(await writeScriptFiles(api, scaffold.name, { 'edited.txt': 'only in the folder\n' }), 'writeScriptFiles')
    const third = await scriptArchive(renameScript({ ...files, 'notes.txt': 'third upload\n' }, scaffold.name))
    const conflict = await uploadScript(api, third)
    expect(conflict.status).toBe(409)
    expect(errorOf(conflict).code).toBe('workspaceDirty')
    expect(ok(await readScriptFile(api, scaffold.name, 'edited.txt'), 'readScriptFile').content).toBe('only in the folder\n')
    expect((await uploadScript(api, third, { force: true })).status).toBe(201)
    expect((await readScriptFile(api, scaffold.name, 'edited.txt')).status).toBe(404)
    expect(ok(await readScriptFile(api, scaffold.name, 'notes.txt'), 'readScriptFile').content).toBe('third upload\n')
  })
})

test.describe('script files', () => {
  test('list, read, write and delete files of the script folder', { tag: ['@SCRIPT-005'] }, async ({ api, scripts }) => {
    const script = await scripts.fixture('files-report')
    const binary = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 10])
    const written = ok(
      await writeScriptFiles(api, script.name, {
        'lib/util.py': 'VALUE = 1\n',
        'lib/deep/more.py': 'MORE = 2\n',
        'data.bin': { base64: binary.toString('base64') },
      }),
      'writeScriptFiles',
    )
    expect([...written.written].sort()).toEqual(['data.bin', 'lib/deep/more.py', 'lib/util.py'])
    expect(written.workspace.packSha256).toMatch(SHA256)
    expect(written.workspace.packSha256).not.toBe(script.workspace.packSha256)
    expect(ok(await getScript(api, script.name), 'getScript').workspace.packSha256).toBe(written.workspace.packSha256)

    const all = ok(await listScriptFiles(api, script.name), 'listScriptFiles')
    const paths = all.entries.map((entry) => entry.path)
    expect(all.truncated).toBe(false)
    expect(paths).toEqual([...paths].sort())
    expect(paths).toEqual(expect.arrayContaining(['data.bin', 'lib', 'lib/deep', 'lib/deep/more.py', 'lib/util.py', 'main.py', SCRIPT_MANIFEST]))
    expect(all.entries.find((entry) => entry.path === 'lib/util.py')).toMatchObject({ path: 'lib/util.py', type: 'file', size: 'VALUE = 1\n'.length })
    expect(ok(await listScriptFiles(api, script.name, { path: 'lib', recursive: false }), 'listScriptFiles').entries.map((entry) => entry.path)).toEqual([
      'lib/deep',
      'lib/util.py',
    ])

    expect(ok(await readScriptFile(api, script.name, 'lib/util.py'), 'readScriptFile')).toEqual({
      path: 'lib/util.py',
      size: 'VALUE = 1\n'.length,
      sha256: sha256('VALUE = 1\n'),
      encoding: 'utf8',
      content: 'VALUE = 1\n',
      truncated: false,
    })
    expect(ok(await readScriptFile(api, script.name, 'data.bin'), 'readScriptFile')).toMatchObject({
      encoding: 'base64',
      content: binary.toString('base64'),
      sha256: sha256(binary),
    })

    const notRecursive = await deleteScriptFile(api, script.name, 'lib')
    expect(notRecursive.status).toBe(400)
    expect(errorOf(notRecursive).code).toBe('badRequest')
    const deleted = ok(await deleteScriptFile(api, script.name, 'lib', true), 'deleteScriptFile')
    expect([...deleted.deleted].sort()).toEqual(['lib', 'lib/deep', 'lib/deep/more.py', 'lib/util.py'])
    expect(deleted.workspace.packSha256).toBe(ok(await getScript(api, script.name), 'getScript').workspace.packSha256)
    ok(await deleteScriptFile(api, script.name, 'data.bin'), 'deleteScriptFile')
    // Back to the uploaded content.
    expect(ok(await getScript(api, script.name), 'getScript').workspace.packSha256).toBe(script.workspace.packSha256)

    for (const [label, response] of [
      ['missing file', await readScriptFile(api, script.name, 'nope.py')],
      ['missing folder', await listScriptFiles(api, script.name, { path: 'nope' })],
      ['missing delete', await deleteScriptFile(api, script.name, 'nope.py')],
    ] as const) {
      expect(response.status, label).toBe(404)
      expect(errorOf(response).code, label).toBe('notFound')
    }
    for (const [label, response] of [
      ['read outside', await readScriptFile(api, script.name, '../escape.py')],
      ['list outside', await listScriptFiles(api, script.name, { path: '../x' })],
      ['write outside', await writeScriptFiles(api, script.name, { '../escape.py': 'x' })],
      ['delete the root', await deleteScriptFile(api, script.name, '', true)],
    ] as const) {
      expect(response.status, label).toBe(422)
      expect(errorOf(response).code, label).toBe('invalidPath')
    }
  })

  test('the workspace archive is the deterministic pack of the script folder', { tag: ['@SCRIPT-006'] }, async ({ api, scripts }) => {
    const files = await readScriptFiles(FILES_REPORT)
    const script = await scripts.upload(files)
    ok(await writeScriptFiles(api, script.name, { 'extra/notes.txt': 'written through the API\n' }), 'writeScriptFiles')
    const status = ok(await getScript(api, script.name), 'getScript').workspace

    const download = await api.call('downloadScriptWorkspace', { path: { script: script.name } })
    expect(download.status).toBe(200)
    expect(download.headers['content-type']).toBe('application/gzip')
    expect(download.headers['content-disposition']).toBe(`attachment; filename="${script.name}.tar.gz"`)
    expect(packSha256(download.raw)).toBe(status.packSha256)
    const entries = (await readTarGz(download.raw)).filter((entry) => entry.type === 'file')
    expect(entries.map((entry) => entry.name).sort()).toEqual([...Object.keys(files), 'extra/notes.txt'].sort())
    expect(entries.find((entry) => entry.name === 'main.py')?.content.toString('utf8')).toBe(scriptFileText(files, 'main.py'))
    expect(entries.find((entry) => entry.name === SCRIPT_MANIFEST)?.content.toString('utf8')).toMatch(new RegExp(`^name: ${script.name}$`, 'm'))

    const again = await api.call('downloadScriptWorkspace', { path: { script: script.id } })
    expect(packSha256(again.raw)).toBe(status.packSha256)
  })
})

test.describe('deleting scripts', () => {
  test(
    'a deleted script disappears at once; its job cancels its runs and removes runs, images and folder',
    { tag: ['@SCRIPT-007'] },
    async ({ api, scripts, filesScan }) => {
      // A build, a run and a scriptDelete job that waits for the run's container.
      test.setTimeout(420_000)
      const script = await scripts.upload(probeScriptFiles())
      const created = await startRun(api, script.name, { scans: [filesScan.scan.id], config: { mode: 'wait', label: 'delete' } })
      await waitForScriptRunLog(api, created.id, probeWaiting('delete'))
      const running = ok(await getScriptRun(api, created.id), 'getScriptRun')
      expect(running.state).toBe('running')
      const image = scriptImageRef(script.id, running.source.packSha256)
      expect(await imageExists(image)).toBe(true)

      const deleted = await api.call<JobAccepted>('deleteScript', { path: { script: script.name } })
      expect(deleted.status).toBe(202)
      expect(deleted.body.job.kind).toBe('scriptDelete')
      // Gone at once: by name and id, from the list, for the file routes and for new runs.
      for (const ref of [script.name, script.id]) expect((await getScript(api, ref)).status, ref).toBe(404)
      const listed = ok(await api.call<Page<Script>>('listScripts', { query: { q: script.name } }), 'listScripts')
      expect(listed.items).toEqual([])
      expect((await listScriptFiles(api, script.id)).status).toBe(404)
      expect(await startRunStatus(api, script.id, filesScan.scan.id)).toBe(404)
      expect((await api.call('deleteScript', { path: { script: script.id } })).status).toBe(404)
      // Until the job removed it, the name stays taken.
      const sameName = await uploadScript(api, await scriptArchive(renameScript(probeScriptFiles(), script.name)))
      expect(sameName.status).toBe(409)
      expect(errorOf(sameName).code).toBe('alreadyExists')

      // The job cancels the run (its container is stopped and removed) and then removes everything.
      const cancelled = await waitForScriptRun(api, created.id, 'cancelled', 120_000)
      expect(cancelled.error).toEqual({ type: 'platform', message: 'the script was deleted' })
      await waitForScriptRunContainerGone(created.id)
      const job = await waitForJob(api, deleted.body.job.id, 240_000)
      expect(job, JSON.stringify(job.error)).toMatchObject({ kind: 'scriptDelete', state: 'succeeded' })
      expect((await getScriptRun(api, created.id)).status).toBe(404)
      expect((await api.call('getScriptRunLogs', { path: { scriptRunId: created.id } })).status).toBe(404)
      expect(await imageExists(image)).toBe(false)

      // The name is free again, with a new id.
      const recreated = await uploadScript(api, await scriptArchive(renameScript(probeScriptFiles(), script.name)))
      expect(recreated.status).toBe(201)
      expect(recreated.body).toMatchObject({ created: true, script: { name: script.name, latestRun: null } })
      expect(recreated.body.script.id).not.toBe(script.id)
      // The cancel after the end changes nothing: the run is gone.
      expect((await cancelScriptRun(api, created.id)).status).toBe(404)
    },
  )
})

/** The status of a startScriptRun request for a script that cannot run. */
async function startRunStatus(api: ApiClient, script: string, scanId: string): Promise<number> {
  return (await api.call('startScriptRun', { path: { script }, body: { scans: [scanId], settings: { limit: 1 } } })).status
}
