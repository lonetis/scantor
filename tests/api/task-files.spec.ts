import type { TaskFileEntry } from '#shared/types/tasks'
import { ok, type ApiClient } from '../helpers/api-client'
import {
  deleteTaskFile,
  errorOf,
  getTaskWorkspace,
  issuePaths,
  listPaths,
  listTaskFiles,
  plantSymlink,
  pythonTaskFiles,
  readTaskFile,
  runInWorkspace,
  sha256,
  tarGz,
  uploadFiles,
  writeTaskFiles,
  type OwnedEntry,
} from '../helpers/api-tasks-support'
import { tenantFixture } from '../helpers/api-tasks-fixtures'
import { waitForRevision } from '../helpers/tasks'
import { expect, test as base, unique, type TasksFixture } from '../fixtures'

// Workspace files (docs/api.md §4.7, docs/editor.md §9.4–§9.9): listing, reading, writing and deleting files of the
// caller's task folders through workspace helpers, revision snapshots, and the normalisation of uploaded archives. The
// path-rule corpora (WS-007…WS-009, WS-011) belong to security/. A symlink can only enter a workspace through the
// editor, so the symlink tests create one with a throwaway container on the caller's own workspace folder.

const test = base.extend({
  user: [tenantFixture('user'), { scope: 'worker', timeout: 180_000 }],
})

const FILE = 0o644
const EXECUTABLE = 0o755
const DIR = 0o755

/** Uploads a task folder (publish=false) under a tracked unique name; returns the name. */
async function newTask(api: ApiClient, tasks: TasksFixture, prefix: string, extra: Record<string, string> = {}): Promise<string> {
  const name = unique(prefix)
  tasks.track(name)
  ok(await uploadFiles(api, pythonTaskFiles(name, { extra })), 'uploadTask')
  return name
}

function entry(entries: TaskFileEntry[], path: string): TaskFileEntry | undefined {
  return entries.find((e) => e.path === path)
}

test.describe('list', () => {
  test('lists recursively by default, one level with recursive=false and a subfolder with path', { tag: ['@WS-001'] }, async ({ api, tasks }) => {
    const name = unique('list')
    tasks.track(name)
    const files = pythonTaskFiles(name, { extra: { 'src/app.py': 'APP = 1\n', 'src/lib/util.py': 'UTIL = 2\n', 'bin/run.sh': '#!/bin/sh\necho run\n' } })
    const archive = await tarGz(Object.keys(files).sort().map((path) => ({ name: path, content: files[path]!, mode: path === 'bin/run.sh' ? 0o755 : 0o644 })))
    ok(await api.uploadTask(archive, { publish: false }), 'uploadTask')

    const all = ok(await listTaskFiles(api, name), 'listTaskFiles')
    expect(all.truncated).toBe(false)
    const paths = all.entries.map((e) => e.path)
    expect(paths).toEqual([...paths].sort())
    expect(paths).toEqual(['.dockerignore', 'Dockerfile', 'bin', 'bin/run.sh', 'main.py', 'scantor.yaml', 'src', 'src/app.py', 'src/lib', 'src/lib/util.py'])
    expect(entry(all.entries, 'src')).toEqual({ path: 'src', type: 'dir', size: 0, mode: DIR })
    expect(entry(all.entries, 'src/app.py')).toEqual({ path: 'src/app.py', type: 'file', size: 'APP = 1\n'.length, mode: FILE })
    expect(entry(all.entries, 'bin/run.sh')).toEqual({ path: 'bin/run.sh', type: 'file', size: files['bin/run.sh']!.length, mode: EXECUTABLE })

    expect(await listPaths(api, name, { recursive: false })).toEqual(['.dockerignore', 'Dockerfile', 'bin', 'main.py', 'scantor.yaml', 'src'])
    expect(await listPaths(api, name, { path: 'src' })).toEqual(['src/app.py', 'src/lib', 'src/lib/util.py'])
    expect(await listPaths(api, name, { path: 'src', recursive: false })).toEqual(['src/app.py', 'src/lib'])
    expect(await listPaths(api, name, { path: 'src/lib/util.py' })).toEqual(['src/lib/util.py'])

    const missing = await listTaskFiles(api, name, { path: 'nope' })
    expect(missing.status).toBe(404)
    expect(errorOf(missing).code).toBe('notFound')
    const invalid = await listTaskFiles(api, name, { path: '../x' })
    expect(invalid.status).toBe(422)
    expect(errorOf(invalid)).toMatchObject({ code: 'invalidPath', details: { path: '../x' } })
  })

  test('lists a symlink without following it, and reading one is invalidPath', { tag: ['@WS-001', '@WS-003'] }, async ({ api, tasks, user }) => {
    const name = await newTask(api, tasks, 'symlink')
    await plantSymlink(user.id, name, 'passwd', '/etc/passwd')
    await plantSymlink(user.id, name, 'alias.py', 'main.py')

    const entries = ok(await listTaskFiles(api, name), 'listTaskFiles').entries
    expect(entry(entries, 'passwd')).toEqual({ path: 'passwd', type: 'symlink', size: '/etc/passwd'.length, mode: 0o777 })
    expect(entry(entries, 'alias.py')).toEqual({ path: 'alias.py', type: 'symlink', size: 'main.py'.length, mode: 0o777 })

    for (const path of ['passwd', 'alias.py']) {
      const response = await readTaskFile(api, name, path)
      expect(response.status, path).toBe(422)
      expect(errorOf(response), path).toMatchObject({ code: 'invalidPath', details: { path } })
      expect(response.raw.toString('utf8'), path).not.toContain('root:')
      expect(response.raw.toString('utf8'), path).not.toContain('scantor.Task')
    }
  })

  test('returns at most 5000 entries and flags the truncation', { tag: ['@WS-001'] }, async ({ api, tasks }) => {
    const name = await newTask(api, tasks, 'many')
    // .scantor/ is excluded from the pack, so it does not count toward the task's file cap, but it is listed.
    for (let batch = 0; batch < 26; batch++) {
      const files: Record<string, string> = {}
      for (let i = 0; i < 200; i++) files[`.scantor/bulk/${String(batch * 200 + i).padStart(4, '0')}.txt`] = ''
      ok(await writeTaskFiles(api, name, files), `writeTaskFiles batch ${batch}`)
    }
    const listing = ok(await listTaskFiles(api, name), 'listTaskFiles')
    expect(listing.truncated).toBe(true)
    expect(listing.entries).toHaveLength(5000)
    const paths = listing.entries.map((e) => e.path)
    expect(paths).toEqual([...paths].sort())

    const top = ok(await listTaskFiles(api, name, { recursive: false }), 'listTaskFiles')
    expect(top.truncated).toBe(false)
    expect(top.entries.map((e) => e.path)).toEqual(['.dockerignore', '.scantor', 'Dockerfile', 'main.py', 'scantor.yaml'])
  })
})

test.describe('read', () => {
  test('returns text and base64 content with the sha256 of the whole file', { tag: ['@WS-003'] }, async ({ api, tasks }) => {
    const name = await newTask(api, tasks, 'read')
    const text = 'grüße, scantor\n'
    const binary = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255, 0, 10])
    const big = 'abcdefghijklmnopqrstuvwxyz0123456789\n'.repeat(Math.ceil((1.5 * 1024 * 1024) / 37))
    ok(await writeTaskFiles(api, name, { 'docs/text.txt': text, 'data/blob.bin': { base64: binary.toString('base64') }, 'data/big.txt': big }), 'writeTaskFiles')

    expect(ok(await readTaskFile(api, name, 'docs/text.txt'), 'readTaskFile')).toEqual({
      path: 'docs/text.txt',
      size: Buffer.byteLength(text),
      sha256: sha256(text),
      encoding: 'utf8',
      content: text,
      truncated: false,
    })
    expect(ok(await readTaskFile(api, name, 'data/blob.bin'), 'readTaskFile')).toEqual({
      path: 'data/blob.bin',
      size: binary.length,
      sha256: sha256(binary),
      encoding: 'base64',
      content: binary.toString('base64'),
      truncated: false,
    })

    const truncated = ok(await readTaskFile(api, name, 'data/big.txt'), 'readTaskFile')
    expect(truncated).toMatchObject({ path: 'data/big.txt', size: big.length, sha256: sha256(big), encoding: 'utf8', truncated: true })
    expect(truncated.content).toBe(big.slice(0, 1024 * 1024))

    const missing = await readTaskFile(api, name, 'docs/missing.txt')
    expect(missing.status).toBe(404)
    expect(errorOf(missing).code).toBe('notFound')
    const directory = await readTaskFile(api, name, 'docs')
    expect(directory.status).toBe(422)
    expect(errorOf(directory)).toMatchObject({ code: 'invalidPath', details: { path: 'docs' } })
  })

  test('a revision snapshot stays what was published while the workspace changes', { tag: ['@WS-002'] }, async ({ api, tasks }) => {
    test.setTimeout(180_000)
    const name = unique('snapshot')
    tasks.track(name)
    const files = pythonTaskFiles(name, { extra: { 'notes/readme.txt': 'published notes\n' } })
    const uploaded = ok(await uploadFiles(api, files, { publish: true, wait: 120 }), 'uploadTask')
    const revision = await waitForRevision(api, name, uploaded.revision!.id, 150_000)
    expect(revision.state, JSON.stringify(revision.errors)).toBe('ready')
    const published = ok(await listTaskFiles(api, name), 'listTaskFiles').entries

    // Later edits of the workspace never reach the snapshot.
    ok(await writeTaskFiles(api, name, { 'main.py': '# replaced\n', 'added.txt': 'new\n' }), 'writeTaskFiles')
    ok(await deleteTaskFile(api, name, 'notes', true), 'deleteTaskFile')
    expect(await listPaths(api, name)).toEqual(['.dockerignore', 'Dockerfile', 'added.txt', 'main.py', 'scantor.yaml'])

    for (const ref of [1, 'latest', revision.id]) {
      const listing = ok(await listTaskFiles(api, name, { revision: ref }), `listTaskFiles ${ref}`)
      expect(listing.entries.map((e) => e.path), String(ref)).toEqual(published.map((e) => e.path))
      expect(listing.truncated).toBe(false)
      expect(entry(listing.entries, 'notes/readme.txt'), String(ref)).toMatchObject({ type: 'file', size: 'published notes\n'.length })
      expect(await listPaths(api, name, { revision: ref, path: 'notes', recursive: false }), String(ref)).toEqual(['notes/readme.txt'])

      const main = ok(await readTaskFile(api, name, 'main.py', ref), `readTaskFile ${ref}`)
      expect(main, String(ref)).toMatchObject({ path: 'main.py', encoding: 'utf8', content: files['main.py'], sha256: sha256(files['main.py']!), truncated: false })
      const added = await readTaskFile(api, name, 'added.txt', ref)
      expect(added.status, String(ref)).toBe(404)
    }
    for (const ref of [2, '7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c']) {
      expect((await listTaskFiles(api, name, { revision: ref })).status, String(ref)).toBe(404)
      expect((await readTaskFile(api, name, 'main.py', ref)).status, String(ref)).toBe(404)
    }
  })
})

test.describe('write', () => {
  test('writes files atomically, creating parent folders', { tag: ['@WS-004'] }, async ({ api, tasks }) => {
    const name = await newTask(api, tasks, 'write')
    const binary = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 255])
    const response = await writeTaskFiles(api, name, { 'deep/er/note.md': '# note\n', 'img/logo.png': { base64: binary.toString('base64') } })
    expect(response.status).toBe(200)
    const status = ok(await getTaskWorkspace(api, name), 'getTaskWorkspace')
    expect(response.body).toEqual({ written: ['deep/er/note.md', 'img/logo.png'], workspace: { packSha256: status.packSha256, dirty: true } })

    const entries = ok(await listTaskFiles(api, name), 'listTaskFiles').entries
    for (const dir of ['deep', 'deep/er', 'img']) expect(entry(entries, dir), dir).toMatchObject({ type: 'dir', mode: DIR })
    expect(entry(entries, 'deep/er/note.md')).toMatchObject({ type: 'file', size: 7, mode: FILE })
    expect(ok(await readTaskFile(api, name, 'img/logo.png'), 'readTaskFile')).toMatchObject({ encoding: 'base64', sha256: sha256(binary), size: binary.length })

    // Replacing a file and writing the maximum of 200 files in one request.
    const many: Record<string, string> = { 'deep/er/note.md': '# replaced\n' }
    for (let i = 1; i < 200; i++) many[`many/f${i}.txt`] = `${i}\n`
    const replaced = ok(await writeTaskFiles(api, name, many), 'writeTaskFiles')
    expect(replaced.written).toHaveLength(200)
    expect(ok(await readTaskFile(api, name, 'deep/er/note.md'), 'readTaskFile').content).toBe('# replaced\n')

    // A request with one rejected path writes nothing.
    const before = ok(await getTaskWorkspace(api, name), 'getTaskWorkspace').packSha256
    const rejected = await writeTaskFiles(api, name, { 'kept-out.txt': 'never written\n', 'a/../../escape.txt': 'nope\n' })
    expect(rejected.status).toBe(422)
    expect(errorOf(rejected)).toMatchObject({ code: 'invalidPath', details: { path: 'a/../../escape.txt' } })
    expect(await listPaths(api, name, { recursive: false })).not.toContain('kept-out.txt')
    expect(ok(await getTaskWorkspace(api, name), 'getTaskWorkspace').packSha256).toBe(before)
  })

  test('rejects an empty files map, more than 200 files and invalid base64', { tag: ['@WS-005'] }, async ({ api, tasks }) => {
    const name = await newTask(api, tasks, 'badwrite')
    const before = ok(await getTaskWorkspace(api, name), 'getTaskWorkspace').packSha256
    const tooMany: Record<string, string> = {}
    for (let i = 0; i < 201; i++) tooMany[`f${i}.txt`] = 'x'
    const cases: [string, Record<string, unknown>][] = [
      ['an empty map', {}],
      ['201 files', tooMany],
      ['invalid base64', { 'blob.bin': { base64: 'not*base64!' } }],
      ['an unknown content key', { 'blob.bin': { hex: '00' } }],
    ]
    for (const [label, files] of cases) {
      const response = await api.call('writeTaskFiles', { path: { task: name }, body: { files } })
      expect(response.status, label).toBe(400)
      expect(errorOf(response).code, label).toBe('validationFailed')
      expect(issuePaths(response).join(','), label).toMatch(/^files/)
    }
    const missing = await api.call('writeTaskFiles', { path: { task: name }, body: {} })
    expect(missing.status).toBe(400)
    expect(issuePaths(missing)).toContain('files')
    expect(ok(await getTaskWorkspace(api, name), 'getTaskWorkspace').packSha256).toBe(before)
  })
})

test.describe('delete', () => {
  test('removes a file, and a non-empty folder only recursively', { tag: ['@WS-006'] }, async ({ api, tasks }) => {
    const name = await newTask(api, tasks, 'delete', { 'top.txt': 'top\n', 'dir/a.txt': 'a\n', 'dir/sub/b.txt': 'b\n' })

    const file = await deleteTaskFile(api, name, 'top.txt')
    expect(file.status).toBe(200)
    const afterFile = ok(await getTaskWorkspace(api, name), 'getTaskWorkspace')
    expect(file.body).toEqual({ deleted: ['top.txt'], workspace: { packSha256: afterFile.packSha256, dirty: true } })

    const notRecursive = await deleteTaskFile(api, name, 'dir')
    expect(notRecursive.status).toBe(400)
    expect(errorOf(notRecursive).code).toBe('badRequest')
    expect(await listPaths(api, name, { path: 'dir' })).toEqual(['dir/a.txt', 'dir/sub', 'dir/sub/b.txt'])

    const recursive = ok(await deleteTaskFile(api, name, 'dir', true), 'deleteTaskFile')
    expect(recursive.deleted[0]).toBe('dir')
    expect([...recursive.deleted].sort()).toEqual(['dir', 'dir/a.txt', 'dir/sub', 'dir/sub/b.txt'])
    expect(recursive.workspace.packSha256).toBe(ok(await getTaskWorkspace(api, name), 'getTaskWorkspace').packSha256)
    expect(await listPaths(api, name)).toEqual(['.dockerignore', 'Dockerfile', 'main.py', 'scantor.yaml'])

    const missing = await deleteTaskFile(api, name, 'top.txt')
    expect(missing.status).toBe(404)
    expect(errorOf(missing).code).toBe('notFound')
    for (const recursiveRoot of [false, true]) {
      const root = await deleteTaskFile(api, name, '', recursiveRoot)
      expect(root.status, `recursive=${recursiveRoot}`).toBe(422)
      expect(errorOf(root).code).toBe('invalidPath')
    }
    expect(await listPaths(api, name)).toEqual(['.dockerignore', 'Dockerfile', 'main.py', 'scantor.yaml'])
  })
})

test.describe('archive normalisation', () => {
  test('ignores owners, normalises modes, strips a single top folder and drops .git and .scantor', { tag: ['@WS-010'] }, async ({ api, tasks, user }) => {
    const name = unique('normalise')
    tasks.track(name)
    const files = pythonTaskFiles(name)
    const owner = { uid: 0, gid: 0, uname: 'root', gname: 'root' }
    const entries: OwnedEntry[] = [
      { name: 'project/', type: 'dir', mode: 0o700, ...owner },
      ...Object.keys(files).map((path) => ({ name: `project/${path}`, content: files[path]!, mode: 0o600, ...owner })),
      { name: 'project/tools/', type: 'dir', mode: 0o711, uid: 4242, gid: 4242, uname: 'someone', gname: 'others' },
      { name: 'project/tools/run.sh', content: '#!/bin/sh\n', mode: 0o700, uid: 4242, gid: 4242 },
      { name: 'project/tools/any.sh', content: '#!/bin/sh\n', mode: 0o777, uid: 4242, gid: 4242 },
      { name: 'project/tools/data.txt', content: 'data\n', mode: 0o666, uid: 4242, gid: 4242 },
      { name: 'project/.git/HEAD', content: 'ref: refs/heads/main\n' },
      { name: 'project/.git/config', content: '[core]\n' },
      { name: 'project/tools/.scantor/state.json', content: '{}\n' },
      { name: 'project/.scantor/cache.json', content: '{}\n' },
      { name: 'project/sub/.git/HEAD', content: 'ref: refs/heads/main\n' },
      { name: 'project/sub/kept.txt', content: 'kept\n' },
    ]
    const response = await api.uploadTask(await tarGz(entries), { publish: false })
    expect(response.status).toBe(201)

    const listing = ok(await listTaskFiles(api, name), 'listTaskFiles').entries
    expect(listing.map((e) => e.path)).toEqual([
      '.dockerignore',
      'Dockerfile',
      'main.py',
      'scantor.yaml',
      'sub',
      'sub/kept.txt',
      'tools',
      'tools/any.sh',
      'tools/data.txt',
      'tools/run.sh',
    ])
    const modes = Object.fromEntries(listing.map((e) => [e.path, e.mode]))
    expect(modes).toMatchObject({ 'main.py': FILE, sub: DIR, tools: DIR, 'tools/any.sh': EXECUTABLE, 'tools/run.sh': EXECUTABLE, 'tools/data.txt': FILE })

    // Every extracted entry belongs to the workspace user, whatever the archive said.
    const owners = await runInWorkspace(user.id, `cd '/w/${name}' && find . -mindepth 1 -exec stat -c '%u:%g' {} + | sort -u`)
    expect(owners.trim().split('\n')).toEqual(['1000:1000'])

    // The same tree without the top folder, other owners and no .git gives the same workspace (no conflict, no change).
    const plain = Object.keys(files).map((path) => ({ name: path, content: files[path]!, uid: 1, gid: 1 }))
    const same = await api.uploadTask(
      await tarGz([
        ...plain,
        { name: 'sub/kept.txt', content: 'kept\n' },
        { name: 'tools/any.sh', content: '#!/bin/sh\n', mode: 0o755 },
        { name: 'tools/data.txt', content: 'data\n' },
        { name: 'tools/run.sh', content: '#!/bin/sh\n', mode: 0o755 },
      ]),
      { publish: false },
    )
    expect(same.status).toBe(201)
    expect(same.body.task.workspace.packSha256).toBe(response.body.task.workspace.packSha256)
  })
})
