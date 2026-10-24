import type { Page, Request, Route } from '@playwright/test'
import type { InstanceInfo } from '#shared/types/instance'
import { ok } from '../helpers/api-client'
import { env } from '../helpers/env'
import { expectToast, openTab } from '../helpers/ui'
import {
  alertBox,
  createScaffoldTask,
  editorStatus,
  freshTenantHandle,
  fulfillError,
  fulfillJson,
  openPage,
  patchJsonResponse,
  reloadPage,
  revisitTab,
  startEditorAndWait,
  stopEditorAndWait,
  waitForEditorState,
  nodeRouted,
  workerTenant,
} from '../helpers/ui-shell-tasks'
import { expect, test as base, unique } from '../fixtures'

// The worker's tenant and fresh users under session files of their own (sign-ins wait out a 429), and the requests of
// the dashboard and the editor sent from Node except their documents, which load in Chromium: it blocks the editor
// iframe of a fulfilled document (helpers/ui-shell-tasks.ts).
const test = base.extend({
  user: [workerTenant, { scope: 'worker' }],
  freshUserHandle: freshTenantHandle,
  context: nodeRouted({ documents: false, origins: [env.editorUrl] }),
})

// The editor page and the account's editor section (docs/ui.md §5.10, §5.17, docs/editor.md). Real editors run only
// for `freshUser` (an editor is account-level state, docs/testing.md §9); the start failure, the 429 of a full
// instance and `features.editor: false` cannot be produced on the shared stack and are answered by route mocks.

/** code-server's workbench needs the image's first start; a cold start may take a minute. */
const EDITOR_START_MS = 90_000

const WORKSPACE_ROOT = '/home/coder/workspace'

function editorFrame(page: Page) {
  return page.locator('iframe[title="Editor"]')
}

/** The editor page's navbar: the root of the navbar around the panel title "Editor". */
function navbar(page: Page) {
  return page.locator('#scantor-dashboard-panel-editor h1[data-slot="title"]').locator('xpath=ancestor::*[@data-slot="root"][1]')
}

function isSessionRequest(method: string, url: string): boolean {
  return method === 'POST' && new URL(url).pathname === '/api/editor/session'
}

/**
 * Waits until the iframe shows code-server's workbench; returns the iframe's src. Starting an editor creates a container
 * in the inner dockerd, whose network changes can fail the iframe's own navigation with net::ERR_NETWORK_CHANGED
 * (docs/testing.md §9); then the page is reloaded, which signs a new iframe in with a fresh session URL.
 */
async function expectWorkbench(page: Page, editorUrl: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    let networkChanged = false
    const onFailed = (request: Request) => {
      if (request.url().startsWith(editorUrl) && request.failure()?.errorText.includes('ERR_NETWORK_CHANGED')) networkChanged = true
    }
    page.on('requestfailed', onFailed)
    try {
      const frame = editorFrame(page)
      await expect(frame).toBeVisible({ timeout: EDITOR_START_MS })
      const workbench = page.frameLocator('iframe[title="Editor"]').locator('.monaco-workbench')
      await expect
        .poll(async () => networkChanged || (await workbench.isVisible()), { timeout: EDITOR_START_MS, message: 'the code-server workbench in the iframe' })
        .toBe(true)
      if (await workbench.isVisible()) {
        const src = (await frame.getAttribute('src'))!
        expect(src.startsWith(`${editorUrl}/_auth?code=`), src).toBe(true)
        return src
      }
    } finally {
      page.off('requestfailed', onFailed)
    }
    if (attempt >= 5) throw new Error('the editor iframe failed with net::ERR_NETWORK_CHANGED five times')
    await reloadPage(page)
  }
}

/** The URL of the iframe's document once the one-time code was exchanged for the editor cookie. */
async function frameLanding(page: Page, editorUrl: string): Promise<URL> {
  let landing: URL | undefined
  await expect
    .poll(() => {
      const frame = page.frames().find((candidate) => candidate.url().startsWith(editorUrl) && !candidate.url().includes('/_auth'))
      landing = frame ? new URL(frame.url()) : undefined
      return landing?.pathname
    })
    .toBe('/')
  return landing!
}

test.describe('editor of a fresh user', () => {
  test.use({ pageUser: 'fresh' })

  test(
    'starts the editor, opens the task folder in code-server from the editor origin, opens a new tab and stops after confirmation',
    { tag: ['@UI-EDIT-001', '@UI-EDIT-002', '@UI-EDIT-003', '@UI-EDIT-004'] },
    async ({ page, freshApi, env }) => {
      test.setTimeout(180_000)
      const name = unique('edit')
      await createScaffoldTask(freshApi, name)
      expect((await editorStatus(freshApi)).state).toBe('stopped')

      const session = page.waitForRequest((request) => isSessionRequest(request.method(), request.url()))
      await openPage(page, `/editor?task=${name}`)
      await expect(page).toHaveTitle('Editor · scantor')
      expect((await session).postDataJSON()).toEqual({ open: name })
      await expect(page.getByText('Editor is starting…')).toBeVisible()

      const src = await expectWorkbench(page, env.editorUrl)
      const landing = await frameLanding(page, env.editorUrl)
      expect(landing.origin).toBe(env.editorUrl)
      expect(landing.searchParams.get('folder')).toBe(`${WORKSPACE_ROOT}/${name}`)

      // Navbar: the state and the idle timeout.
      const status = await waitForEditorState(freshApi, ['running'])
      await expect(navbar(page).locator('[data-state="running"]')).toBeVisible()
      await expect(navbar(page).getByText(`stops after ${Math.round(status.idleTimeoutMs / 60_000)} min idle`)).toBeVisible()

      // "Open in new tab" asks for a fresh one-time URL and opens it in a new tab.
      const fresh = page.waitForResponse((response) => isSessionRequest(response.request().method(), response.url()))
      const [tab] = await Promise.all([page.context().waitForEvent('page'), page.getByRole('button', { name: 'Open in new tab' }).click()])
      const freshUrl = ((await (await fresh).json()) as { url: string }).url
      expect(freshUrl.startsWith(`${env.editorUrl}/_auth?code=`)).toBe(true)
      expect(freshUrl).not.toBe(src)
      await tab.waitForURL((url) => url.origin === env.editorUrl && url.pathname === '/', { timeout: 30_000 })
      expect(new URL(tab.url()).searchParams.get('folder')).toBe(`${WORKSPACE_ROOT}/${name}`)
      await expect(tab.locator('.monaco-workbench')).toBeVisible({ timeout: 60_000 })
      await tab.close()

      // "Stop editor": Cancel keeps it running, the confirmation stops it.
      await page.getByRole('button', { name: 'Stop editor' }).click()
      let dialog = page.getByRole('dialog', { name: 'Stop editor' })
      await expect(dialog).toContainText('The files in your workspace stay.')
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toBeHidden()
      await expect(editorFrame(page)).toBeVisible()
      expect((await editorStatus(freshApi)).state).toBe('running')

      await page.getByRole('button', { name: 'Stop editor' }).click()
      dialog = page.getByRole('dialog', { name: 'Stop editor' })
      await dialog.getByRole('button', { name: 'Stop editor' }).click()
      await expectToast(page, 'Editor stopped')
      await expect(editorFrame(page)).toHaveCount(0)
      await expect(page.getByText('The editor is stopped')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Open editor' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Stop editor' })).toBeDisabled()
      expect(['stopping', 'stopped']).toContain((await editorStatus(freshApi)).state)
    },
  )

  test(
    'an editor stopped elsewhere disappears, one restarted elsewhere is reloaded with a fresh session; the account section stops it',
    { tag: ['@UI-EDIT-006', '@UI-ACCT-007'] },
    async ({ page, freshApi, env }) => {
      test.setTimeout(180_000)
      await openPage(page, '/editor')
      const first = await expectWorkbench(page, env.editorUrl)

      // Stopped from another browser: the next poll (run at once by a tab switch) removes the iframe.
      await stopEditorAndWait(freshApi)
      await revisitTab(page)
      await expect(editorFrame(page)).toHaveCount(0)
      await expect(page.getByText('The editor is stopped')).toBeVisible()

      // "Open editor" starts it again with a fresh session.
      await page.getByRole('button', { name: 'Open editor' }).click()
      const second = await expectWorkbench(page, env.editorUrl)
      expect(second).not.toBe(first)

      // Restarted from another browser between two polls: the page signs the iframe in to the new editor. The page's
      // polls are held while the editor restarts, so none of them sees the short stopped phase in between.
      let release: () => void = () => {}
      const restarted = new Promise<void>((resolve) => (release = resolve))
      const holdPolls = async (route: Route) => {
        if (route.request().method() === 'GET') await restarted
        await route.fallback()
      }
      await page.route((url) => url.pathname === '/api/editor', holdPolls)
      const before = (await editorStatus(freshApi)).startedAt
      await stopEditorAndWait(freshApi)
      const after = await startEditorAndWait(freshApi, EDITOR_START_MS)
      expect(after.startedAt).not.toBe(before)
      const reopened = page.waitForRequest((request) => isSessionRequest(request.method(), request.url()), { timeout: 15_000 })
      release()
      await revisitTab(page)
      await reopened
      await page.unroute((url) => url.pathname === '/api/editor', holdPolls)
      await expect.poll(async () => editorFrame(page).getAttribute('src'), { timeout: EDITOR_START_MS }).not.toBe(second)
      const third = await expectWorkbench(page, env.editorUrl)
      expect([first, second]).not.toContain(third)

      // The account's editor section shows the state, links the editor page and stops it after confirmation.
      await openPage(page, '/account')
      const section = page.locator('section[aria-labelledby="editor-heading"]')
      await expect(section.locator('[data-state="running"]')).toBeVisible()
      await expect(section.getByRole('link', { name: 'Open editor' })).toHaveAttribute('href', '/editor')
      await expect(section.getByText(/It stops after \d+ min idle\./)).toBeVisible()
      await section.getByRole('button', { name: 'Stop editor' }).click()
      const dialog = page.getByRole('dialog', { name: 'Stop editor' })
      await dialog.getByRole('button', { name: 'Stop editor' }).click()
      await expectToast(page, 'Editor stopped')
      await expect(section.locator('[data-state="stopped"]')).toBeVisible({ timeout: 30_000 })
      await expect(section.getByRole('button', { name: 'Stop editor' })).toBeDisabled()
      expect((await waitForEditorState(freshApi, ['stopped'])).state).toBe('stopped')
      await expect(section.getByText('The last start failed')).toHaveCount(0)
    },
  )
})

test.describe('editor page states', () => {
  const stoppedWithError = (error: string) => ({ state: 'stopped', startedAt: null, lastActivityAt: null, idleTimeoutMs: 180_000, error })

  test('an unknown task offers "Open workspace", which opens the editor on the workspace root', { tag: ['@UI-EDIT-002'] }, async ({ page, api, env }) => {
    const missing = unique('nosuchtask')
    expect((await api.getTask(missing)).status).toBe(404)
    const notFound = page.waitForResponse((response) => isSessionRequest(response.request().method(), response.url()))
    await openPage(page, `/editor?task=${missing}`)
    const response = await notFound
    expect(response.status()).toBe(404)
    expect(response.request().postDataJSON()).toEqual({ open: missing })
    const alert = alertBox(page, `Task “${missing}” was not found`)
    await expect(alert).toBeVisible()
    await expect(page.getByRole('region', { name: /notifications/i }).locator('li[data-state="open"]')).toHaveCount(0)

    // The worker's tenant never runs a real editor: the start on the workspace root is answered here.
    const sessions: unknown[] = []
    await page.route(
      (url) => url.pathname === '/api/editor/session',
      (route) => {
        sessions.push(route.request().postDataJSON())
        return fulfillJson(
          route,
          {
            url: `${env.editorUrl}/_auth?code=sec_mocked`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            editor: { state: 'starting', startedAt: new Date().toISOString(), lastActivityAt: null },
          },
          201,
        )
      },
    )
    await page.route(
      (url) => url.pathname === '/api/editor',
      (route) => fulfillJson(route, { state: 'starting', startedAt: new Date().toISOString(), lastActivityAt: null, idleTimeoutMs: 180_000, error: null }),
    )
    await alert.getByRole('button', { name: 'Open workspace' }).click()
    await expect(page).toHaveURL((url) => url.pathname === '/editor' && url.search === '')
    await expect(page.getByText('Editor is starting…')).toBeVisible()
    expect(sessions).toEqual([{}])
  })

  test('a failed start shows the error with "Retry"; a full instance shows "Too many editors are running"', { tag: ['@UI-EDIT-005'] }, async ({ page }) => {
    const message = `the editor container exited: ${unique('boom')}`
    await page.route(
      (url) => url.pathname === '/api/editor',
      (route) => fulfillJson(route, stoppedWithError(message)),
    )
    const sessions: unknown[] = []
    await page.route(
      (url) => url.pathname === '/api/editor/session',
      (route) => {
        sessions.push(route.request().postDataJSON())
        return fulfillError(route, { status: 429, code: 'tooManyRequests', message: 'Too many editors are running', details: { limit: 10 } })
      },
    )

    await openPage(page, '/editor')
    const failed = alertBox(page, 'The editor could not start')
    await expect(failed).toBeVisible()
    await expect(failed).toContainText(message)
    // A failed start is shown, not retried by itself.
    expect(sessions).toEqual([])

    await failed.getByRole('button', { name: 'Retry' }).click()
    const busy = alertBox(page, 'Too many editors are running; try again later')
    await expect(busy).toBeVisible()
    await expect(busy.getByRole('button', { name: 'Retry' })).toBeVisible()
    expect(sessions).toEqual([{}])
    await expect(editorFrame(page)).toHaveCount(0)
    // The 429 is shown inline, never as a toast.
    await expect(page.getByRole('region', { name: /notifications/i }).locator('li[data-state="open"]')).toHaveCount(0)
  })

  test('the account section shows "The last start failed" after a failed start', { tag: ['@UI-ACCT-007'] }, async ({ page }) => {
    const message = `could not start code-server: ${unique('reason')}`
    await page.route(
      (url) => url.pathname === '/api/editor',
      (route) => fulfillJson(route, stoppedWithError(message)),
    )
    await openPage(page, '/account')
    const section = page.locator('section[aria-labelledby="editor-heading"]')
    await expect(section.locator('[data-state="stopped"]')).toBeVisible()
    const failed = alertBox(section, 'The last start failed')
    await expect(failed).toBeVisible()
    await expect(failed).toContainText(message)
    await expect(section.getByRole('button', { name: 'Stop editor' })).toBeDisabled()
  })
})

test.describe('editor disabled', () => {
  test('without features.editor every editor entry point is hidden', { tag: ['@UI-NAV-002'] }, async ({ page, api, tasks }) => {
    const name = unique('noeditor')
    tasks.track(name)
    const task = await createScaffoldTask(api, name)
    const mainNavigation = page.getByRole('navigation', { name: 'Main navigation' })
    const banner = alertBox(page, `Task ${name} is ready`)

    // With the editor (the stack's default) every entry point is there.
    await openPage(page, `/tasks/${task.id}?created=1`)
    await expect(mainNavigation.getByRole('link', { name: /^Editor\b/ })).toHaveAttribute('href', '/editor')
    await expect(banner.getByRole('link', { name: 'Open the editor' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open in editor' })).toHaveCount(1)
    await openTab(page, 'Files')
    await expect(page.getByRole('link', { name: 'Open in editor' })).toHaveCount(2)

    // An orchestrator without the `api` component's editor: getInstanceInfo says so.
    await page.route(
      (url) => url.pathname === '/api/info',
      (route) => patchJsonResponse<InstanceInfo>(route, (info) => ({ ...info, features: { ...info.features, editor: false } })),
    )
    await openPage(page, `/tasks/${task.id}?created=1`)
    await expect(banner).toBeVisible()
    await expect(banner.getByRole('button', { name: 'Try a test run' })).toBeVisible()
    await expect(banner.getByRole('link', { name: 'Open the editor' })).toHaveCount(0)
    await expect(mainNavigation.getByRole('link', { name: /^Tasks\b/ })).toBeVisible()
    await expect(mainNavigation.getByRole('link', { name: /^Editor\b/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Publish revision' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open in editor' })).toHaveCount(0)
    await openTab(page, 'Files')
    await expect(page.getByRole('tree', { name: 'Task files' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open in editor' })).toHaveCount(0)
    expect(ok(await api.getTask(task.id), 'getTask').name).toBe(name)

    // The account page drops its editor section too.
    await openPage(page, '/account')
    await expect(page.getByRole('heading', { name: 'Sessions', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Editor', exact: true })).toHaveCount(0)
  })
})
