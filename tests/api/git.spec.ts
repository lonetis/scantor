import type { Credential } from '#shared/types/credentials'
import type { Revision } from '#shared/types/revisions'
import type { GitImportCandidate, ImportGitResult, PullGitResult, Task, TaskFileContent } from '#shared/types/tasks'
import { ok, type ApiClient } from '../helpers/api-client'
import { tenantFixture } from '../helpers/api-tasks-fixtures'
import { startGitServer, type GitServer } from '../helpers/api-tasks-git-server'
import { credentialsFixture, errorOf, issuePaths, listTaskFiles, pythonTaskFiles, token, type CredentialsFixture } from '../helpers/api-tasks-support'
import { copyGitRepo, GIT_REPOS, GIT_URL, moveGitMain, PRIVATE_GIT_CREDENTIAL } from '../helpers/fixtures-server'
import { expect, test as base, unique, type TasksFixture } from '../fixtures'

// Git import and pull (docs/api.md §4.8, docs/tasks.md §14, docs/editor.md §9.7). The fixtures server's repositories
// (single, multi, private, diverge copies) carry fixed task names (git-*), so those tests wait until a previous
// test's task of that name is deleted. Every other scenario serves its own repository with unique task names from a
// git server inside the test runner (helpers/api-tasks-git-server.ts). The private-host rule is a vitest case: the
// test stack sets SCANTOR_GIT_ALLOW_PRIVATE=true.

const test = base.extend<{ credentials: CredentialsFixture; gitServer: GitServer }>({
  user: [tenantFixture('user'), { scope: 'worker', timeout: 180_000 }],
  otherUser: [tenantFixture('other'), { scope: 'worker', timeout: 180_000 }],
  credentials: credentialsFixture,
  gitServer: async ({}, use) => {
    const server = await startGitServer()
    try {
      await use(server)
    } finally {
      await server.close()
    }
  },
})

const COMMIT = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/

function importGit(api: ApiClient, body: Record<string, unknown>) {
  return api.call<ImportGitResult>('importGitTask', { body })
}

function pullGit(api: ApiClient, task: string, body: { force?: boolean } = {}) {
  return api.call<PullGitResult>('pullGitTask', { path: { task }, body })
}

function writeFiles(api: ApiClient, task: string, files: Record<string, string>) {
  return api.call('writeTaskFiles', { path: { task }, body: { files } })
}

/**
 * Imports a fixtures-server repository whose task names are fixed. A task of the same name from an earlier test of
 * this worker may still be being deleted (then it is hidden and the import answers 409 alreadyExists until the
 * taskDelete job finished), so the import is retried until the name is free; a live task of that name is a leftover
 * and fails at once.
 */
async function importFixedNames(api: ApiClient, tasks: TasksFixture, names: string[], body: Record<string, unknown>) {
  for (const name of names) {
    tasks.track(name)
    expect((await api.getTask(name)).status, `a live task ${name} is left over from an earlier test`).toBe(404)
  }
  let response = await importGit(api, body)
  await expect
    .poll(
      async () => {
        if (response.status === 409) response = await importGit(api, body)
        return response.status
      },
      { timeout: 120_000, intervals: [1000, 2000, 3000], message: `the names ${names.join(', ')} stay taken` },
    )
    .not.toBe(409)
  return response
}

async function readAllFiles(api: ApiClient, task: string): Promise<TaskFileContent[]> {
  const listing = ok(await listTaskFiles(api, task), 'listTaskFiles')
  const files = []
  for (const entry of listing.entries.filter((e) => e.type === 'file')) {
    files.push(ok(await api.call<TaskFileContent>('readTaskFile', { path: { task }, query: { path: entry.path } }), 'readTaskFile'))
  }
  return files
}

test.describe('import', () => {
  test('a repository with one manifest imports it with its git source', { tag: ['@GIT-001'] }, async ({ api, tasks }) => {
    const response = await importFixedNames(api, tasks, ['git-single'], { url: GIT_REPOS.single })
    expect(response.status).toBe(201)
    expect(response.body.candidates).toEqual([{ path: '.', name: 'git-single', language: 'python', exists: true }])
    expect(response.body.imported).toHaveLength(1)
    const task = response.body.imported[0]!
    expect(task).toMatchObject({ name: 'git-single', language: 'python', revisionCount: 0, latestRevision: null })
    expect(task.source.kind).toBe('git')
    expect(task.source.git).toEqual({
      url: GIT_REPOS.single,
      ref: 'HEAD',
      path: '.',
      credentialId: null,
      commit: expect.stringMatching(COMMIT),
      packSha256: expect.stringMatching(SHA256),
      pulledAt: expect.any(String),
    })
    expect(task.workspace.lastSyncSha256).toBe(task.source.git!.packSha256)
    expect(task.workspace.packSha256).toBe(task.source.git!.packSha256)

    const stored = ok(await api.getTask('git-single'), 'getTask')
    expect(stored.source).toEqual(task.source)
    const files = ok(await listTaskFiles(api, 'git-single'), 'listTaskFiles')
    expect(files.entries.map((e) => e.path)).toEqual(expect.arrayContaining(['Dockerfile', 'main.py', 'scantor.yaml']))
  })

  test('several manifests return candidates until select names the folders to import', { tag: ['@GIT-002', '@GIT-004'] }, async ({ api, tasks }) => {
    const listed = await importFixedNames(api, tasks, ['git-multi-alpha', 'git-multi-beta'], { url: GIT_REPOS.multi })
    expect(listed.status).toBe(200)
    expect(listed.body.imported).toEqual([])
    expect(listed.body.candidates).toEqual([
      { path: 'alpha', name: 'git-multi-alpha', language: 'python', exists: false },
      { path: 'beta', name: 'git-multi-beta', language: 'python', exists: false },
    ])
    expect((await api.getTask('git-multi-alpha')).status).toBe(404)

    const beta = await importGit(api, { url: GIT_REPOS.multi, select: ['beta'] })
    expect(beta.status).toBe(201)
    expect(beta.body.imported.map((task) => [task.name, task.source.git?.path])).toEqual([['git-multi-beta', 'beta']])
    expect((await api.getTask('git-multi-alpha')).status).toBe(404)

    // An existing name is reported as such and cannot be imported again.
    const again = await importGit(api, { url: GIT_REPOS.multi })
    expect(again.status).toBe(200)
    expect(again.body.candidates.map((c: GitImportCandidate) => [c.name, c.exists])).toEqual([
      ['git-multi-alpha', false],
      ['git-multi-beta', true],
    ])
    const taken = await importGit(api, { url: GIT_REPOS.multi, select: ['beta'] })
    expect(taken.status).toBe(409)
    expect(errorOf(taken).code).toBe('alreadyExists')

    const both = await importGit(api, { url: GIT_REPOS.multi, select: ['alpha'] })
    expect(both.status).toBe(201)
    expect(both.body.imported.map((task) => task.name)).toEqual(['git-multi-alpha'])
    expect(both.body.candidates.every((c: GitImportCandidate) => c.exists)).toBe(true)
  })

  test('selecting a path without a candidate or two folders of one task name is a bad request', { tag: ['@GIT-003'] }, async ({ api, gitServer }) => {
    const alpha = unique('alpha')
    const twin = unique('twin')
    await gitServer.createRepo('three', {
      ...prefixed('alpha', pythonTaskFiles(alpha)),
      ...prefixed('beta', pythonTaskFiles(twin)),
      ...prefixed('gamma', pythonTaskFiles(twin, { text: 'gamma' })),
      'docs/README.md': '# no task here\n',
    })
    const listed = ok(await importGit(api, { url: gitServer.url('three') }), 'importGitTask')
    expect(listed.candidates.map((c) => c.path)).toEqual(['alpha', 'beta', 'gamma'])

    for (const select of [['alpha', 'missing'], ['docs'], ['beta', 'gamma']]) {
      const response = await importGit(api, { url: gitServer.url('three'), select })
      expect(response.status, select.join(',')).toBe(400)
      expect(errorOf(response).code).toBe('badRequest')
    }
    for (const name of [alpha, twin]) expect((await api.getTask(name)).status).toBe(404)
  })

  test('importing a name the caller already uses is 409 alreadyExists', { tag: ['@GIT-004'] }, async ({ api, gitServer, tasks }) => {
    const name = unique('dup')
    tasks.track(name)
    await gitServer.createRepo('dup', pythonTaskFiles(name))
    expect((await importGit(api, { url: gitServer.url('dup') })).status).toBe(201)
    const again = await importGit(api, { url: gitServer.url('dup') })
    expect(again.status).toBe(409)
    expect(errorOf(again).code).toBe('alreadyExists')
  })

  test('a folder without a valid manifest is 422 manifestInvalid', { tag: ['@GIT-005'] }, async ({ api, gitServer }) => {
    const name = unique('bad')
    await gitServer.createRepo('empty', { 'README.md': '# nothing to import\n' })
    await gitServer.createRepo('elsewhere', { ...prefixed('task', pythonTaskFiles(name)), 'docs/README.md': 'docs\n' })
    await gitServer.createRepo('invalid', { ...pythonTaskFiles(name), 'scantor.yaml': `scantor: 1\nname: ${name}\nlanguage: python\nunknownKey: true\n` })
    await gitServer.createRepo('language', { ...pythonTaskFiles(name), 'scantor.yaml': `scantor: 1\nname: ${name}\nlanguage: cobol\n` })

    const cases: [string, Record<string, unknown>, RegExp][] = [
      ['a repository without scantor.yaml', { url: gitServer.url('empty') }, /no scantor\.yaml was found/],
      ['a path without scantor.yaml', { url: gitServer.url('elsewhere'), path: 'docs' }, /no scantor\.yaml was found/],
      ['an invalid manifest', { url: gitServer.url('invalid') }, /unknownKey|additional|not allowed/i],
      ['an unknown language', { url: gitServer.url('language') }, /cobol|language/i],
    ]
    for (const [label, body, message] of cases) {
      const response = await importGit(api, body)
      expect(response.status, label).toBe(422)
      expect(errorOf(response).code, label).toBe('manifestInvalid')
      const errors = errorOf(response).details?.errors as { phase: string; file: string; message: string }[]
      expect(errors.length, label).toBeGreaterThan(0)
      expect(errors[0], label).toMatchObject({ phase: 'static', file: expect.stringContaining('scantor.yaml') })
      expect(errors.map((e) => e.message).join('\n'), label).toMatch(message)
    }
    expect((await api.getTask(name)).status).toBe(404)
  })

  test('URLs other than plain https are rejected at path url', { tag: ['@GIT-006'] }, async ({ api }) => {
    const urls = [
      'http://git.scantor.localhost/single.git',
      'git://git.scantor.localhost/single.git',
      'ssh://git@git.scantor.localhost/single.git',
      'file:///etc/passwd',
      'ext::sh -c touch% /tmp/pwned',
      '-uhttps://git.scantor.localhost/single.git',
      '--upload-pack=touch /tmp/pwned',
      'https://user:secret@git.scantor.localhost/single.git',
      'https://user@git.scantor.localhost/single.git',
      'not a url',
    ]
    for (const url of urls) {
      const response = await importGit(api, { url })
      expect(response.status, url).toBe(400)
      expect(errorOf(response).code, url).toBe('validationFailed')
      expect(issuePaths(response), url).toContain('url')
    }
  })

  test('an unresolvable host is 422 gitFailed', { tag: ['@GIT-006'] }, async ({ api }) => {
    const response = await importGit(api, { url: `https://${unique('nohost')}.invalid/repo.git` })
    expect(response.status).toBe(422)
    expect(errorOf(response).code).toBe('gitFailed')
    expect(typeof errorOf(response).details?.message).toBe('string')
  })

  test('redirects are not followed', { tag: ['@GIT-006'] }, async ({ api, gitServer }) => {
    const name = unique('target')
    await gitServer.createRepo('target', pythonTaskFiles(name))
    gitServer.redirect('moved', gitServer.url('target'))

    const response = await importGit(api, { url: gitServer.url('moved') })
    expect(response.status).toBe(422)
    expect(errorOf(response).code).toBe('gitFailed')
    expect(gitServer.requests.some((request) => request.path.startsWith('/moved.git/'))).toBe(true)
    expect(gitServer.requests.some((request) => request.path.startsWith('/target.git/'))).toBe(false)
    expect((await api.getTask(name)).status).toBe(404)
  })

  test('a failed fetch is 422 gitFailed with the credential redacted', { tag: ['@GIT-007'] }, async ({ api, credentials, gitServer }) => {
    // The server answers with a git ERR packet quoting the Authorization header and password it received.
    gitServer.echoCredential('echo')
    const secret = `sekret-${token(10)}`
    const credential = await credentials.add({ name: unique('cred'), host: gitServer.host, username: 'robot', token: secret })

    const response = await importGit(api, { url: gitServer.url('echo'), credentialId: credential.id })
    expect(response.status).toBe(422)
    expect(errorOf(response).code).toBe('gitFailed')
    const message = String(errorOf(response).details?.message)
    expect(message).toContain('received')
    expect(gitServer.requests[0]?.authorization).toBe(`Basic ${Buffer.from(`robot:${secret}`).toString('base64')}`)
    const body = response.raw.toString('utf8')
    for (const leaked of [secret, Buffer.from(`robot:${secret}`).toString('base64')]) expect(body).not.toContain(leaked)
    expect(message).toContain('[REDACTED]')
  })

  test('a symlink in the selected folder is 422 invalidPath', { tag: ['@GIT-007'] }, async ({ api, gitServer }) => {
    const name = unique('link')
    await gitServer.createRepo('symlink', { ...pythonTaskFiles(name), 'helper.py': { symlink: 'main.py' } })
    const response = await importGit(api, { url: gitServer.url('symlink') })
    expect((await api.getTask(name)).status).toBe(404)
    expect(response.status).toBe(422)
    expect(errorOf(response).message).toContain('symlinks are not supported in imported tasks')
    expect(errorOf(response).code).toBe('invalidPath')
    expect(errorOf(response).details?.path).toBe('helper.py')
  })

  test('a private repository imports with the caller’s credential, without .git or the token in the folder', { tag: ['@GIT-008', '@GIT-007'] }, async ({
    api,
    credentials,
    tasks,
  }) => {
    const host = new URL(GIT_URL).host
    const denied = await importGit(api, { url: GIT_REPOS.private })
    expect(denied.status).toBe(422)
    expect(errorOf(denied).code).toBe('gitFailed')

    const credential = await credentials.add({ name: unique('cred'), host, username: PRIVATE_GIT_CREDENTIAL.username, token: PRIVATE_GIT_CREDENTIAL.token })
    expect(credential.lastUsedAt).toBeNull()
    const startedAt = Date.now()
    const response = await importFixedNames(api, tasks, ['git-private'], { url: GIT_REPOS.private, credentialId: credential.id })
    expect(response.status).toBe(201)
    const task = response.body.imported[0]!
    expect(task.source.git).toMatchObject({ url: GIT_REPOS.private, credentialId: credential.id })

    const used = ok(await api.call<{ items: Credential[] }>('listCredentials'), 'listCredentials').items.find((item) => item.id === credential.id)
    expect(used?.lastUsedAt).not.toBeNull()
    expect(Date.parse(used!.lastUsedAt!)).toBeGreaterThanOrEqual(startedAt - 1000)

    const listing = ok(await listTaskFiles(api, task.id), 'listTaskFiles')
    expect(listing.entries.length).toBeGreaterThan(0)
    for (const entry of listing.entries) expect(entry.path.split('/'), entry.path).not.toContain('.git')
    for (const file of await readAllFiles(api, task.id)) {
      const content = file.encoding === 'base64' ? Buffer.from(file.content, 'base64').toString('utf8') : file.content
      expect(content, file.path).not.toContain(PRIVATE_GIT_CREDENTIAL.token)
    }
  })

  test('a credential for another host is a bad request and its token is never sent', { tag: ['@GIT-008'] }, async ({ api, credentials, gitServer }) => {
    const name = unique('private')
    await gitServer.createRepo('private', pythonTaskFiles(name), { auth: { username: 'robot', token: 'right-token' } })
    const credential = await credentials.add({ name: unique('cred'), host: 'github.com', username: 'robot', token: 'right-token' })

    const response = await importGit(api, { url: gitServer.url('private'), credentialId: credential.id })
    expect(response.status).toBe(400)
    expect(errorOf(response).code).toBe('badRequest')
    expect(gitServer.requests).toEqual([])
    const unused = ok(await api.call<{ items: Credential[] }>('listCredentials'), 'listCredentials').items.find((item) => item.id === credential.id)
    expect(unused?.lastUsedAt).toBeNull()
  })

  test('another user’s credential is 404', { tag: ['@GIT-008'] }, async ({ api, credentials, gitServer, otherApi }) => {
    const name = unique('private')
    await gitServer.createRepo('private', pythonTaskFiles(name), { auth: { username: 'robot', token: 'right-token' } })
    const foreign = await credentials.add({ name: unique('cred'), host: gitServer.host, username: 'robot', token: 'right-token' }, otherApi)

    const response = await importGit(api, { url: gitServer.url('private'), credentialId: foreign.id })
    expect(response.status).toBe(404)
    expect(errorOf(response).code).toBe('notFound')
    expect(gitServer.requests).toEqual([])
    expect((await api.getTask(name)).status).toBe(404)
  })
})

test.describe('pull', () => {
  test('reports an unchanged remote and fast-forwards a changed one without publishing', { tag: ['@GIT-009'] }, async ({ api, gitServer, tasks }) => {
    const name = unique('pull')
    tasks.track(name)
    await gitServer.createRepo('pull', pythonTaskFiles(name))
    const imported = ok(await importGit(api, { url: gitServer.url('pull') }), 'importGitTask').imported[0]!
    const firstCommit = imported.source.git!.commit
    expect(firstCommit).toBe(await gitServer.head('pull'))

    const unchanged = await pullGit(api, name)
    expect(unchanged.status).toBe(200)
    expect(unchanged.body).toMatchObject({ previousCommit: firstCommit, commit: firstCommit, changed: false })

    const secondCommit = await gitServer.commit('pull', { 'main.py': pythonTaskFiles(name, { text: 'pulled' })['main.py']! })
    const pulled = await pullGit(api, name)
    expect(pulled.status).toBe(200)
    expect(pulled.body).toMatchObject({ previousCommit: firstCommit, commit: secondCommit, changed: true })
    const task = pulled.body.task
    expect(task.source.git).toMatchObject({ commit: secondCommit, packSha256: task.workspace.packSha256 })
    expect(task.source.git!.packSha256).not.toBe(imported.source.git!.packSha256)
    expect(Date.parse(task.source.git!.pulledAt)).toBeGreaterThan(Date.parse(imported.source.git!.pulledAt))
    expect(task.workspace.lastSyncSha256).toBe(task.source.git!.packSha256)
    expect(task).toMatchObject({ revisionCount: 0, latestRevision: null })

    const main = ok(await api.call<TaskFileContent>('readTaskFile', { path: { task: name }, query: { path: 'main.py' } }), 'readTaskFile')
    expect(main.content).toContain('"pulled"')
    const revisions = ok(await api.call<{ items: unknown[] }>('listRevisions', { path: { task: name } }), 'listRevisions')
    expect(revisions.items).toEqual([])
  })

  test('a fixtures-server copy fast-forwards, then diverges until forced', { tag: ['@GIT-009', '@GIT-010'] }, async ({ api, tasks }) => {
    const url = await copyGitRepo(api.request, 'diverge')
    const imported = await importFixedNames(api, tasks, ['git-diverge'], { url })
    expect(imported.status).toBe(201)
    const base = imported.body.imported[0]!

    await moveGitMain(api.request, url, 'advanced')
    const forward = ok(await pullGit(api, 'git-diverge'), 'pullGitTask')
    expect(forward).toMatchObject({ previousCommit: base.source.git!.commit, changed: true })
    expect(forward.commit).not.toBe(base.source.git!.commit)
    const description = ok(await api.call<TaskFileContent>('readTaskFile', { path: { task: 'git-diverge' }, query: { path: 'scantor.yaml' } }), 'readTaskFile')
    expect(description.content).toContain('fast-forward commit')

    await moveGitMain(api.request, url, 'rewritten')
    const diverged = await pullGit(api, 'git-diverge')
    expect(diverged.status).toBe(409)
    expect(errorOf(diverged).code).toBe('gitDiverged')
    expect(ok(await api.getTask('git-diverge'), 'getTask').source.git!.commit).toBe(forward.commit)

    const forced = ok(await pullGit(api, 'git-diverge', { force: true }), 'pullGitTask')
    expect(forced).toMatchObject({ previousCommit: forward.commit, changed: true })
    const rewritten = ok(await api.call<TaskFileContent>('readTaskFile', { path: { task: 'git-diverge' }, query: { path: 'scantor.yaml' } }), 'readTaskFile')
    expect(rewritten.content).toContain('rewritten history')
  })

  test('local changes since the import make a pull diverge until forced', { tag: ['@GIT-010'] }, async ({ api, gitServer, tasks }) => {
    const name = unique('local')
    tasks.track(name)
    await gitServer.createRepo('local', pythonTaskFiles(name))
    ok(await importGit(api, { url: gitServer.url('local') }), 'importGitTask')
    const remoteCommit = await gitServer.commit('local', { 'notes.txt': 'from the remote\n' })
    ok(await writeFiles(api, name, { 'local.txt': 'edited in the workspace\n' }), 'writeTaskFiles')

    const diverged = await pullGit(api, name)
    expect(diverged.status).toBe(409)
    expect(errorOf(diverged).code).toBe('gitDiverged')
    const kept = ok(await listTaskFiles(api, name), 'listTaskFiles').entries.map((e) => e.path)
    expect(kept).toContain('local.txt')
    expect(kept).not.toContain('notes.txt')

    const forced = ok(await pullGit(api, name, { force: true }), 'pullGitTask')
    expect(forced).toMatchObject({ commit: remoteCommit, changed: true })
    const replaced = ok(await listTaskFiles(api, name), 'listTaskFiles').entries.map((e) => e.path)
    expect(replaced).toContain('notes.txt')
    expect(replaced).not.toContain('local.txt')
  })

  test('a task not imported from git cannot be pulled', { tag: ['@GIT-011'] }, async ({ api, tasks }) => {
    const name = unique('scaffold')
    tasks.track(name)
    ok(await api.call<Task>('createTask', { body: { name, language: 'python' } }), 'createTask')
    const response = await pullGit(api, name)
    expect(response.status).toBe(409)
    expect(errorOf(response).code).toBe('invalidState')
  })

  test('a pulled manifest naming a different task is 422 manifestInvalid', { tag: ['@GIT-011'] }, async ({ api, gitServer, tasks }) => {
    const name = unique('rename')
    tasks.track(name)
    await gitServer.createRepo('rename', pythonTaskFiles(name))
    const imported = ok(await importGit(api, { url: gitServer.url('rename') }), 'importGitTask').imported[0]!
    await gitServer.commit('rename', { 'scantor.yaml': pythonTaskFiles(unique('other'))['scantor.yaml']! })

    const response = await pullGit(api, name)
    expect(response.status).toBe(422)
    expect(errorOf(response).code).toBe('manifestInvalid')
    expect(JSON.stringify(errorOf(response).details?.errors)).toContain('task names are immutable')
    const task = ok(await api.getTask(name), 'getTask')
    expect(task.source.git!.commit).toBe(imported.source.git!.commit)
    expect(task.workspace.packSha256).toBe(imported.workspace.packSha256)
  })
})

test.describe('revisions of imported tasks', () => {
  test('record the git source, clean or dirty', { tag: ['@GIT-012'] }, async ({ api, gitServer, tasks }) => {
    const name = unique('gitrev')
    tasks.track(name)
    await gitServer.createRepo('rev', pythonTaskFiles(name))
    const imported = ok(await importGit(api, { url: gitServer.url('rev') }), 'importGitTask').imported[0]!
    const git = imported.source.git!

    const clean = ok(await api.publishRevision(name), 'publishRevision')
    expect(clean.source).toMatchObject({ kind: 'git', packSha256: git.packSha256 })
    expect(clean.source.git).toEqual({ url: git.url, ref: 'HEAD', path: '.', commit: git.commit, dirty: false })

    ok(await writeFiles(api, name, { 'extra.txt': 'a local edit\n' }), 'writeTaskFiles')
    const dirty: Revision = ok(await api.publishRevision(name), 'publishRevision')
    expect(dirty.number).toBe(clean.number + 1)
    expect(dirty.source.kind).toBe('workspace')
    expect(dirty.source.packSha256).not.toBe(git.packSha256)
    expect(dirty.source.git).toEqual({ url: git.url, ref: 'HEAD', path: '.', commit: git.commit, dirty: true })
  })
})

/** The files of a task folder placed under `dir/`. */
function prefixed<T>(dir: string, files: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(files).map(([path, content]) => [`${dir}/${path}`, content]))
}
