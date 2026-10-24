import { createHash } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import type { Task } from '#shared/types/tasks'
import { ApiClient, ok } from '../helpers/api-client'
import { copyGitRepo, GIT_REPOS, GIT_URL, moveGitMain } from '../helpers/fixtures-server'
import { buildTarGz } from '../helpers/tar'
import { exampleTaskDir, packTask, waitForRevision } from '../helpers/tasks'
import { expectToast, openTab } from '../helpers/ui'
import {
  alertBox,
  cancelScanAndWait,
  createCredential,
  createScaffoldTask,
  deleteCredentialsNamed,
  deleteTaskAndWait,
  expectStorageWithout,
  fulfillError,
  fulfillJson,
  openPage,
  openToastItems,
  recordApiRequests,
  nodeRoutedContext,
  reloadPage,
  startUnplacedScan,
  workerTenant,
  writeTaskFiles,
} from '../helpers/ui-shell-tasks'
import { newApiContext } from '../helpers/users'
import { expect, test as base, unique } from '../fixtures'

// The worker's tenant under a session file of its own, and the dashboard's requests sent from Node (helpers/ui-shell-tasks.ts).
const test = base.extend({ user: [workerTenant, { scope: 'worker' }], context: nodeRoutedContext })

// Task pages (docs/ui.md §5.5–§5.7): the tasks list, the new-task wizard (scaffold, git, upload), the task page with
// its header, actions, banner, tabs, files and revisions, publishing, git pull and deletion. Error states the shared
// stack cannot produce (5xx, symlinks and truncated listings, a git repository with an invalid manifest) are answered by
// route mocks; everything else runs against the real API.

const GIT_HOST = new URL(GIT_URL).host

function row(page: Page, id: string): Locator {
  return page.locator(`tr[data-row-id="${id}"]`)
}

function taskRows(page: Page): Locator {
  return page.getByLabel('Tasks', { exact: true }).locator('tbody tr[data-row-id]')
}

function wizardSource(page: Page, title: string): Locator {
  return page.getByRole('list', { name: 'Task source' }).getByRole('button', { name: new RegExp(`^${title}`) })
}

/** The task of `id` cloned under another id and name, for mocked list pages. */
function cloneTask(task: Task, index: number, patch: Partial<Task> = {}): Task {
  return { ...task, id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, name: `${task.name}-${index}`, ...patch }
}

test.describe('tasks list', () => {
  test('filters by search and language and reloads from the start', { tag: ['@UI-TASK-001'] }, async ({ page, api, tasks }) => {
    const prefix = unique('flt')
    const python = await createScaffoldTask(api, `${prefix}-py`, { language: 'python' })
    tasks.track(python.name)
    const go = await createScaffoldTask(api, `${prefix}-go`, { language: 'go' })
    tasks.track(go.name)

    await openPage(page, '/tasks')
    let request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/tasks' && new URL(r.url()).searchParams.get('q') === prefix)
    await page.getByRole('textbox', { name: 'Search tasks' }).fill(prefix)
    expect(new URL((await request).url()).searchParams.has('cursor')).toBe(false)
    await expect(row(page, python.id)).toBeVisible()
    await expect(row(page, go.id)).toBeVisible()
    await expect(taskRows(page)).toHaveCount(2)

    request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/tasks' && new URL(r.url()).searchParams.get('language') === 'go')
    await page.getByRole('combobox', { name: 'Language' }).click()
    await page.getByRole('option', { name: 'Go', exact: true }).click()
    const url = new URL((await request).url())
    expect(url.searchParams.get('q')).toBe(prefix)
    expect(url.searchParams.has('cursor')).toBe(false)
    await expect(taskRows(page)).toHaveCount(1)
    await expect(row(page, go.id)).toBeVisible()
    await expect(page.getByRole('switch', { name: 'Only mine' })).toHaveCount(0)

    await page.getByRole('combobox', { name: 'Language' }).click()
    await page.getByRole('option', { name: 'All languages' }).click()
    await expect(taskRows(page)).toHaveCount(2)
  })

  test.describe('as an admin', () => {
    test.use({ role: 'admin' })

    test(
      '"Only mine" restricts the list to the admin\'s tasks and the owner column shows the owner',
      { tag: ['@UI-TASK-001', '@UI-TASK-002'] },
      async ({ page, user, openapi, adminApi }) => {
        const context = await newApiContext({ storageState: user.storageState })
        const tenantApi = new ApiClient(context, openapi)
        const name = unique('owned')
        try {
          const task = await createScaffoldTask(tenantApi, name)
          const admin = ok(await adminApi.getAccount(), 'getAccount')
          await openPage(page, '/tasks')
          await page.getByRole('textbox', { name: 'Search tasks' }).fill(name)
          await expect(row(page, task.id)).toBeVisible()
          await expect(page.getByRole('columnheader', { name: 'Owner' })).toBeVisible()
          await expect(row(page, task.id).locator(`code[data-id="${user.id}"]`)).toHaveText(user.id.slice(0, 8))

          const request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/tasks' && new URL(r.url()).searchParams.get('userId') === admin.id)
          await page.getByRole('switch', { name: 'Only mine' }).click()
          await request
          await expect(row(page, task.id)).toHaveCount(0)
          await page.getByRole('switch', { name: 'Only mine' }).click()
          await expect(row(page, task.id)).toBeVisible()
        } finally {
          await deleteTaskAndWait(tenantApi, name).catch(() => undefined)
          await context.dispose()
        }
      },
    )
  })

  test(
    'the table shows badges, language, source, latest revision, revision count and update time; a row opens the task',
    { tag: ['@UI-TASK-002'] },
    async ({ page, api, tasks }) => {
      test.setTimeout(180_000)
      const prefix = unique('tbl')
      const published = await tasks.example('echo', { name: `${prefix}-pub` })
      const draft = await createScaffoldTask(api, `${prefix}-new`)
      tasks.track(draft.name)

      await openPage(page, '/tasks')
      await page.getByRole('textbox', { name: 'Search tasks' }).fill(prefix)
      await expect(taskRows(page)).toHaveCount(2)
      for (const header of ['Name', 'Language', 'Source', 'Latest revision', 'Revisions', 'Updated']) {
        await expect(page.getByRole('columnheader', { name: header, exact: true })).toBeVisible()
      }
      await expect(page.getByRole('columnheader', { name: 'Owner' })).toHaveCount(0)

      const pub = row(page, published.task.id)
      const cells = pub.getByRole('cell')
      await expect(cells.nth(0)).toContainText(published.task.name)
      await expect(pub.getByTestId('unpublished-badge')).toHaveCount(0)
      await expect(cells.nth(1)).toHaveText('python')
      await expect(cells.nth(2)).toHaveText('upload')
      await expect(cells.nth(3)).toContainText('@1')
      await expect(cells.nth(3)).toContainText('ready')
      await expect(cells.nth(4)).toHaveText('1')
      await expect(cells.nth(5).locator('time')).toHaveText(/just now|min ago/)

      const fresh = row(page, draft.id)
      await expect(fresh.getByTestId('unpublished-badge')).toHaveText('Unpublished changes')
      await expect(fresh.getByRole('cell').nth(2)).toHaveText('scaffold')
      await expect(fresh.getByRole('cell').nth(3)).toHaveText('none')
      await expect(fresh.getByRole('cell').nth(4)).toHaveText('0')

      await pub.getByRole('cell').nth(4).click()
      await expect(page).toHaveURL(new RegExp(`/tasks/${published.task.id}$`))
    },
  )

  test('empty states, the load error and "Load more"', { tag: ['@UI-TASK-003', '@UI-TASK-002'] }, async ({ page, api, tasks }) => {
    const base = await createScaffoldTask(api, unique('mock'))
    tasks.track(base.name)
    const first = [cloneTask(base, 1, { privileged: true }), cloneTask(base, 2)]
    const second = [cloneTask(base, 3)]
    let mode: 'empty' | 'error' | 'pages' = 'empty'
    await page.route(
      (url) => url.pathname === '/api/tasks',
      (route) => {
        const url = new URL(route.request().url())
        if (mode === 'error') return fulfillError(route, { status: 500, code: 'internal', message: 'boom' })
        if (mode === 'empty') return fulfillJson(route, { items: [], nextCursor: null })
        return url.searchParams.get('cursor') === 'page-2'
          ? fulfillJson(route, { items: second, nextCursor: null })
          : fulfillJson(route, { items: first, nextCursor: 'page-2' })
      },
    )

    await openPage(page, '/tasks')
    await expect(page.getByText('No tasks yet')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Create your first task' })).toHaveAttribute('href', '/tasks/new')
    await page.getByRole('textbox', { name: 'Search tasks' }).fill('nothing-matches')
    await expect(page.getByLabel('Tasks', { exact: true }).getByText('No tasks.')).toBeVisible()
    await expect(page.getByText('No tasks yet')).toHaveCount(0)

    mode = 'error'
    await page.getByRole('textbox', { name: 'Search tasks' }).fill('')
    await expect(page.getByText('Tasks could not be loaded')).toBeVisible()

    mode = 'pages'
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(row(page, first[0]!.id)).toBeVisible()
    await expect(row(page, first[0]!.id).getByText('privileged', { exact: true })).toBeVisible()
    await expect(row(page, first[1]!.id).getByText('privileged', { exact: true })).toHaveCount(0)
    await expect(row(page, second[0]!.id)).toHaveCount(0)
    const more = page.getByRole('button', { name: 'Load more' })
    const request = page.waitForRequest((r) => new URL(r.url()).searchParams.get('cursor') === 'page-2')
    await more.click()
    await request
    await expect(row(page, second[0]!.id)).toBeVisible()
    await expect(taskRows(page)).toHaveCount(3)
    await expect(more).toHaveCount(0)
  })
})

test.describe('new-task wizard', () => {
  test(
    'the scaffold path steps through language, template and name; Back and switching the source reset',
    { tag: ['@UI-TASK-004', '@UI-TASK-005'] },
    async ({ page, api }) => {
      const languages = ok(
        await api.call<{ items: { language: string; title: string; baseImage: string; entry: string; extensions: string[] }[] }>('listLanguages'),
        'listLanguages',
      ).items
      const templates = ok(
        await api.call<{ items: { name: string; title: string; description: string; resolves: boolean; example: { analysisConfig: unknown } }[] }>(
          'listTemplates',
        ),
        'listTemplates',
      ).items
      const scaffolds = ok(await api.call<{ items: { language: string; templates: string[] }[] }>('listScaffolds'), 'listScaffolds').items
      const python = languages.find((language) => language.language === 'python')!
      const pythonTemplates = scaffolds.find((scaffold) => scaffold.language === 'python')!.templates

      await openPage(page, '/tasks/new')
      await expect(wizardSource(page, 'From a scaffold')).toBeVisible()
      await expect(wizardSource(page, 'Import from git')).toBeVisible()
      await expect(wizardSource(page, 'Upload a folder')).toBeVisible()
      await wizardSource(page, 'From a scaffold').click()

      const languageCards = page.getByRole('list', { name: 'Languages' }).getByRole('button')
      await expect(languageCards).toHaveCount(languages.length)
      for (const language of languages) {
        const card = languageCards.filter({ hasText: language.title })
        await expect(card).toContainText(language.baseImage)
        await expect(card).toContainText(`entry ${language.entry}`)
        await expect(card).toContainText(language.extensions.join(' '))
      }
      await languageCards.filter({ hasText: python.title }).click()

      const templateList = page.getByRole('list', { name: 'Templates' })
      const offered = templates.filter((template) => pythonTemplates.includes(template.name))
      await expect(templateList.getByRole('listitem')).toHaveCount(offered.length + (pythonTemplates.includes('custom') ? 1 : 0))
      for (const template of offered) {
        const card = templateList.getByRole('listitem').filter({ has: page.getByText(template.name, { exact: true }) })
        await expect(card).toContainText(template.title)
        await expect(card.getByText('pins inputs', { exact: true })).toHaveCount(template.resolves ? 1 : 0)
        const spans = [...template.description.matchAll(/`([^`]+)`/g)].map((match) => match[1]!)
        for (const span of spans) await expect(card.locator('code', { hasText: span }).first()).toBeVisible()
        await expect(card.getByRole('button', { name: `Use ${template.title}` })).toBeVisible()
        for (const key of Object.keys(template.example.analysisConfig as Record<string, unknown>)) await expect(card).toContainText(key)
      }
      const custom = templateList.getByRole('listitem').filter({ hasText: 'Custom schedule' })
      await expect(custom).toBeVisible()
      await expect(custom.getByRole('button', { name: 'Use a custom schedule' })).toBeVisible()

      // Back returns to the language step with the choice kept.
      await page.getByRole('button', { name: 'Back' }).click()
      await expect(languageCards.filter({ hasText: python.title })).toHaveAttribute('aria-pressed', 'true')
      await languageCards.filter({ hasText: python.title }).click()
      await templateList.getByRole('button', { name: `Use ${offered[0]!.title}` }).click()
      const nameInput = page.getByRole('textbox', { name: 'Name' })
      await expect(nameInput).toBeVisible()
      await expect(page.getByText(`python · ${offered[0]!.name}`)).toBeVisible()

      // Switching the source resets the language and template. Each step is awaited: the Back button moves with the
      // step's content, and a click during the move would land on a card of the next step. The autofocused empty name
      // is left first: its validation message appears on blur and would push "Back" away under the pointer.
      await nameInput.blur()
      await expect(page.getByText(/^must be 1–64 lowercase letters/)).toBeVisible()
      await page.getByRole('button', { name: 'Back' }).click()
      await expect(templateList).toBeVisible()
      await page.getByRole('button', { name: 'Back' }).click()
      await expect(languageCards.first()).toBeVisible()
      await page.getByRole('button', { name: 'Back' }).click()
      await wizardSource(page, 'Import from git').click()
      await expect(page.getByRole('textbox', { name: 'Repository URL' })).toBeVisible()
      await page.getByRole('button', { name: 'Back' }).click()
      await wizardSource(page, 'From a scaffold').click()
      for (const card of await languageCards.all()) await expect(card).toHaveAttribute('aria-pressed', 'false')
    },
  )

  test(
    'the name step validates live, a taken name shows inline and "Create task" opens the new task',
    { tag: ['@UI-TASK-006'] },
    async ({ page, api, tasks }) => {
      const taken = unique('taken')
      tasks.track(taken)
      await createScaffoldTask(api, taken)
      const fresh = unique('wizard')
      tasks.track(fresh)

      await openPage(page, '/tasks/new')
      await wizardSource(page, 'From a scaffold').click()
      await page.getByRole('list', { name: 'Languages' }).getByRole('button').filter({ hasText: 'Python' }).click()
      await page.getByRole('list', { name: 'Templates' }).getByRole('button', { name: 'Use a custom schedule' }).click()

      const name = page.getByRole('textbox', { name: 'Name' })
      const nameProblem = 'must be 1–64 lowercase letters, digits or hyphens, starting and ending with a letter or digit'
      // Nuxt UI validates a field on input once it was left the first time.
      await name.fill('Bad_Name')
      await name.blur()
      await expect(page.getByText(nameProblem)).toBeVisible()
      await name.fill('latest')
      await expect(page.getByText('"latest" is reserved')).toBeVisible()
      await name.fill(taken)
      // The cleared message shifts "Create task" up; a click during the shift misses it.
      await expect(page.getByText(nameProblem)).toHaveCount(0)
      await expect(page.getByText('"latest" is reserved')).toHaveCount(0)
      await expect(page.getByRole('textbox', { name: 'Description' })).toHaveAttribute('maxlength', '500')

      const requests = recordApiRequests(page)
      await page.getByRole('button', { name: 'Create task' }).click()
      await expect(page.getByText('A task with this name already exists.')).toBeVisible()
      expect(requests.filter((request) => request.method === 'POST' && request.url.pathname === '/api/tasks')).toHaveLength(1)

      await name.fill(fresh)
      await page.getByRole('textbox', { name: 'Description' }).fill('created by the wizard test')
      await page.getByRole('button', { name: 'Create task' }).click()
      await expect(page).toHaveURL((url) => /^\/tasks\/[0-9a-f-]{36}$/.test(url.pathname) && url.searchParams.get('created') === '1')
      await expect(page.getByText(`Task ${fresh} is ready`)).toBeVisible()
      const task = ok(await api.getTask(fresh), 'getTask')
      expect(task.description).toBe('created by the wizard test')
      expect(task.source).toEqual(expect.objectContaining({ kind: 'scaffold', template: 'custom' }))
    },
  )
})

test.describe('git import', () => {
  test(
    'the form defaults Ref and Path, offers saved credentials and rejects non-https URLs before any request',
    { tag: ['@UI-TASK-007'] },
    async ({ page, api }) => {
      const credentialName = unique('gitcred')
      try {
        await createCredential(api, { name: credentialName, host: GIT_HOST, token: 'tok-form-1234' })
        await openPage(page, '/tasks/new')
        await wizardSource(page, 'Import from git').click()
        await expect(page.getByRole('textbox', { name: 'Ref' })).toHaveValue('HEAD')
        await expect(page.getByRole('textbox', { name: 'Path' })).toHaveValue('.')
        const add = page.getByRole('link', { name: 'Add a credential' })
        await expect(add).toHaveAttribute('href', '/account/credentials')
        await expect(add).toHaveAttribute('target', '_blank')
        await page.getByRole('combobox', { name: 'Git credential' }).click()
        await expect(page.getByRole('option', { name: 'None' })).toBeVisible()
        await expect(page.getByRole('option', { name: `${credentialName} (${GIT_HOST})` })).toBeVisible()
        await page.keyboard.press('Escape')

        const requests = recordApiRequests(page)
        const url = page.getByRole('textbox', { name: 'Repository URL' })
        for (const value of [
          `http://${GIT_HOST}/single.git`,
          `ssh://git@${GIT_HOST}/single.git`,
          'file:///etc/passwd',
          `git@${GIT_HOST}:single.git`,
          'ext::sh -c touch% /tmp/pwned',
        ]) {
          await url.fill(value)
          await page.getByRole('button', { name: 'Import', exact: true }).click()
          // zod rejects every non-https scheme; values that are no URL at all are already refused by the url input.
          await expect
            .poll(
              async () =>
                (await page.getByText('must be an https:// URL').count()) > 0 || !(await url.evaluate((input: HTMLInputElement) => input.validity.valid)),
              {
                message: value,
              },
            )
            .toBe(true)
        }
        expect(requests.filter((request) => request.url.pathname === '/api/tasks/import-git')).toEqual([])
      } finally {
        await deleteCredentialsNamed(api, [credentialName])
      }
    },
  )

  test('an https URL with credentials in it is rejected before any request', { tag: ['@UI-TASK-007'] }, async ({ page }) => {
    await openPage(page, '/tasks/new')
    await wizardSource(page, 'Import from git').click()
    const requests = recordApiRequests(page)
    await page.getByRole('textbox', { name: 'Repository URL' }).fill(`https://user:secret@${GIT_HOST}/single.git`)
    await page.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(page.getByText(/must not contain credentials|without credentials|userinfo|https:\/\/ URL/)).toBeVisible({ timeout: 5_000 })
    expect(requests.filter((request) => request.url.pathname === '/api/tasks/import-git')).toEqual([])
  })

  test(
    'one task opens at once; several candidates are selected, existing ones are disabled',
    { tag: ['@UI-TASK-008', '@UI-TASK-012', '@UI-TASK-013'] },
    async ({ page, api, tasks }) => {
      test.setTimeout(180_000)
      for (const name of ['git-single', 'git-multi-alpha', 'git-multi-beta']) tasks.track(name)
      const importGit = async (url: string) => {
        await openPage(page, '/tasks/new')
        await wizardSource(page, 'Import from git').click()
        await page.getByRole('textbox', { name: 'Repository URL' }).fill(url)
        await page.getByRole('button', { name: 'Import', exact: true }).click()
      }

      await importGit(GIT_REPOS.single)
      await expect(page).toHaveURL((url) => /^\/tasks\/[0-9a-f-]{36}$/.test(url.pathname) && url.searchParams.get('created') === '1', { timeout: 60_000 })
      const single = ok(await api.getTask('git-single'), 'getTask')
      expect(single.source.kind).toBe('git')
      // The git header badge and the git-only "Pull from git" action.
      await expect(page.getByText(`git · ${single.source.git!.commit.slice(0, 8)}`)).toBeVisible()
      await expect(page.getByRole('button', { name: 'Pull from git' })).toBeVisible()

      await importGit(GIT_REPOS.multi)
      const candidates = page.getByRole('region', { name: 'Select tasks' }).or(page.locator('section[aria-labelledby="git-candidates-heading"]')).first()
      await expect(candidates.getByText('Select tasks')).toBeVisible({ timeout: 60_000 })
      const alpha = candidates.getByRole('checkbox', { name: /^Import git-multi-alpha from / })
      const beta = candidates.getByRole('checkbox', { name: /^Import git-multi-beta from / })
      const importSelected = candidates.getByRole('button', { name: 'Import selected' })
      await expect(importSelected).toBeDisabled()
      await alpha.click()
      await beta.click()
      await importSelected.click()
      await expectToast(page, 'Imported 2 tasks')
      await expect(page).toHaveURL(/\/tasks$/)
      for (const name of ['git-multi-alpha', 'git-multi-beta']) expect(ok(await api.getTask(name), 'getTask').source.kind).toBe('git')

      // Remove beta and import again: alpha is marked "already exists" and disabled; only the checked one is imported.
      await deleteTaskAndWait(api, 'git-multi-beta')
      await importGit(GIT_REPOS.multi)
      await expect(candidates.getByText('Select tasks')).toBeVisible({ timeout: 60_000 })
      await expect(alpha).toBeDisabled()
      await expect(candidates.getByRole('listitem').filter({ hasText: 'git-multi-alpha' }).getByText('already exists')).toBeVisible()
      await expect(beta).toBeEnabled()
      await expect(candidates.getByRole('listitem').filter({ hasText: 'git-multi-beta' }).getByText('already exists')).toHaveCount(0)
      await beta.click()
      await importSelected.click()
      await expect(page).toHaveURL((url) => /^\/tasks\/[0-9a-f-]{36}$/.test(url.pathname), { timeout: 60_000 })
      const imported = ok(await api.getTask('git-multi-beta'), 'getTask')
      expect(new URL(page.url()).pathname).toBe(`/tasks/${imported.id}`)
    },
  )

  test('git errors show inline: gitFailed under "The import failed", manifestInvalid under "Manifest errors"', { tag: ['@UI-TASK-009'] }, async ({ page }) => {
    await openPage(page, '/tasks/new')
    await wizardSource(page, 'Import from git').click()
    await page.getByRole('textbox', { name: 'Repository URL' }).fill(`${GIT_URL}/${unique('missing')}.git`)
    const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/tasks/import-git')
    await page.getByRole('button', { name: 'Import', exact: true }).click()
    const failed = await response
    expect(failed.status()).toBe(422)
    const body = (await failed.json()) as { error: { code: string; details: { message: string } } }
    expect(body.error.code).toBe('gitFailed')
    const alert = alertBox(page, 'The import failed')
    await expect(alert).toBeVisible()
    await expect(alert).toContainText(body.error.details.message)

    // No fixture repository carries an invalid manifest, so the server's answer is mocked.
    await page.route('**/api/tasks/import-git', (route) =>
      fulfillError(route, {
        status: 422,
        code: 'manifestInvalid',
        message: 'The manifest is invalid',
        details: { errors: [{ phase: 'static', file: 'scantor.yaml', line: 3, column: 11, message: 'unknown language "cobol"' }] },
      }),
    )
    await page.getByRole('button', { name: 'Import', exact: true }).click()
    const errors = page.getByTestId('build-errors')
    await expect(errors).toContainText('Manifest errors')
    await expect(errors).toContainText('scantor.yaml:3:11')
    await expect(errors).toContainText('unknown language "cobol"')
  })
})

test.describe('upload', () => {
  test('accepts only .tar.gz and .tgz files and shows the chosen file', { tag: ['@UI-TASK-010'] }, async ({ page }) => {
    await openPage(page, '/tasks/new')
    await wizardSource(page, 'Upload a folder').click()
    const upload = page.getByRole('button', { name: 'Upload', exact: true })
    await expect(upload).toBeDisabled()
    await expect(page.getByRole('checkbox', { name: 'Publish a revision' })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: 'Replace unpublished changes' })).not.toBeChecked()

    const input = page.locator('input[type="file"]')
    await input.setInputFiles({ name: 'task.zip', mimeType: 'application/zip', buffer: Buffer.from('PK\u0003\u0004') })
    await expect(page.getByText('Expected a .tar.gz or .tgz file')).toBeVisible()
    await expect(upload).toBeDisabled()

    const archive = await packTask(exampleTaskDir('echo'), { name: unique('picked') })
    await input.setInputFiles({ name: 'echo.tgz', mimeType: 'application/gzip', buffer: archive })
    const zone = page.getByTestId('file-drop-zone')
    await expect(zone).toContainText('echo.tgz')
    await expect(zone.locator('span[title]')).toHaveAttribute('title', `${new Intl.NumberFormat('en-US').format(archive.length)} bytes`)
    await expect(page.getByText('Expected a .tar.gz or .tgz file')).toHaveCount(0)
    await expect(upload).toBeEnabled()

    await page.getByRole('button', { name: 'Remove file' }).click()
    await expect(upload).toBeDisabled()
    await input.setInputFiles({ name: 'echo.tar.gz', mimeType: 'application/gzip', buffer: archive })
    await expect(upload).toBeEnabled()
  })

  test(
    'upload results: task page, revision page, workspaceDirty with "Replace anyway", manifest and path errors',
    { tag: ['@UI-TASK-011'] },
    async ({ page, api, tasks }) => {
      const name = unique('upl')
      tasks.track(name)
      const input = () => page.locator('input[type="file"]')
      const open = async () => {
        await openPage(page, '/tasks/new')
        await wizardSource(page, 'Upload a folder').click()
      }

      // Without publishing: the task page.
      await open()
      await input().setInputFiles({ name: 'echo.tgz', mimeType: 'application/gzip', buffer: await packTask(exampleTaskDir('echo'), { name }) })
      await page.getByRole('checkbox', { name: 'Publish a revision' }).click()
      await page.getByRole('button', { name: 'Upload', exact: true }).click()
      const task = await expect
        .poll(async () => (await api.getTask(name)).status)
        .toBe(200)
        .then(async () => ok(await api.getTask(name), 'getTask'))
      await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`))
      expect(task.revisionCount).toBe(0)

      // An edit in the workspace makes the next upload conflict until it is replaced.
      await writeTaskFiles(api, name, { 'main.py': '# edited in the workspace\n' })
      await open()
      await input().setInputFiles({ name: 'echo.tgz', mimeType: 'application/gzip', buffer: await packTask(exampleTaskDir('echo'), { name }) })
      await page.getByRole('checkbox', { name: 'Publish a revision' }).click()
      await page.getByRole('button', { name: 'Upload', exact: true }).click()
      const dirty = alertBox(page, 'The workspace has unpublished changes')
      await expect(dirty).toBeVisible()
      await dirty.getByRole('button', { name: 'Replace anyway' }).click()
      await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`))
      const content = ok(await api.call<{ content: string }>('readTaskFile', { path: { task: name }, query: { path: 'main.py' } }), 'readTaskFile')
      expect(content.content).not.toContain('edited in the workspace')

      // With publishing (the default): the revision page.
      await open()
      await input().setInputFiles({ name: 'echo.tgz', mimeType: 'application/gzip', buffer: await packTask(exampleTaskDir('echo'), { name }) })
      await page.getByRole('button', { name: 'Upload', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}/revisions/1$`))

      // An archive with an unknown language: manifest errors.
      await open()
      const badManifest = await buildTarGz([{ name: 'scantor.yaml', content: `scantor: 1\nname: ${unique('bad')}\nlanguage: cobol\n` }])
      await input().setInputFiles({ name: 'bad.tgz', mimeType: 'application/gzip', buffer: badManifest })
      await page.getByRole('button', { name: 'Upload', exact: true }).click()
      const errors = page.getByTestId('build-errors')
      await expect(errors).toContainText('Manifest errors')
      await expect(errors).toContainText('static')
      await expect(errors).toContainText('scantor.yaml:3:')
      await expect(errors).toContainText('/language: value must be one of')

      // A path that escapes the folder: invalidPath with the path.
      const escaping = await buildTarGz([
        { name: 'scantor.yaml', content: `scantor: 1\nname: ${unique('slip')}\nlanguage: python\n` },
        { name: '../x', content: 'x' },
      ])
      await input().setInputFiles({ name: 'slip.tgz', mimeType: 'application/gzip', buffer: escaping })
      await page.getByRole('button', { name: 'Upload', exact: true }).click()
      const failed = alertBox(page, 'The upload failed')
      await expect(failed).toBeVisible()
      await expect(failed).toContainText('(../x)')
    },
  )
})

test.describe('task page', () => {
  test(
    'header, actions, created banner and tabs of a scaffolded task',
    { tag: ['@UI-TASK-012', '@UI-TASK-013', '@UI-TASK-014', '@UI-TASK-015', '@UI-TASK-016'] },
    async ({ page, api, tasks }) => {
      const name = unique('page')
      tasks.track(name)
      const task = await createScaffoldTask(api, name, { description: 'a task to look at' })
      const requests = recordApiRequests(page)
      await openPage(page, `/tasks/${task.id}?created=1`)

      // Banner of a new task.
      const banner = alertBox(page, `Task ${name} is ready`)
      await expect(banner).toBeVisible()
      for (const action of ['Open the editor', 'Try a test run', 'Publish now'])
        await expect(banner.getByRole('button', { name: action }).or(banner.getByRole('link', { name: action }))).toBeVisible()
      await expect(banner.getByRole('link', { name: 'Open the editor' })).toHaveAttribute('href', `/editor?task=${name}`)
      await banner.getByRole('button', { name: 'Close' }).click()
      await expect(banner).toHaveCount(0)
      await expect(page).toHaveURL((url) => url.pathname === `/tasks/${task.id}` && !url.searchParams.has('created'))

      // Header: name, language, source, unpublished changes; no revision yet.
      const header = page.locator('[data-slot="title"]').first()
      await expect(header).toContainText(name)
      await expect(header.getByText('python', { exact: true })).toBeVisible()
      await expect(header.getByText('scaffold', { exact: true })).toBeVisible()
      await expect(header.getByTestId('unpublished-badge')).toHaveText('Unpublished changes')
      await expect(header.getByText('privileged')).toHaveCount(0)
      await expect(header.getByRole('link', { name: new RegExp(`${name}@`) })).toHaveCount(0)

      // Navbar actions (no ready revision, no git source).
      await expect(page.getByRole('link', { name: 'Open in editor' }).first()).toHaveAttribute('href', `/editor?task=${name}`)
      await expect(page.getByRole('button', { name: 'Publish revision' })).toBeVisible()
      await expect(page.getByRole('link', { name: 'Start scan' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Pull from git' })).toHaveCount(0)
      const download = page.getByRole('link', { name: 'Download workspace' })
      await expect(download).toHaveAttribute('href', `/api/tasks/${task.id}/workspace/archive`)
      await expect(download).toHaveAttribute('download', /.*/)
      await expect(page.getByRole('button', { name: 'Delete task' })).toBeVisible()

      // Overview: description, workspace, revisions and source cards, recent scans and test runs.
      await expect(page.getByText('a task to look at')).toBeVisible()
      await expect(page.getByText('No scans of this task yet.')).toBeVisible()
      await expect(page.getByText('No test runs yet.')).toBeVisible()
      expect(
        requests.some((r) => r.url.pathname === '/api/scans' && r.url.searchParams.get('task') === task.id && r.url.searchParams.get('limit') === '10'),
      ).toBe(true)
      expect(requests.some((r) => r.url.pathname === `/api/tasks/${task.id}/test-runs` && r.url.searchParams.get('limit') === '5')).toBe(true)
      const source = page.locator('p.section-label', { hasText: 'Source' }).locator('xpath=..')
      await expect(source).toContainText('scaffold')
      await expect(source).toContainText('single')
      const revisions = page.locator('p.section-label', { hasText: 'Revisions' }).locator('xpath=..')
      await expect(revisions).toContainText('Published')
      await expect(revisions).toContainText('none')
      const workspace = page.locator('p.section-label', { hasText: 'Workspace' }).locator('xpath=../..')
      const check = page.waitForRequest((r) => new URL(r.url()).pathname === `/api/tasks/${task.id}/workspace`)
      await workspace.getByRole('button', { name: 'Check now' }).click()
      await check
      await expect(workspace.locator('time')).toHaveText('just now')

      // Tabs sync with ?tab=.
      await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
      for (const [label, value] of [
        ['Files', 'files'],
        ['Revisions', 'revisions'],
        ['Test', 'test'],
      ]) {
        await openTab(page, label!)
        await expect(page).toHaveURL((url) => url.searchParams.get('tab') === value)
      }
      await openTab(page, 'Overview')
      await expect(page).toHaveURL((url) => !url.searchParams.has('tab'))
      await openPage(page, `/tasks/${task.id}?tab=revisions`)
      await expect(page.getByRole('tab', { name: 'Revisions' })).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByText('No revisions yet. Publish the workspace to create one.')).toBeVisible()
      await openPage(page, `/tasks/${task.id}?tab=bogus`)
      await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByText('a task to look at')).toBeVisible()

      // Narrow screens hide the labels but keep the accessible names.
      await page.setViewportSize({ width: 900, height: 900 })
      for (const action of ['Publish revision', 'Delete task']) {
        const button = page.getByRole('button', { name: action })
        await expect(button).toBeVisible()
        await expect(button).toHaveAccessibleName(action)
      }
      await expect(page.getByRole('link', { name: 'Open in editor' }).first()).toHaveAccessibleName('Open in editor')
      await expect(page.getByRole('link', { name: 'Download workspace' })).toHaveAccessibleName('Download workspace')
    },
  )

  test('an unknown task shows "Task not found"', { tag: ['@UI-TASK-020'] }, async ({ page }) => {
    await openPage(page, '/tasks/2f9a2c1e-0d3b-4c8e-9a51-7c2d1e0f4b6a')
    await expect(alertBox(page, 'Task not found')).toBeVisible()
  })

  test(
    'a build shows live in the header, then the files of the revision, the revisions tab and "Start scan"',
    { tag: ['@UI-TASK-020', '@UI-TASK-022', '@UI-TASK-023', '@UI-TASK-013'] },
    async ({ page, api, tasks }) => {
      test.setTimeout(180_000)
      const name = unique('live')
      tasks.track(name)
      const task = await createScaffoldTask(api, name)
      await openPage(page, `/tasks/${task.id}`)
      const header = page.locator('[data-slot="title"]').first()
      await expect(header.getByTestId('unpublished-badge')).toBeVisible()

      const revision = ok(await api.publishRevision(name, { message: 'first build' }), 'publishRevision')
      const latest = header.getByRole('link', { name: new RegExp(`${name}@1`) })
      await expect(latest).toBeVisible({ timeout: 15_000 })
      await expect(latest).toContainText(/queued|building|ready/)
      const built = await waitForRevision(api, name, revision.id, 120_000)
      expect(built.state).toBe('ready')
      await expect(latest).toContainText('ready', { timeout: 15_000 })
      await expect(header.getByTestId('unpublished-badge')).toHaveCount(0)
      await expect(page.getByRole('link', { name: 'Start scan' })).toHaveAttribute('href', `/scans/new?revision=${encodeURIComponent(`${task.id}@latest`)}`)

      // Revisions tab: columns, state filter, empty filter result, row opens the revision. The tab's list is read when
      // the page loads (it is not polled), so the page is opened again.
      await openPage(page, `/tasks/${task.id}?tab=revisions`)
      const table = page.getByLabel('Revisions', { exact: true })
      const revisionRow = table.locator(`tr[data-row-id="${revision.id}"]`)
      await expect(revisionRow).toBeVisible()
      const cells = revisionRow.getByRole('cell')
      await expect(cells.nth(0)).toHaveText(`${name}@1`)
      await expect(cells.nth(1)).toHaveText('ready')
      // A revision published from the workspace has source kind `workspace`.
      expect(built.source.kind).toBe('workspace')
      await expect(cells.nth(2)).toHaveText(built.source.kind)
      await expect(cells.nth(3).locator('code')).toHaveText(built.source.packSha256.replace(/^sha256:/, '').slice(0, 8))
      await expect(cells.nth(4)).toHaveText('0')
      await expect(cells.nth(5).locator('time')).toBeVisible()
      await expect(cells.nth(6)).toHaveText(/^(\d+ ms|\d+\.\ds|\d+s|\d+m \d{2}s)$/)
      await page.getByRole('combobox', { name: 'Revision state' }).click()
      await page.getByRole('option', { name: 'failed' }).click()
      await expect(table.getByText('No revisions yet. Publish the workspace to create one.')).toBeVisible()
      await page.getByRole('combobox', { name: 'Revision state' }).click()
      await page.getByRole('option', { name: 'ready' }).click()
      await expect(revisionRow).toBeVisible()

      // Files tab: the workspace or a revision's snapshot, read-only.
      await openTab(page, 'Files')
      const sourceSelect = page.getByRole('combobox', { name: 'File source' })
      await expect(sourceSelect).toHaveText(/Workspace/)
      const listing = page.waitForRequest(
        (r) => new URL(r.url()).pathname === `/api/tasks/${task.id}/files` && new URL(r.url()).searchParams.get('revision') === '1',
      )
      await sourceSelect.click()
      await page.getByRole('option', { name: 'Revision 1' }).click()
      await listing
      await expect(page).toHaveURL((url) => url.searchParams.get('tab') === 'files' && url.searchParams.get('revision') === '1')
      await page.getByRole('tree', { name: 'Task files' }).getByRole('treeitem', { name: 'scantor.yaml' }).click()
      await expect(page.getByRole('region', { name: 'scantor.yaml' })).toContainText(`name: ${name}`)
      await expect(page.locator('textarea, [contenteditable="true"]')).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^Save/ })).toHaveCount(0)

      await reloadPage(page)
      await expect(page.getByRole('combobox', { name: 'File source' })).toHaveText(/Revision 1/)
      await page.getByRole('combobox', { name: 'File source' }).click()
      await page.getByRole('option', { name: 'Workspace' }).click()
      await expect(page).toHaveURL((url) => url.searchParams.get('tab') === 'files' && !url.searchParams.has('revision'))

      await openTab(page, 'Revisions')
      await revisionRow.getByRole('cell').nth(2).click()
      await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}/revisions/1$`))
    },
  )

  test('the files tab shows the tree, file content with line numbers, binary files and notices', { tag: ['@UI-TASK-021'] }, async ({ page, api, tasks }) => {
    const name = unique('files')
    tasks.track(name)
    const task = await createScaffoldTask(api, name)
    const binary = Buffer.from([0, 1, 2, 3, 255, 254, 0, 10, 13, 0, 7, 8])
    await writeTaskFiles(api, name, { 'docs/notes.txt': 'first line\nsecond line\nthird line\n', 'data/blob.bin': { base64: binary.toString('base64') } })

    await openPage(page, `/tasks/${task.id}?tab=files`)
    const tree = page.getByRole('tree', { name: 'Task files' })
    const docs = tree.getByRole('treeitem', { name: 'docs' })
    await expect(docs).toBeVisible()
    await expect(docs.locator('[class*="i-lucide:folder"]')).toHaveCount(1)
    await expect(tree.getByRole('treeitem', { name: 'scantor.yaml' }).locator('[class*="i-lucide:file"]')).toHaveCount(1)

    await docs.click()
    await tree.getByRole('treeitem', { name: 'notes.txt' }).click()
    const viewer = page.getByRole('region', { name: 'docs/notes.txt' })
    await expect(viewer).toContainText('second line')
    await expect(viewer.locator('code > span[aria-hidden="true"]')).toHaveText(['1', '2', '3'])
    const content = ok(
      await api.call<{ sha256: string; size: number }>('readTaskFile', { path: { task: name }, query: { path: 'docs/notes.txt' } }),
      'readTaskFile',
    )
    await expect(page.locator('span.font-mono', { hasText: 'docs/notes.txt' })).toBeVisible()
    await expect(page.locator(`code[data-id="${content.sha256}"]`)).toBeVisible()
    await expect(page.getByText(`${content.size} B`, { exact: true })).toBeVisible()

    await tree.getByRole('treeitem', { name: 'data' }).click()
    await tree.getByRole('treeitem', { name: 'blob.bin' }).click()
    await expect(page.getByText(`Binary file, ${binary.length} B`)).toBeVisible()

    // Symlinks only appear through the editor and the caps need huge workspaces, so the listing is mocked.
    await page.route(
      (url) => url.pathname === `/api/tasks/${task.id}/files`,
      (route) =>
        fulfillJson(route, {
          entries: [
            { path: 'link', type: 'symlink', size: 0, mode: 0o777 },
            { path: 'scantor.yaml', type: 'file', size: 10, mode: 0o644 },
          ],
          truncated: true,
        }),
    )
    await page.route(
      (url) => url.pathname === `/api/tasks/${task.id}/files/content`,
      (route) =>
        fulfillJson(route, { path: 'scantor.yaml', size: 3 * 1024 * 1024, sha256: 'a'.repeat(64), encoding: 'utf8', content: 'scantor: 1\n', truncated: true }),
    )
    await page.getByRole('button', { name: 'Reload files' }).click()
    await expect(page.getByText('Only the first 5000 entries are shown')).toBeVisible()
    await expect(tree.getByRole('treeitem', { name: 'link' }).locator('[class*="i-lucide:link"]')).toHaveCount(1)
    await tree.getByRole('treeitem', { name: 'scantor.yaml' }).click()
    await expect(page.getByText('Only the first MiB is shown')).toBeVisible()

    await page.unroute((url) => url.pathname === `/api/tasks/${task.id}/files`)
    await page.route(
      (url) => url.pathname === `/api/tasks/${task.id}/files`,
      (route) => fulfillJson(route, { entries: [], truncated: false }),
    )
    await page.getByRole('button', { name: 'Reload files' }).click()
    await expect(page.getByText('The folder is empty.')).toBeVisible()
  })

  test('the publish modal shows the workspace status, notes an existing revision and shows errors', { tag: ['@UI-TASK-017'] }, async ({ page, api, tasks }) => {
    const name = unique('pub')
    tasks.track(name)
    const task = await createScaffoldTask(api, name)
    await openPage(page, `/tasks/${task.id}`)

    await page.getByRole('button', { name: 'Publish revision' }).click()
    let dialog = page.getByRole('dialog', { name: `Publish ${name}` })
    await expect(dialog.getByText('Unpublished changes')).toBeVisible()
    await expect(dialog.getByText(/\d+ files · /)).toBeVisible()
    await expect(dialog.getByText(/The workspace equals/)).toHaveCount(0)
    const message = dialog.getByRole('textbox', { name: 'Message' })
    await expect(message).toHaveAttribute('maxlength', '500')
    await message.fill('published from the modal')
    await dialog.getByRole('button', { name: 'Publish revision' }).click()
    await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}/revisions/1$`))
    await expect(page.getByText('published from the modal')).toBeVisible()

    await openPage(page, `/tasks/${task.id}`)
    await page.getByRole('button', { name: 'Publish revision' }).click()
    dialog = page.getByRole('dialog', { name: `Publish ${name}` })
    await expect(dialog.getByText('Already published')).toBeVisible()
    await expect(dialog.getByText(`The workspace equals ${name}@1`)).toBeVisible()
    await expect(dialog.getByText('Publishing returns the existing revision instead of building again.')).toBeVisible()

    // The task disappears meanwhile: the error shows inside the modal.
    await deleteTaskAndWait(api, name)
    await dialog.getByRole('button', { name: 'Publish revision' }).click()
    const failed = alertBox(dialog, 'Publishing failed')
    await expect(failed).toBeVisible()
    await expect(dialog).toBeVisible()
  })

  test(
    '"Pull from git" reports up to date, pulls a new commit and asks before overwriting on divergence',
    { tag: ['@UI-TASK-018'] },
    async ({ page, api, tasks, request }) => {
      test.setTimeout(180_000)
      const repo = await copyGitRepo(request, 'diverge')
      tasks.track('git-diverge')
      const imported = ok(await api.call<{ imported: Task[] }>('importGitTask', { body: { url: repo } }), 'importGitTask').imported
      expect(imported.map((task) => task.name)).toEqual(['git-diverge'])
      const task = imported[0]!

      await openPage(page, `/tasks/${task.id}`)
      const pull = page.getByRole('button', { name: 'Pull from git' })
      await pull.click()
      await expectToast(page, 'Already up to date')

      await moveGitMain(request, repo, 'advanced')
      await pull.click()
      await expect.poll(async () => ok(await api.getTask(task.id), 'getTask').source.git!.commit).not.toBe(task.source.git!.commit)
      const advanced = ok(await api.getTask(task.id), 'getTask').source.git!.commit
      await expectToast(page, `Pulled ${advanced.slice(0, 8)}`)
      await expect(page.getByText(`git · ${advanced.slice(0, 8)}`)).toBeVisible()

      await moveGitMain(request, repo, 'rewritten')
      await pull.click()
      const confirm = page.getByRole('dialog', { name: 'Overwrite the workspace?' })
      await expect(confirm).toContainText('Local changes or a non-fast-forward remote. Overwrite the workspace?')
      // Cancel keeps the workspace.
      await confirm.getByRole('button', { name: 'Cancel' }).click()
      expect(ok(await api.getTask(task.id), 'getTask').source.git!.commit).toBe(advanced)
      await pull.click()
      await page.getByRole('dialog', { name: 'Overwrite the workspace?' }).getByRole('button', { name: 'Overwrite workspace' }).click()
      await expect.poll(async () => ok(await api.getTask(task.id), 'getTask').source.git!.commit).not.toBe(advanced)
      const rewritten = ok(await api.getTask(task.id), 'getTask').source.git!.commit
      await expectToast(page, `Pulled ${rewritten.slice(0, 8)}`)
    },
  )

  test('"Delete task" asks for the name, shows the deletion toast and opens /tasks', { tag: ['@UI-TASK-019'] }, async ({ page, api, tasks }) => {
    const name = unique('del')
    tasks.track(name)
    const task = await createScaffoldTask(api, name)
    await openPage(page, `/tasks/${task.id}`)
    await page.getByRole('button', { name: 'Delete task' }).click()
    const dialog = page.getByRole('dialog', { name: `Delete ${name}` })
    await dialog.getByLabel(`Type ${name} to confirm`).fill(name)
    await dialog.getByRole('button', { name: 'Delete task' }).click()
    await expectToast(page, `Task ${name} is being deleted`)
    await expect(page).toHaveURL(/\/tasks$/)
    expect((await api.getTask(task.id)).status).toBe(404)
  })

  test(
    'deleting a task that a scan uses shows "A scan still uses this task" with "Show active scans"',
    { tag: ['@UI-TASK-019'] },
    async ({ page, api, tasks }) => {
      test.setTimeout(180_000)
      const busy = await tasks.example('echo', { name: unique('busy') })
      const busyScan = await startUnplacedScan(api, `${busy.task.name}@latest`, unique('busy-scan'))
      try {
        await openPage(page, `/tasks/${busy.task.id}`)
        await page.getByRole('button', { name: 'Delete task' }).click()
        const dialog = page.getByRole('dialog', { name: `Delete ${busy.task.name}` })
        await dialog.getByLabel(`Type ${busy.task.name} to confirm`).fill(busy.task.name)
        const answer = page.waitForResponse((r) => r.request().method() === 'DELETE' && new URL(r.url()).pathname === `/api/tasks/${busy.task.id}`)
        await dialog.getByRole('button', { name: 'Delete task' }).click()
        const response = await answer
        expect(response.status()).toBe(409)
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe('taskInUse')
        const toast = openToastItems(page).filter({ hasText: 'A scan still uses this task' })
        await expect(toast).toBeVisible()
        await expect(page).toHaveURL(new RegExp(`/tasks/${busy.task.id}$`))
        expect(ok(await api.getTask(busy.task.id), 'getTask').name).toBe(busy.task.name)
        await toast.getByRole('button', { name: 'Show active scans' }).click()
        await expect(page).toHaveURL((url) => url.pathname === '/scans')
        await expect(page.locator(`tr[data-row-id="${busyScan.id}"]`)).toBeVisible()
      } finally {
        // A cancelled scan no longer holds the task, so the tasks fixture can delete it.
        await cancelScanAndWait(api, busyScan.id)
      }
    },
  )

  test('"Show active scans" lists the scans of that task', { tag: ['@UI-TASK-019'] }, async ({ page, api, tasks }) => {
    const name = unique('inuse')
    tasks.track(name)
    const task = await createScaffoldTask(api, name)
    // The server's 409 taskInUse needs a running scan; the test above checks it, this one only the list it leads to.
    await page.route(
      (url) => url.pathname === `/api/tasks/${task.id}`,
      (route) =>
        route.request().method() === 'DELETE'
          ? fulfillError(route, { status: 409, code: 'taskInUse', message: `task ${name} is used by 1 scan that has not finished` })
          : route.fallback(),
    )
    const requests = recordApiRequests(page)
    await openPage(page, `/tasks/${task.id}`)
    await page.getByRole('button', { name: 'Delete task' }).click()
    const dialog = page.getByRole('dialog', { name: `Delete ${name}` })
    await dialog.getByLabel(`Type ${name} to confirm`).fill(name)
    await dialog.getByRole('button', { name: 'Delete task' }).click()
    await openToastItems(page).filter({ hasText: 'A scan still uses this task' }).getByRole('button', { name: 'Show active scans' }).click()
    await expect(page).toHaveURL((url) => url.pathname === '/scans')
    const listed = () => requests.filter((r) => r.url.pathname === '/api/scans' && r.url.searchParams.get('limit') === '50')
    await expect.poll(() => listed().length).toBeGreaterThan(0)
    await expect.poll(() => listed().at(-1)!.url.searchParams.get('task'), { timeout: 5_000 }).toBe(task.id)
  })

  test('a test run with a secret field leaves no secret in browser storage', { tag: ['@UI-SEC-006'] }, async ({ page, tasks }) => {
    test.setTimeout(180_000)
    const { task } = await tasks.fixture('schema-zoo')
    const secret = `ui-secret-${unique('tok')}`
    await openPage(page, `/tasks/${task.id}?tab=test`)
    const form = page.getByRole('form', { name: 'Test run inputs' })
    await form.getByRole('radio', { name: 'One analysis' }).check()
    const secretInput = form.locator('input[type="password"]')
    await expect(secretInput).toHaveCount(1)
    await secretInput.fill(secret)
    await form.getByRole('button', { name: 'Start test run' }).click()
    await expect(page.getByText(/1 analysis · 1 succeeded · 0 failed/)).toBeVisible({ timeout: 120_000 })
    // Neither the secret nor the result (which carries the secret's SHA-256) reaches browser storage.
    const secretHash = createHash('sha256').update(secret).digest('hex')
    await expectStorageWithout(page, [secret, secretHash])
    await reloadPage(page)
    await expect(page.getByRole('form', { name: 'Test run inputs' })).toBeVisible()
    await expectStorageWithout(page, [secret, secretHash])
  })
})
