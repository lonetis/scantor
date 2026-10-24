import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ok, type ApiClient, type ApiResponse } from '../helpers/api-client'
import { stackEnv } from '../helpers/docker'
import { errorCode, errorDetails, runScantorShell, taskFolderMount } from '../helpers/security'
import { buildCaseArchive, buildTarGz, loadTarCorpus, type TarCase, type TarEntry } from '../helpers/tar'
import { withSecurityTenants } from '../helpers/security-tenants'
import { expect, test as base, unique } from '../fixtures'

// The tenant fixtures of the security specs (helpers/security-tenants.ts).
const test = withSecurityTenants(base)

// Workspace path and archive rules (docs/security.md WS-3, WS-5; docs/editor.md §9.5): every case of
// tests/corpora/tar-slip through uploadTask and every case of tests/corpora/paths through the file routes. A rejected
// request leaves the workspace unchanged (its pack hash) and writes nothing outside the task folder.

interface PathCase {
  path?: string
  pathBase64?: string
  valid: boolean
  reason?: string
}

interface WorkspaceCase {
  id: string
  setup: { path: string; symlink?: string; file?: string; dir?: boolean }[]
  op: 'list' | 'read' | 'write' | 'delete'
  path: string
  expect: { code?: string; entries?: { path: string; type: string }[]; deleted?: string[]; remaining?: string[] }
}

const pathsCorpus = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'corpora', 'paths', 'cases.json'), 'utf8')) as {
  paths: PathCase[]
  workspace: WorkspaceCase[]
}
const tarCorpus = loadTarCorpus()

/** API codes of the helper error codes (docs/editor.md §9.3). */
const API_ERROR: Record<string, { status: number; code: string }> = {
  invalidPath: { status: 422, code: 'invalidPath' },
  manifestInvalid: { status: 422, code: 'manifestInvalid' },
  invalidArgument: { status: 400, code: 'badRequest' },
  tooManyFiles: { status: 413, code: 'payloadTooLarge' },
  tooLarge: { status: 413, code: 'payloadTooLarge' },
  workspaceFull: { status: 413, code: 'payloadTooLarge' },
}

/** Cases that need the caps of the helper unit tests or bytes JavaScript strings cannot carry; covered below or by Go. */
const limitCases = new Set(['too-many-files', 'gzip-bomb', 'compressed-cap', 'workspace-cap'])
const unsupported = (c: TarCase) => c.format === 'zip' || JSON.stringify(c.entries ?? []).includes('nameBase64') || (c.workspace?.length ?? 0) > 0

/** The case's entries with the corpus manifest renamed to the test's task. */
function renamed(entries: TarEntry[], task: string): TarEntry[] {
  return entries.map((entry) =>
    entry.type === 'file' && /(^|\/)scantor\.yaml$/.test(entry.name ?? '') && entry.content !== undefined
      ? { ...entry, content: entry.content.replace(/^name: slip$/m, `name: ${task}`) }
      : entry,
  )
}

const manifest = (task: string) => `scantor: 1\nname: ${task}\nlanguage: python\n`

/** Uploads (without publishing) a baseline folder of `task` and returns its workspace pack hash. */
async function baseline(api: ApiClient, task: string): Promise<string> {
  const archive = await buildTarGz([
    { name: 'scantor.yaml', content: manifest(task) },
    { name: 'main.py', content: 'print("baseline")\n' },
    { name: 'lib/util.py', content: 'x = 1\n' },
  ])
  const uploaded = await api.uploadTask(archive, { publish: false, force: true })
  expect([200, 201], JSON.stringify(uploaded.body)).toContain(uploaded.status)
  return workspaceHash(api, task)
}

async function workspaceHash(api: ApiClient, task: string): Promise<string> {
  return ok(await api.call<{ packSha256: string }>('getTaskWorkspace', { path: { task } }), 'getTaskWorkspace').packSha256
}

function expectRejection(response: ApiResponse, helperCode: string, path: string | undefined, label: string): void {
  const expected = API_ERROR[helperCode]!
  expect.soft(response.status, `${label}: ${JSON.stringify(response.body)}`).toBe(expected.status)
  expect.soft(errorCode(response), label).toBe(expected.code)
  if (path !== undefined) expect.soft(errorDetails(response).path, label).toBe(path)
  if (expected.status === 413) expect.soft(typeof errorDetails(response).limit, `${label}: details.limit`).toBe('number')
}

/** Paths an escaping archive or write would have created next to the task folder, in the user's workspace root. */
async function escapedEntries(userId: string, names: string[]): Promise<string[]> {
  const checks = names.map((name) => `[ -e "/workspace/${name}" ] || [ -L "/workspace/${name}" ] && echo "${name}"`).join('; ')
  const { stdout } = await runScantorShell(`${checks}; true`, {
    mounts: [`type=volume,src=scantor-workspaces,dst=/workspace,volume-subpath=${userId},readonly`],
  })
  return stdout.split('\n').filter(Boolean)
}

test.describe('upload archives', () => {
  test('every hostile tar-slip case is rejected and leaves the workspace unchanged', { tag: ['@WS-008'] }, async ({ api, user, tasks }) => {
    test.setTimeout(180_000)
    const task = unique('slip')
    tasks.track(task)
    const before = await baseline(api, task)

    const cases = tarCorpus.cases.filter((c) => !c.expect.ok && !limitCases.has(c.id) && !unsupported(c))
    expect(cases.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        'dotdot',
        'absolute',
        'inner-dotdot',
        'backslash',
        'symlink',
        'hardlink',
        'char-device',
        'block-device',
        'fifo',
        'duplicate-file',
        'long-path',
      ]),
    )
    for (const testCase of cases) {
      const archive = await buildCaseArchive({ ...testCase, entries: renamed(testCase.entries ?? [], task) })
      const response = await api.uploadTask(archive, { publish: false, force: true })
      expectRejection(response, testCase.expect.code!, testCase.expect.path, testCase.id)
      expect.soft(await workspaceHash(api, task), `${testCase.id} changed the workspace`).toBe(before)
    }
    // Nothing landed next to the task folder (../x, a/../../x, a\..\..\x, dir/evil through a symlink).
    expect(await escapedEntries(user.id, ['x', 'abs', 'evil', 'passwd', 'null', 'pipe'])).toEqual([])
    // A rejected upload of a new name creates no task.
    const fresh = unique('slip-new')
    const rejected = await api.uploadTask(
      await buildTarGz([
        { name: 'scantor.yaml', content: manifest(fresh) },
        { name: '../x', content: 'x' },
      ]),
      { publish: false },
    )
    expect(rejected.status).toBe(422)
    expect((await api.getTask(fresh)).status).toBe(404)
  })

  test('valid archives are normalised: ./ prefixes, modes, .git/ dropped and one top-level folder stripped', { tag: ['@WS-008'] }, async ({ api, tasks }) => {
    for (const id of ['ok-normalised', 'ok-top-level']) {
      const testCase = tarCorpus.cases.find((c) => c.id === id)!
      const task = unique('slip-ok')
      tasks.track(task)
      // helpers/tar.ts cannot write a PAX global header (it would become a nameless file entry), so the GitHub-style
      // comment record of ok-top-level is left out; the top-level folder is what the case is about.
      const entries = renamed(testCase.entries ?? [], task).filter((entry) => entry.globalPax === undefined)
      const uploaded = await api.uploadTask(await buildCaseArchive({ ...testCase, entries }), { publish: false })
      expect(uploaded.status, `${id}: ${JSON.stringify(uploaded.body)}`).toBe(201)
      const listing = ok(await api.call<{ entries: { path: string; type: string; mode: number }[] }>('listTaskFiles', { path: { task } }), 'listTaskFiles')
      const expected = (testCase.expect.tree as { path: string; type: string; mode: number }[]).map(({ path, type, mode }) => ({ path, type, mode }))
      expect(
        listing.entries.map(({ path, type, mode }) => ({ path, type, mode })),
        id,
      ).toEqual(expected)
    }
  })

  test('archive caps are enforced while streaming, each with 413 and details.limit', { tag: ['@WS-009'] }, async ({ api, tasks }) => {
    test.setTimeout(180_000)
    const caps = stackEnv()
    const maxFiles = Number(caps.SCANTOR_TASK_MAX_FILES)
    const maxBytes = parseByteSize(caps.SCANTOR_TASK_MAX_BYTES!)
    const task = unique('slip-caps')
    tasks.track(task)
    const before = await baseline(api, task)

    // More entries than SCANTOR_TASK_MAX_FILES (tiny files; the archive stays small).
    const tooMany = await buildTarGz([{ name: 'scantor.yaml', content: manifest(task) }, { generate: { prefix: 'f/', count: maxFiles + 1, content: 'x' } }])
    const files = await api.uploadTask(tooMany, { publish: false, force: true })
    expectRejection(files, 'tooManyFiles', undefined, 'too many files')
    expect(errorDetails(files).limit).toBe(maxFiles)

    // A gzip bomb: a small archive that expands beyond SCANTOR_TASK_MAX_BYTES, stopped while streaming.
    const bomb = await buildTarGz([
      { name: 'scantor.yaml', content: manifest(task) },
      { name: 'bomb', zeros: maxBytes + 1024 * 1024 },
    ])
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024)
    const bombed = await api.uploadTask(bomb, { publish: false, force: true })
    expectRejection(bombed, 'tooLarge', undefined, 'gzip bomb')
    expect(errorDetails(bombed).limit).toBe(maxBytes)

    expect(await workspaceHash(api, task)).toBe(before)
  })

  test('SCANTOR_WORKSPACE_MAX_BYTES caps the whole workspace of a user', { tag: ['@WS-009'] }, async ({ api, user, tasks }) => {
    test.setTimeout(180_000)
    const maxWorkspace = parseByteSize(stackEnv().SCANTOR_WORKSPACE_MAX_BYTES!)
    const task = unique('slip-full')
    tasks.track(task)
    const before = await baseline(api, task)
    // White-box: a sparse file next to the tenant's tasks fills the workspace up to 1 MiB below the cap (the cap counts
    // file sizes, not blocks); it is removed again at the end.
    const padding = unique('padding')
    const mount = `type=volume,src=scantor-workspaces,dst=/workspace,volume-subpath=${user.id}`
    await runScantorShell(`mkdir -p /workspace/${padding} && truncate -s ${maxWorkspace - 1024 * 1024} /workspace/${padding}/blob`, {
      user: '1000:1000',
      mounts: [mount],
    })
    try {
      const archive = await buildTarGz([
        { name: 'scantor.yaml', content: manifest(task) },
        { name: 'data.bin', random: 2 * 1024 * 1024 },
      ])
      const response = await api.uploadTask(archive, { publish: false, force: true })
      expectRejection(response, 'workspaceFull', undefined, 'workspace full')
      expect(errorDetails(response).limit).toBe(maxWorkspace)
      expect(await workspaceHash(api, task)).toBe(before)
      // The same growth through the file routes is refused as well.
      const written = await api.call('writeTaskFiles', {
        path: { task },
        body: { files: { 'data.bin': { base64: Buffer.alloc(2 * 1024 * 1024).toString('base64') } } },
      })
      expect(written.status).toBe(413)
      expect(errorCode(written)).toBe('payloadTooLarge')
      expect(await workspaceHash(api, task)).toBe(before)
    } finally {
      await runScantorShell(`rm -rf /workspace/${padding}`, { user: '1000:1000', mounts: [mount] })
    }
  })
})

test.describe('file routes', () => {
  const invalid = pathsCorpus.paths.filter((c) => !c.valid && c.path !== undefined)
  const isEmptyWrite = (path: string, op: string) => path === '' && op === 'write'
  const valid = pathsCorpus.paths.filter((c) => c.valid && c.path !== undefined)

  test('every invalid path of the corpus is refused by writeTaskFiles, deleteTaskFile and readTaskFile', { tag: ['@WS-007'] }, async ({ api, user, tasks }) => {
    test.setTimeout(180_000)
    const task = unique('paths')
    tasks.track(task)
    const before = await baseline(api, task)
    for (const { path, reason } of invalid) {
      const label = `${reason} (${JSON.stringify(path!.slice(0, 40))})`
      if (!isEmptyWrite(path!, 'write')) {
        const write = await api.call('writeTaskFiles', { path: { task }, body: { files: { [path!]: 'x' } } })
        expectRejection(write, 'invalidPath', path, `write ${label}`)
      }
      const remove = await api.call('deleteTaskFile', { path: { task }, query: { path: path!, recursive: true } })
      expectRejection(remove, 'invalidPath', path, `delete ${label}`)
      const read = await api.call('readTaskFile', { path: { task }, query: { path: path! } })
      expectRejection(read, 'invalidPath', path, `read ${label}`)
    }
    expect(await workspaceHash(api, task)).toBe(before)
    expect(await escapedEntries(user.id, ['x', 'etc', 'passwd'])).toEqual([])
  })

  // product bug: an empty file path in writeTaskFiles answers 400 validationFailed instead of 422 invalidPath
  test.fail(
    'an empty file path in writeTaskFiles answers 422 invalidPath like every other invalid path',
    {
      tag: ['@WS-007'],
      annotation: {
        type: 'issue',
        description:
          'PUT /api/tasks/{task}/files {"files": {"": "x"}} answers 400 validationFailed (zod record key, path "files.") instead of 422 invalidPath with details.path; readTaskFile and deleteTaskFile answer 422 invalidPath for the same path',
      },
    },
    async ({ api, tasks }) => {
      const task = unique('paths-empty')
      tasks.track(task)
      const before = await baseline(api, task)
      const write = await api.call('writeTaskFiles', { path: { task }, body: { files: { '': 'x' } } })
      expect(await workspaceHash(api, task)).toBe(before)
      expect(write.status, JSON.stringify(write.body)).toBe(422)
      expect(errorCode(write)).toBe('invalidPath')
      expect(errorDetails(write).path).toBe('')
    },
  )

  test('the valid paths of the corpus are written and read back', { tag: ['@WS-007'] }, async ({ api, tasks }) => {
    const task = unique('paths-ok')
    tasks.track(task)
    await baseline(api, task)
    const files = Object.fromEntries(valid.filter((c) => c.path !== 'scantor.yaml').map((c, index) => [c.path!, `content ${index}`]))
    const written = ok(await api.call<{ written: string[] }>('writeTaskFiles', { path: { task }, body: { files } }), 'writeTaskFiles')
    expect([...written.written].sort()).toEqual(Object.keys(files).sort())
    for (const [path, content] of Object.entries(files)) {
      const read = ok(
        await api.call<{ path: string; content: string; encoding: string }>('readTaskFile', { path: { task }, query: { path } }),
        `read ${path.slice(0, 40)}`,
      )
      expect(read).toMatchObject({ path, content, encoding: 'utf8' })
    }
  })

  test('pre-existing symlinks in a task folder are listed, never followed', { tag: ['@WS-011', '@WS-007'] }, async ({ api, user, tasks }) => {
    test.setTimeout(180_000)
    const task = unique('links')
    tasks.track(task)
    await baseline(api, task)
    for (const testCase of pathsCorpus.workspace) {
      // White-box: what a user can do in the editor, inside the test's own task folder.
      const setup = testCase.setup
        .map((entry) =>
          entry.symlink !== undefined
            ? `ln -s '${entry.symlink}' '/task/${entry.path}'`
            : entry.dir
              ? `mkdir -p '/task/${entry.path}'`
              : `printf '%s' '${entry.file ?? ''}' > '/task/${entry.path}'`,
        )
        .join(' && ')
      // One helper run sets the case up and records the folder's state.
      const prepared = await runScantorShell(
        `find /task -mindepth 1 -maxdepth 1 ! -name scantor.yaml -exec rm -rf {} + && ${setup || 'true'}\n${TASK_FOLDER_STATE}`,
        {
          user: '1000:1000',
          mounts: [taskFolderMount(user.id, task)],
        },
      )
      const before = prepared.stdout.split('\n').filter(Boolean)
      const label = testCase.id
      let response: ApiResponse
      switch (testCase.op) {
        case 'list':
          response = await api.call('listTaskFiles', { path: { task }, query: { path: testCase.path } })
          break
        case 'read':
          response = await api.call('readTaskFile', { path: { task }, query: { path: testCase.path } })
          break
        case 'write':
          response = await api.call('writeTaskFiles', { path: { task }, body: { files: { [testCase.path]: 'evil' } } })
          break
        case 'delete':
          response = await api.call('deleteTaskFile', { path: { task }, query: { path: testCase.path, recursive: true } })
          break
      }
      if (testCase.expect.code) {
        expectRejection(response, testCase.expect.code, undefined, label)
        expect.soft(await taskFolderState(user.id, task), `${label} changed the task folder`).toEqual(before)
      } else if (testCase.expect.entries) {
        expect.soft(response.status, `${label}: ${JSON.stringify(response.body)}`).toBe(200)
        const entries = (response.body as { entries: { path: string; type: string }[] }).entries.filter((e) => e.path !== 'scantor.yaml')
        expect
          .soft(
            entries.map(({ path, type }) => ({ path, type })),
            label,
          )
          .toEqual(testCase.expect.entries)
      } else {
        expect.soft(response.status, `${label}: ${JSON.stringify(response.body)}`).toBe(200)
        expect.soft((response.body as { deleted: string[] }).deleted, label).toEqual(testCase.expect.deleted)
        const listing = ok(await api.call<{ entries: { path: string }[] }>('listTaskFiles', { path: { task } }), 'listTaskFiles')
        expect
          .soft(
            listing.entries.map((e) => e.path).filter((p) => p !== 'scantor.yaml'),
            label,
          )
          .toEqual(testCase.expect.remaining)
      }
    }
    // The escaping write (up -> .., then up/other-task/x) created nothing next to the task folder.
    expect(await escapedEntries(user.id, ['other-task', 'evil', 'x'])).toEqual([])
  })

  test('an upload through a staging folder replaced by a symlink to / writes only into the task folder', { tag: ['@WS-011'] }, async ({ api, user, tasks }) => {
    const testCase = tarCorpus.cases.find((c) => c.id === 'ok-staging-symlink')!
    const task = unique('staging')
    tasks.track(task)
    await baseline(api, task)
    const mount = `type=volume,src=scantor-workspaces,dst=/workspace,volume-subpath=${user.id}`
    // White-box: what a user could do from the editor (the staging folder is created at user init). Restored after.
    await runScantorShell('rm -rf /workspace/.scantor-staging && ln -s / /workspace/.scantor-staging', { user: '1000:1000', mounts: [mount] })
    try {
      const uploaded = await api.uploadTask(await buildCaseArchive({ ...testCase, entries: renamed(testCase.entries ?? [], task) }), {
        publish: false,
        force: true,
      })
      expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201)
      const listing = ok(await api.call<{ entries: { path: string; type: string; mode: number }[] }>('listTaskFiles', { path: { task } }), 'listTaskFiles')
      expect(listing.entries.map(({ path, type, mode }) => ({ path, type, mode }))).toEqual(testCase.expect.tree)
      expect(await escapedEntries(user.id, ['tree'])).toEqual([])
    } finally {
      await runScantorShell(
        'if [ -L /workspace/.scantor-staging ]; then rm -f /workspace/.scantor-staging; fi; mkdir -p /workspace/.scantor-staging && chmod 700 /workspace/.scantor-staging',
        {
          user: '1000:1000',
          mounts: [mount],
        },
      )
    }
  })
})

/** Prints every entry of the task folder at /task with its type, link target or content hash (symlinks are not followed). */
const TASK_FOLDER_STATE = [
  'cd /task && find . -mindepth 1 | sort | while read -r p; do',
  '  if [ -L "$p" ]; then echo "L $p -> $(readlink "$p")";',
  '  elif [ -d "$p" ]; then echo "D $p";',
  '  else echo "F $p $(sha256sum < "$p" | cut -d" " -f1)"; fi',
  'done',
].join('\n')

/** The state of a task folder (white-box, read-only). */
async function taskFolderState(userId: string, task: string): Promise<string[]> {
  const { stdout } = await runScantorShell(TASK_FOLDER_STATE, { user: '1000:1000', mounts: [`${taskFolderMount(userId, task)},readonly`] })
  return stdout.split('\n').filter(Boolean)
}

/** Parses the byte sizes of .env.example (`200MiB`, `2GiB`, plain bytes). */
function parseByteSize(value: string): number {
  const match = /^(\d+)\s*(B|KiB|MiB|GiB)?$/.exec(value.trim())
  if (!match) throw new Error(`unparsable byte size ${value}`)
  const unit = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[match[2] ?? 'B']!
  return Number(match[1]) * unit
}
