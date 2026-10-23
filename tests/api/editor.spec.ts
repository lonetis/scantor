import { randomUUID } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import type { ApiKey } from '#shared/types/account'
import type { Page } from '#shared/types/common'
import type { Job } from '#shared/types/jobs'
import { ApiClient, ok } from '../helpers/api-client'
import { withPlatformTasks } from '../helpers/api-platform-cleanup'
import {
  EDITOR_CODE,
  EDITOR_KEY,
  WORKSPACE_ROOT,
  editorCookieHeader,
  editorEnv,
  editorKey,
  editorOrigin,
  editorStatus,
  execInEditor,
  inspectEditor,
  openEditorSession,
  originGet,
  redeem,
  startEditor,
  stopEditor,
  waitForEditor,
} from '../helpers/api-platform-editor'
import { withLazyTenant, withPlatformAdmin, withWorkerTenant } from '../helpers/api-platform-tenant'
import { stackEnv } from '../helpers/docker'
import { exampleTaskDir, packTask } from '../helpers/tasks'
import { newApiContext } from '../helpers/users'
import { expect, test as base, unique } from '../fixtures'

// The browser editor through the dashboard API (docs/editor.md §5–§7, docs/api.md §4.18): one-time session URLs, the
// background start, getEditor, stop, the per-start `editor` API key, the idle stop, the listener's starting and
// stopped pages and the CLI inside the editor. Every editor belongs to the test's own `freshUser`; nothing here
// touches another user's editor. SCANTOR_EDITOR_IDLE_TIMEOUT is 3m in the test stack.

const test = base.extend<{ origin: APIRequestContext }>({
  // An admin of the worker and a tenant with a uniquely named session (helpers/api-platform-tenant.ts).
  adminApi: [async ({ openapi }, use) => withPlatformAdmin(openapi, use), { scope: 'worker', timeout: 150_000 }],
  user: [
    async ({ adminApi, openapi }, use, workerInfo) => withWorkerTenant(adminApi, openapi, `w${workerInfo.workerIndex}`, use),
    { scope: 'worker', timeout: 150_000 },
  ],
  // tasks and scans that never wait for the stack's deletion jobs (helpers/api-platform-cleanup.ts).
  tasks: async ({ api }, use) => withPlatformTasks(api, use),
  freshUserHandle: async ({ adminApi, openapi }, use) => withLazyTenant(adminApi, openapi, 'editor', use),
  // A sign-in that meets another run's 429 waits it out; it gets its own time, not the test's.
  freshUser: [async ({ freshUserHandle }, use) => use(await freshUserHandle.get()), { scope: 'test', timeout: 150_000 }],
  origin: async ({}, use) => {
    const context = await editorOrigin()
    await use(context)
    await context.dispose()
  },
})

// Tests run as their own `freshUser`; a tenant (one sign-in) is created only for the tests that use `api`.
test.use({ storageState: { cookies: [], origins: [] } })

/** `3m`, `60s` → milliseconds (the stack's .env values). */
function durationMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value.trim())
  if (!match) throw new Error(`not a duration: ${value}`)
  return Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] as 'ms' | 's' | 'm' | 'h']
}

const IDLE_TIMEOUT_MS = () => durationMs(stackEnv().SCANTOR_EDITOR_IDLE_TIMEOUT!)

/** Uploads the `echo` example into the caller's workspace under `name` without publishing it. */
async function workspaceTask(api: ApiClient, name: string): Promise<void> {
  ok(await api.uploadTask(await packTask(exampleTaskDir('echo'), { name }), { publish: false }), 'uploadTask')
}

/** An ApiClient that authenticates with a bearer key (a `default` or an `editor` API key). */
async function withKey<T>(openapi: ApiClient['openapi'], key: string, use: (client: ApiClient) => Promise<T>): Promise<T> {
  const context = await newApiContext({ headers: { Authorization: `Bearer ${key}` } })
  try {
    return await use(new ApiClient(context, openapi))
  } finally {
    await context.dispose()
  }
}

async function editorKeys(api: ApiClient): Promise<ApiKey[]> {
  return ok(await api.call<{ items: ApiKey[] }>('listApiKeys', { query: { configId: 'editor' } }), 'listApiKeys').items
}

/** The status of a key: what getAccount answers with it. */
async function keyStatus(openapi: ApiClient['openapi'], key: string): Promise<number> {
  return withKey(openapi, key, async (client) => (await client.getAccount()).status)
}

// The reaper runs every 60 s (docs/editor.md §6.4) and stops a running editor whose last activity is older than
// SCANTOR_EDITOR_IDLE_TIMEOUT.
const REAPER_INTERVAL_MS = 60_000
// How long before its idle deadline the idle test leaves the editor.
const IDLE_MARGIN_MS = 30_000

// First in the file: it waits for the reaper on one worker while the other tests run on the other.
test.describe('idle stop', () => {
  test('an idle editor stops after the idle timeout', { tag: ['@EDIT-006'] }, async ({ docker, freshApi, freshUser, openapi }) => {
    test.setTimeout(180_000)
    const idleMs = IDLE_TIMEOUT_MS()
    await startEditor(freshApi)
    const running = await editorStatus(freshApi)
    expect(running.idleTimeoutMs).toBe(idleMs)
    expect(running.lastActivityAt).not.toBeNull()
    const key = await editorKey(freshUser.id)

    // Waiting out the whole timeout would hold the file for minutes: the recorded activity (white-box, the editor's
    // document) moves back so that the editor becomes idle IDLE_MARGIN_MS from now. Nothing reaches the editor origin
    // from here on (getEditor is no editor activity), so nothing records newer activity.
    const lastActivityMs = Date.now() - idleMs + IDLE_MARGIN_MS
    const moved = await docker.mongosh(
      `print(db.editors.updateOne({ _id: ${JSON.stringify(freshUser.id)}, state: 'running' }, { $set: { lastActivityAt: new Date(${lastActivityMs}) } }).modifiedCount)`,
      { as: 'root' },
    )
    expect(moved).toBe('1')
    expect(Date.parse((await editorStatus(freshApi)).lastActivityAt!)).toBe(lastActivityMs)

    // The stop comes after the idle deadline, and at most one reaper interval later.
    const stopped = await waitForEditor(freshApi, 'stopped', IDLE_MARGIN_MS + REAPER_INTERVAL_MS + 30_000)
    expect(Date.now(), 'the editor stopped before it was idle for the timeout').toBeGreaterThanOrEqual(lastActivityMs + idleMs)
    expect(stopped.error).toBeNull()
    expect(await inspectEditor(freshUser.id)).toBeNull()
    expect(await keyStatus(openapi, key)).toBe(401)
  })
})

test.describe('editor sessions', () => {
  test(
    'a session URL is a one-time code on the editor origin and starts the editor in the background',
    { tag: ['@EDIT-001'] },
    async ({ env, freshApi, freshUser, openapi, origin }) => {
      test.setTimeout(180_000)
      const task = unique('edit-open')
      await workspaceTask(freshApi, task)

      const before = Date.now()
      const created = await openEditorSession(freshApi)
      expect(created.status).toBe(201)
      const session = created.body
      const url = new URL(session.url)
      expect(url.origin).toBe(env.editorUrl)
      expect(url.pathname).toBe('/_auth')
      expect([...url.searchParams.keys()]).toEqual(['code'])
      expect(url.searchParams.get('code')).toMatch(EDITOR_CODE)
      const expiresAt = Date.parse(session.expiresAt)
      expect(expiresAt - before).toBeGreaterThan(55_000)
      expect(expiresAt - Date.now()).toBeLessThanOrEqual(60_000)
      expect(['starting', 'running']).toContain(session.editor.state)
      expect(session.editor.startedAt).not.toBeNull()

      // The response did not wait: the editor becomes ready by itself.
      const running = await waitForEditor(freshApi, 'running')
      expect(running.startedAt).toBe(session.editor.startedAt)
      expect(running.lastActivityAt).not.toBeNull()

      // The code signs the browser in to the workspace root.
      const redeemed = await redeem(session.url)
      expect(redeemed.status, redeemed.body).toBe(302)
      expect(redeemed.headers['location']).toBe(`/?folder=${WORKSPACE_ROOT}`)
      expect(redeemed.cookie).not.toBeNull()
      const workbench = await originGet(origin, redeemed.headers['location']!, editorCookieHeader(redeemed.cookie!))
      expect(workbench.status).toBe(200)
      expect(workbench.headers['content-type']).toMatch(/^text\/html/)
      expect(workbench.body).toContain(freshUser.email)

      // `open` selects a task folder; the user's `default` API key may open sessions too. A running editor stays.
      await withKey(openapi, freshUser.apiKey, async (keyApi) => {
        const withTask = await openEditorSession(keyApi, { open: task })
        expect(withTask.body.editor).toMatchObject({ state: 'running', startedAt: session.editor.startedAt })
        expect(withTask.body.url).not.toBe(session.url)
        const opened = await redeem(withTask.body.url)
        expect(opened.status).toBe(302)
        expect(opened.headers['location']).toBe(`/?folder=${WORKSPACE_ROOT}/${task}`)
      })
      await stopEditor(freshApi)
    },
  )

  test(
    'refuses foreign, uuid-shaped and reserved task names and the editor key',
    { tag: ['@EDIT-002'] },
    async ({ api, freshApi, freshUser, openapi, tasks }) => {
      test.setTimeout(180_000)
      const foreign = unique('edit-foreign')
      tasks.track(foreign)
      await workspaceTask(api, foreign)

      for (const open of [foreign, unique('edit-missing')]) {
        const response = await freshApi.call('createEditorSession', { body: { open } })
        expect(response.status, open).toBe(404)
        expect(response.body, open).toMatchObject({ error: { code: 'notFound' } })
      }
      for (const body of [
        { open: randomUUID() },
        { open: 'new' },
        { open: 'latest' },
        { open: 'upload' },
        { open: 'import-git' },
        { open: 'Not_A_Slug' },
        { folder: '/' },
      ]) {
        const response = await freshApi.call('createEditorSession', { body })
        expect(response.status, JSON.stringify(body)).toBe(400)
        expect(response.body, JSON.stringify(body)).toMatchObject({ error: { code: 'validationFailed' } })
      }
      // None of the refused requests started an editor.
      expect((await editorStatus(freshApi)).state).toBe('stopped')

      await startEditor(freshApi)
      const key = await editorKey(freshUser.id)
      await withKey(openapi, key, async (keyApi) => {
        const refused = await keyApi.call('createEditorSession', { body: {} })
        expect(refused.status).toBe(403)
        expect(refused.body).toMatchObject({ error: { code: 'forbidden' } })
        // The key may read its own editor.
        expect(ok(await keyApi.call<{ state: string }>('getEditor'), 'getEditor').state).toBe('running')
      })
      await stopEditor(freshApi)
    },
  )
})

test.describe('editor state', () => {
  test(
    'a failed start keeps its error until the next start; the origin shows starting and stopped pages',
    { tag: ['@EDIT-003', '@EDIT-006'] },
    async ({ freshApi, freshUser, origin }) => {
      test.setTimeout(180_000)
      expect(await editorStatus(freshApi)).toEqual({ state: 'stopped', startedAt: null, lastActivityAt: null, idleTimeoutMs: IDLE_TIMEOUT_MS(), error: null })

      // Break the next start: code-server's user data directory (on the persistent home volume) becomes a file, so the
      // editor's entrypoint fails before code-server starts.
      await startEditor(freshApi)
      const sabotage = await execInEditor(freshUser.id, ['sh', '-c', 'rm -rf "$HOME/.local/share/code-server" && touch "$HOME/.local/share/code-server"'])
      expect(sabotage.exitCode, sabotage.stderr).toBe(0)
      await stopEditor(freshApi)

      const failing = await openEditorSession(freshApi)
      expect(failing.body.editor.state).toBe('starting')
      // While the editor starts, its origin serves the starting page (the code is redeemable already).
      const redeemed = await redeem(failing.body.url)
      expect(redeemed.status).toBe(302)
      const starting = await originGet(origin, '/', editorCookieHeader(redeemed.cookie!))
      expect(starting.status).toBe(503)
      expect(starting.headers['retry-after']).toBe('2')
      expect(starting.headers['content-type']).toMatch(/^text\/html/)
      expect(starting.body).toContain('Starting your editor')
      expect(starting.body).toContain('<meta http-equiv="refresh" content="2">')

      const failed = await waitForEditor(freshApi, 'stopped', 120_000)
      expect(failed.error).toMatch(/editor container exited/)
      expect(failed.startedAt).toBe(failing.body.editor.startedAt)
      // The error stays until a new start begins, and the dead editor's cookie gets the stopped page.
      expect((await editorStatus(freshApi)).error).toBe(failed.error)
      const ended = await originGet(origin, '/', editorCookieHeader(redeemed.cookie!))
      expect(ended.status).toBe(410)
      expect(ended.body).toContain('Editor stopped')

      const retry = await openEditorSession(freshApi)
      expect(retry.body.editor.state).toBe('starting')
      const restarted = await editorStatus(freshApi)
      expect(restarted).toMatchObject({ state: 'starting', error: null })
      expect(restarted.startedAt).not.toBe(failed.startedAt)
      // The cause is still there, so this start fails as well and records its own error.
      expect((await waitForEditor(freshApi, 'stopped', 120_000)).error).toMatch(/editor container exited/)
    },
  )

  test(
    'stopping removes the container and the editor key; a stopped editor stops as a no-op',
    { tag: ['@EDIT-004'] },
    async ({ freshApi, freshUser, openapi }) => {
      test.setTimeout(180_000)
      const idle = await freshApi.call('stopEditor')
      expect(idle.status).toBe(204)
      expect(await editorStatus(freshApi)).toMatchObject({ state: 'stopped', startedAt: null })

      await startEditor(freshApi)
      const key = await editorKey(freshUser.id)
      expect(await inspectEditor(freshUser.id)).not.toBeNull()
      expect(await editorKeys(freshApi)).toHaveLength(1)
      expect(await keyStatus(openapi, key)).toBe(200)

      const stopped = await freshApi.call('stopEditor')
      expect(stopped.status).toBe(204)
      const after = await editorStatus(freshApi)
      expect(after.state).toBe('stopped')
      expect(await inspectEditor(freshUser.id)).toBeNull()
      expect(await editorKeys(freshApi)).toEqual([])
      expect(await keyStatus(openapi, key)).toBe(401)

      const again = await freshApi.call('stopEditor')
      expect(again.status).toBe(204)
      expect(await editorStatus(freshApi)).toEqual(after)
    },
  )
})

test.describe('the editor key', () => {
  test(
    'every start mints one new editor key, listed but never creatable; a ban deletes it',
    { tag: ['@EDIT-005'] },
    async ({ adminApi, freshApi, freshUser, openapi }) => {
      test.setTimeout(180_000)
      await startEditor(freshApi)
      const first = await editorKey(freshUser.id)
      expect(first).toMatch(EDITOR_KEY)
      const listed = await editorKeys(freshApi)
      expect(listed).toHaveLength(1)
      expect(listed[0]).toMatchObject({ name: 'editor', configId: 'editor', enabled: true })
      expect(first.startsWith(listed[0]!.start!)).toBe(true)
      const ttl = Date.parse(listed[0]!.expiresAt!) - Date.parse(listed[0]!.createdAt)
      expect(Math.abs(ttl - durationMs(stackEnv().SCANTOR_EDITOR_API_KEY_TTL!))).toBeLessThan(10_000)
      // The default list does not show it; the API cannot create one.
      const defaults = ok(await freshApi.call<{ items: ApiKey[] }>('listApiKeys', { query: { configId: 'default' } }), 'listApiKeys').items
      expect(defaults.map((key) => key.id)).not.toContain(listed[0]!.id)
      const create = await freshApi.call('createApiKey', { body: { name: 'editor', configId: 'editor' } })
      expect(create.status).toBe(400)
      expect(create.body).toMatchObject({ error: { code: 'validationFailed' } })
      expect(await keyStatus(openapi, first)).toBe(200)

      // A restart mints a different key and deletes the old one.
      await stopEditor(freshApi)
      expect(await editorKeys(freshApi)).toEqual([])
      await startEditor(freshApi)
      const second = await editorKey(freshUser.id)
      expect(second).not.toBe(first)
      const relisted = await editorKeys(freshApi)
      expect(relisted).toHaveLength(1)
      expect(relisted[0]!.id).not.toBe(listed[0]!.id)
      expect(await keyStatus(openapi, first)).toBe(401)
      expect(await keyStatus(openapi, second)).toBe(200)

      // A ban stops the editor and deletes its key.
      expect((await adminApi.call('banUser', { path: { userId: freshUser.id }, body: { reason: 'editor key test' } })).status).toBe(200)
      expect(await keyStatus(openapi, second)).toBe(401)
      await expect.poll(() => inspectEditor(freshUser.id), { timeout: 30_000, message: "the banned user's editor is removed" }).toBeNull()
    },
  )

  test('deleting the user deletes the editor key', { tag: ['@EDIT-005'] }, async ({ adminApi, freshApi, freshUser, openapi }) => {
    test.setTimeout(180_000)
    await startEditor(freshApi)
    const key = await editorKey(freshUser.id)
    expect(await keyStatus(openapi, key)).toBe(200)
    const deleted = await adminApi.deleteUser(freshUser.id)
    expect(deleted.status).toBe(202)
    // The deletion locks the user out at once, before the userPurge job runs (docs/auth.md §5.7, §6): the key is gone
    // and the editor is stopped while the job may still be queued behind other purges.
    expect(await keyStatus(openapi, key)).toBe(401)
    const job = ok(await adminApi.call<Job>('getJob', { path: { jobId: deleted.body.job.id } }), 'getJob')
    expect(job).toMatchObject({ kind: 'userPurge', subject: { kind: 'user', id: freshUser.id } })
    await expect.poll(() => inspectEditor(freshUser.id), { timeout: 30_000, message: "the deleted user's editor is removed" }).toBeNull()
  })
})

test.describe('inside the editor', () => {
  test(
    'the CLI uses the editor key: tasks, scans and remote dev runs work, admin routes do not',
    { tag: ['@EDIT-007'] },
    async ({ adminApi, freshApi, freshUser, openapi }) => {
      test.setTimeout(300_000)
      // An admin's editor key still never has admin power.
      ok(await adminApi.call('updateUser', { path: { userId: freshUser.id }, body: { role: 'admin' } }), 'updateUser')
      const task = unique('edit-cli')
      await workspaceTask(freshApi, task)
      await startEditor(freshApi)

      const environment = await editorEnv(freshUser.id)
      const scantorVariables = Object.fromEntries(Object.entries(environment).filter(([name]) => name.startsWith('SCANTOR_')))
      expect(scantorVariables).toEqual({
        SCANTOR_URL: stackEnv().SCANTOR_INTERNAL_URL,
        SCANTOR_TOKEN: expect.stringMatching(EDITOR_KEY),
        SCANTOR_DEV_MODE: 'remote',
        SCANTOR_WORKSPACE: WORKSPACE_ROOT,
      })
      const key = scantorVariables.SCANTOR_TOKEN!

      const tasksList = await execInEditor(freshUser.id, ['scantor', 'tasks', 'list', '-o', 'json'])
      expect(tasksList.exitCode, tasksList.stderr).toBe(0)
      expect(tasksList.stdout).toContain(`"${task}"`)
      const scansList = await execInEditor(freshUser.id, ['scantor', 'scans', 'list', '-o', 'json'])
      expect(scansList.exitCode, scansList.stderr).toBe(0)
      const nodesList = await execInEditor(freshUser.id, ['scantor', 'nodes', 'list', '-o', 'json'])
      expect(nodesList.exitCode).not.toBe(0)
      expect(nodesList.stdout + nodesList.stderr).toContain('adminRequired')

      // `dev run` in a task folder of the workspace is a platform test run.
      const devRun = await execInEditor(freshUser.id, ['scantor', 'dev', 'run', '.', '--limit', '2', '-o', 'json'], {
        workdir: `${WORKSPACE_ROOT}/${task}`,
        timeoutMs: 240_000,
      })
      expect(devRun.exitCode, `${devRun.stdout}\n${devRun.stderr}`).toBe(0)
      const events = devRun.stdout
        .split('\n')
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> })
      expect(events.map((event) => event.type)).toContain('analysis')
      // A test run ends `completed` (TEST_RUN_STATES); its analyses succeeded.
      const end = events.find((event) => event.type === 'end')
      expect(end?.data).toMatchObject({ state: 'completed', summary: { failed: 0 } })
      const summary = end!.data.summary as { analyses: number; succeeded: number }
      expect(summary.succeeded).toBeGreaterThan(0)
      expect(summary.succeeded).toBe(summary.analyses)
      const runs = ok(await freshApi.call<Page<{ id: string; state: string }>>('listTestRuns', { path: { task } }), 'listTestRuns').items
      expect(runs).toHaveLength(1)
      expect(runs[0]).toMatchObject({ id: end!.data.id, state: 'completed' })

      // The key ends with the editor.
      expect(await keyStatus(openapi, key)).toBe(200)
      await stopEditor(freshApi)
      expect(await keyStatus(openapi, key)).toBe(401)
    },
  )
})
