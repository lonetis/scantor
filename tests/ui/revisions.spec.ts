import type { Page, Route } from '@playwright/test'
import type { BuildLogLine, Revision } from '#shared/types/revisions'
import { ApiClient, ok } from '../helpers/api-client'
import { GIT_REPOS } from '../helpers/fixtures-server'
import { fixtureTaskDir, publishAndWait, uploadAndPublish, type UploadedTask } from '../helpers/tasks'
import {
  alertBox,
  createScaffoldTask,
  deleteTaskAndWait,
  fulfillJson,
  importGitTask,
  nodeRoutedContext,
  openPage,
  patchJsonResponse,
  workerTenant,
} from '../helpers/ui-shell-tasks'
import { newApiContext } from '../helpers/users'
import { expect, test as base, unique } from '../fixtures'

const test = base.extend<object, { zoo: UploadedTask }>({
  // The worker's tenant under a session file of its own, and the dashboard's requests sent from Node (helpers/ui-shell-tasks.ts).
  user: [workerTenant, { scope: 'worker' }],
  context: nodeRoutedContext,
  // One ready schema-zoo revision per worker for the describe tests (a build per test would only cost time).
  zoo: [
    async ({ user, openapi }, use) => {
      const context = await newApiContext({ storageState: user.storageState })
      const api = new ApiClient(context, openapi)
      const name = unique('schema-zoo')
      try {
        await use(await uploadAndPublish(api, fixtureTaskDir('schema-zoo'), name, { timeoutMs: 150_000 }))
      } finally {
        await deleteTaskAndWait(api, name)
        await context.dispose()
      }
    },
    { scope: 'worker', timeout: 180_000 },
  ],
})

// The revision page (docs/ui.md §5.9): header, actions, the errors of a failed build, the build log, the facts and the
// describe view of a ready revision. The ANSI and follow behaviour of a running build log is checked with a mocked log,
// because a real build's output and timing are not under the test's control.

function buildLog(page: Page) {
  return page.getByTestId('build-log')
}

/** The row of a schema table by its property path. */
function schemaRow(page: Page, table: string) {
  return (path: string) =>
    page
      .getByLabel(table, { exact: true })
      .locator('tbody tr')
      .filter({ has: page.locator('td:first-child code', { hasText: new RegExp(`^${path.replace(/[.[\]]/g, '\\$&')}$`) }) })
}

function fact(page: Page, label: string) {
  return page.locator('dt', { hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::dd[1]')
}

test.describe('revision page', () => {
  test(
    'a failed revision shows its errors first, each with phase, location and message',
    { tag: ['@UI-TASK-025', '@UI-TASK-026', '@UI-TASK-024'] },
    async ({ page, tasks }) => {
      test.setTimeout(180_000)
      const { task, revision } = await tasks.fixture('hostile-label', { expectState: 'failed' })
      expect(revision.errors.length).toBeGreaterThan(0)
      await openPage(page, `/tasks/${task.id}/revisions/${revision.number}`)
      await expect(page).toHaveTitle(`${revision.ref} · scantor`)
      await expect(page.locator('[data-slot="title"]').first()).toContainText('failed')

      const errors = page.getByTestId('build-errors')
      await expect(errors).toBeVisible()
      const items = errors.getByRole('listitem')
      await expect(items).toHaveCount(revision.errors.length)
      for (const [index, error] of revision.errors.entries()) {
        const item = items.nth(index)
        await expect(item).toContainText(error.phase)
        if (error.file) await expect(item).toContainText([error.file, error.line, error.column].filter((part) => part !== undefined && part !== null).join(':'))
        await expect(item).toContainText(error.message.split('\n')[0]!)
      }
      // The errors come before the build log.
      const errorsBox = (await errors.boundingBox())!
      const logBox = (await buildLog(page).boundingBox())!
      expect(errorsBox.y).toBeLessThan(logBox.y)

      // Failed revisions offer no "Start scan"; the error phase is marked and its error lines are tinted.
      await expect(page.getByRole('link', { name: 'Start scan' })).toHaveCount(0)
      const phase = revision.errors[0]!.phase
      const header = buildLog(page).getByRole('button', { name: `Collapse phase ${phase}` })
      await expect(header).toHaveAttribute('aria-expanded', 'true')
      await expect(header.locator('[class*="circle-x"]')).toHaveCount(1)
      await expect(
        buildLog(page)
          .locator('div[class*="code-error"]')
          .filter({ hasText: /^error: / })
          .first(),
      ).toBeVisible()
      await header.click()
      await expect(buildLog(page).getByRole('button', { name: `Expand phase ${phase}` })).toHaveAttribute('aria-expanded', 'false')
      await expect(
        buildLog(page)
          .locator('div[class*="code-error"]')
          .filter({ hasText: /^error: / }),
      ).toHaveCount(0)
    },
  )

  test(
    'a ready git revision shows its header, actions, facts and grouped build log',
    { tag: ['@UI-TASK-024', '@UI-TASK-026', '@UI-TASK-027', '@UI-NAV-010', '@UI-NAV-027'] },
    async ({ page, api, tasks }) => {
      test.setTimeout(180_000)
      tasks.track('git-single')
      try {
        const [task] = await importGitTask(api, { url: GIT_REPOS.single })
        const message = `published by ${unique('rev')}`
        const revision = await publishAndWait(api, task!.name, { message })
        await openPage(page, `/tasks/${task!.id}/revisions/${revision.number}`)

        await expect(page).toHaveTitle(`${revision.ref} · scantor`)
        const title = page.locator('[data-slot="title"]').first()
        await expect(title).toContainText(revision.ref)
        await expect(title).toContainText('ready')
        await expect(title.getByText('privileged')).toHaveCount(0)
        await expect(page.getByText(message)).toBeVisible()
        for (const label of ['created', 'started', 'finished']) await expect(page.getByText(new RegExp(`^${label} `)).first()).toBeVisible()
        const duration = Date.parse(revision.finishedAt!) - Date.parse(revision.startedAt!)
        await expect(page.locator('span', { hasText: /^build / }).locator('span[title]')).toHaveAttribute('title', `${duration} ms`)
        await expect(page.locator('span', { hasText: /^build / }).locator('span[title]')).toHaveText(/^(\d+ ms|\d+\.\ds|\d+s|\d+m \d{2}s)$/)

        // Actions of a ready revision.
        await expect(page.getByRole('link', { name: 'Start scan' })).toHaveAttribute(
          'href',
          `/scans/new?revision=${encodeURIComponent(`${task!.id}@${revision.number}`)}`,
        )
        await expect(page.getByRole('link', { name: 'Download source' })).toHaveAttribute(
          'href',
          `/api/tasks/${task!.id}/revisions/${revision.number}/source?redirect=true`,
        )

        // Facts.
        const git = revision.source.git!
        await expect(fact(page, 'Source')).toHaveText('git')
        await expect(fact(page, 'Pack hash')).toContainText(revision.source.packSha256)
        await expect(fact(page, 'Git')).toHaveText(`${git.url}@${git.ref}:${git.path}`)
        await expect(fact(page, 'Commit')).toContainText(git.commit)
        await expect(fact(page, 'Base image')).toHaveText(revision.baseImage!.ref)
        await expect(fact(page, 'Base digest')).toContainText(revision.baseImage!.digest)
        await expect(fact(page, 'Image')).toHaveText(revision.image!.repository)
        await expect(fact(page, 'Digest')).toContainText(revision.image!.digest)
        await expect(fact(page, 'Image size')).toHaveText(/^\d+(\.\d)? (KiB|MiB|GiB)$/)
        await expect(fact(page, 'Platform')).toHaveText(`${revision.image!.platform.os}/${revision.image!.platform.arch}`)
        await expect(fact(page, 'Connector')).toHaveText(`${revision.description!.connector.language} ${revision.description!.connector.version}`)
        await expect(fact(page, 'Protocol')).toHaveText(String(revision.description!.protocolVersion))
        const schedule = revision.description!.schedule
        await expect(fact(page, 'Schedule')).toHaveText(schedule.kind === 'template' ? `template:${schedule.template}` : 'custom')

        // The build log groups the pipeline phases with collapsible headers and line counts.
        const log = ok(
          await api.call<{ lines: BuildLogLine[]; complete: boolean }>('getRevisionBuildLog', {
            path: { task: task!.id, revision: revision.number },
            query: { limit: 5000 },
          }),
          'getRevisionBuildLog',
        )
        expect(log.complete).toBe(true)
        const phases = [...new Set(log.lines.map((line) => line.phase))]
        for (const phase of phases) {
          const count = log.lines.filter((line) => line.phase === phase).length
          await expect(buildLog(page).getByRole('button', { name: `Collapse phase ${phase}` })).toContainText(`(${count})`)
        }
        await expect(buildLog(page).getByRole('button', { name: 'Follow log' })).toHaveAttribute('aria-pressed', 'true')

        await page.getByRole('link', { name: 'View files' }).click()
        await expect(page).toHaveURL(
          (url) =>
            url.pathname === `/tasks/${task!.id}` && url.searchParams.get('tab') === 'files' && url.searchParams.get('revision') === String(revision.number),
        )
      } finally {
        await deleteTaskAndWait(api, 'git-single')
      }
    },
  )

  /**
   * A build that stays "building" while the test appends log lines: the revision is patched to `building`, the log is
   * answered from `lines`. `first` decides which of the two answers the page gets first (the order of two parallel
   * requests is not under the page's control).
   */
  async function mockRunningBuild(page: Page, api: ApiClient, tasks: { track(name: string): void }, first: 'revision' | 'log') {
    const name = unique('logs')
    tasks.track(name)
    const task = await createScaffoldTask(api, name)
    const revision = ok(await api.publishRevision(name, {}), 'publishRevision')
    const revisionPath = `/api/tasks/${task.id}/revisions/${revision.number}`
    const lines: BuildLogLine[] = []
    const append = (count: number, phase: string, make: (index: number) => Partial<BuildLogLine>) => {
      for (let i = 0; i < count; i++)
        lines.push({ line: lines.length, at: new Date().toISOString(), phase, type: 'log', stream: 'stdout', ...make(lines.length) } as BuildLogLine)
    }
    let revisionAnswered: () => void = () => {}
    const revisionDone = new Promise<void>((resolve) => (revisionAnswered = resolve))
    let logAnswered: () => void = () => {}
    const logDone = new Promise<void>((resolve) => (logAnswered = resolve))
    await page.route(
      (url) => url.pathname === revisionPath,
      async (route: Route) => {
        if (first === 'log') await logDone
        await patchJsonResponse<Revision>(route, (body) => ({ ...body, state: 'building', finishedAt: null, errors: [], description: null }))
        revisionAnswered()
      },
    )
    await page.route(
      (url) => url.pathname === `${revisionPath}/logs`,
      async (route: Route) => {
        if (first === 'revision') {
          // The log component is on screen (still empty) before the first lines arrive.
          await revisionDone
          await buildLog(page).waitFor({ state: 'attached' })
        }
        const after = Number(new URL(route.request().url()).searchParams.get('afterLine') ?? '0')
        await fulfillJson(route, { lines: lines.slice(after), nextLine: lines.length, complete: false })
        logAnswered()
      },
    )
    return { task, revision, append }
  }

  const atBottom = (page: Page) => () =>
    buildLog(page)
      .locator('div.overflow-auto')
      .evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight <= 24)

  test(
    'the build log of a running build follows new lines, strips ANSI and stops following when scrolled up',
    { tag: ['@UI-TASK-026'] },
    async ({ page, api, tasks }) => {
      const { task, revision, append } = await mockRunningBuild(page, api, tasks, 'revision')
      append(3, 'pack', (n) => ({ text: `packing ${n}` }))
      append(40, 'build', (n) => ({ text: `\u001b[32mstep ${n} green\u001b[0m \u001b[1mbold\u001b[22m` }))

      await openPage(page, `/tasks/${task.id}/revisions/${revision.number}`)
      const log = buildLog(page)
      const scroller = log.locator('div.overflow-auto')
      await expect(log.getByText('step 42 green bold', { exact: true })).toBeVisible()
      await expect(log).not.toContainText('\u001b')
      await expect(log).not.toContainText('[32m')
      await expect(log.getByRole('button', { name: 'Collapse phase build' })).toContainText('(40)')
      await expect(log.getByRole('button', { name: 'Follow log' })).toHaveAttribute('aria-pressed', 'true')
      await expect.poll(atBottom(page)).toBe(true)

      // New lines arrive: the log stays at the bottom.
      append(20, 'build', (n) => ({ text: `step ${n} more` }))
      await expect(log.getByText('step 62 more', { exact: true })).toBeVisible()
      await expect.poll(atBottom(page)).toBe(true)

      // The user scrolls up: following stops and new lines do not move the view.
      await scroller.evaluate((element) => {
        element.scrollTop = 0
        element.dispatchEvent(new Event('scroll'))
      })
      const follow = log.getByRole('button', { name: 'Follow log' })
      await expect(follow).toHaveAttribute('aria-pressed', 'false')
      append(1, 'build', () => ({ type: 'error', error: { phase: 'build', file: 'Dockerfile', line: 3, column: 1, message: 'the build broke' } }))
      await expect(log.getByText('error: Dockerfile:3:1: the build broke')).toBeVisible()
      await expect(log.getByText('error: Dockerfile:3:1: the build broke')).toHaveClass(/code-error/)
      expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0)

      await follow.click()
      await expect(follow).toHaveAttribute('aria-pressed', 'true')
      await expect.poll(atBottom(page)).toBe(true)
      await expect(alertBox(page, 'The build log could not be read')).toHaveCount(0)
    },
  )

  test('a build log read before the revision opens scrolled to the bottom', { tag: ['@UI-TASK-026'] }, async ({ page, api, tasks }) => {
    const { task, revision, append } = await mockRunningBuild(page, api, tasks, 'log')
    append(60, 'build', (n) => ({ text: `step ${n}` }))
    await openPage(page, `/tasks/${task.id}/revisions/${revision.number}`)
    const log = buildLog(page)
    await expect(log.getByText('step 59', { exact: true })).toBeAttached()
    await expect(log.getByRole('button', { name: 'Follow log' })).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(atBottom(page), { timeout: 5_000 }).toBe(true)
  })

  test('an unknown revision shows "Revision not found"', { tag: ['@UI-TASK-024'] }, async ({ page, api, tasks }) => {
    const name = unique('norev')
    tasks.track(name)
    const task = await createScaffoldTask(api, name)
    await openPage(page, `/tasks/${task.id}/revisions/7`)
    await expect(alertBox(page, 'Revision not found')).toBeVisible()
  })

  test(
    'a ready revision describes its schemas in tables with badges, raw JSON, settings defaults and the manifest',
    { tag: ['@UI-TASK-028'] },
    async ({ page, zoo }) => {
      const { task, revision } = zoo
      const description = revision.description!
      // schema-zoo has no deprecated, read-only or plain writeOnly property: three are appended to its task config.
      await page.route(
        (url) => url.pathname === `/api/tasks/${task.id}/revisions/${revision.number}`,
        (route) =>
          patchJsonResponse<Revision>(route, (body) => {
            const taskConfig = body.description!.schemas.taskConfig as { properties: Record<string, unknown> }
            taskConfig.properties = {
              ...taskConfig.properties,
              legacy_mode: { type: 'string', deprecated: true, description: 'Replaced by level.' },
              computed: { type: 'integer', readOnly: true },
              password: { type: 'string', writeOnly: true, format: 'password' },
            }
            return body
          }),
      )
      await openPage(page, `/tasks/${task.id}/revisions/${revision.number}`)

      const tabs = ['Task config', 'Scan config', 'Analysis config', 'Result']
      for (const label of tabs) await expect(page.getByRole('tab', { name: label, exact: true })).toBeVisible()
      const table = page.getByLabel('Task config schema', { exact: true })
      for (const header of ['Property', 'Type', 'Required', 'Default', 'Constraints', 'Description']) {
        await expect(table.getByRole('columnheader', { name: header, exact: true })).toBeVisible()
      }

      // Top-level properties in source order.
      const properties = [
        ...Object.keys((description.schemas.taskConfig as { properties: Record<string, unknown> }).properties),
        'legacy_mode',
        'computed',
        'password',
      ]
      const paths = await table.locator('tbody tr td:first-child code').allInnerTexts()
      expect(paths.filter((path) => !path.includes('.') && !path.includes('['))).toEqual(properties)
      expect(properties.slice(0, 4)).toEqual(['text', 'count', 'ratio', 'step'])

      const rowOf = schemaRow(page, 'Task config schema')
      await expect(rowOf('text').getByRole('cell').nth(1)).toHaveText('string')
      await expect(rowOf('text').getByRole('cell').nth(2)).toHaveText(/required|optional/)
      await expect(rowOf('text').getByRole('cell').nth(3)).toHaveText('"hello"')
      await expect(rowOf('text').getByRole('cell').nth(4)).toContainText('minLength: 1')
      await expect(rowOf('text').getByRole('cell').nth(4)).toContainText('maxLength: 50')
      await expect(rowOf('text').getByRole('cell').nth(5)).toContainText('A bounded string.')
      await expect(rowOf('level').getByRole('cell').nth(4)).toContainText('one of: ')
      await expect(rowOf('address.zip')).toBeVisible()
      await expect(rowOf('wordlist').getByText('upload', { exact: true })).toBeVisible()
      await expect(rowOf('legacy_mode').getByText('deprecated', { exact: true })).toBeVisible()
      await expect(rowOf('computed').getByText('read-only', { exact: true })).toBeVisible()
      await expect(rowOf('password').getByText('secret', { exact: true })).toBeVisible()
      await expect(rowOf('text').getByText(/^(secret|upload|file|deprecated|read-only)$/)).toHaveCount(0)

      await page.getByRole('tab', { name: 'Result', exact: true }).click()
      const result = page.getByLabel('Result schema', { exact: true })
      await expect(schemaRow(page, 'Result schema')('report').getByText('file', { exact: true })).toBeVisible()

      // Raw JSON and back.
      await page.getByRole('button', { name: 'Show raw JSON of Result schema' }).click()
      await expect(result).toHaveCount(0)
      await expect(page.getByText('api_token_sha256').first()).toBeVisible()
      await page.getByRole('button', { name: 'Show table of Result schema' }).click()
      await expect(result).toBeVisible()

      await expect(page.locator('p.section-label', { hasText: 'Settings defaults' })).toBeVisible()
      await expect(page.locator('p.section-label', { hasText: 'Manifest' })).toBeVisible()
      if (description.warnings.length > 0) await expect(page.locator('p.section-label', { hasText: 'Warnings' })).toBeVisible()
      else await expect(page.locator('p.section-label', { hasText: 'Warnings' })).toHaveCount(0)
    },
  )

  test('a nullable writeOnly property carries the "secret" badge', { tag: ['@UI-TASK-028'] }, async ({ page, zoo }) => {
    await openPage(page, `/tasks/${zoo.task.id}/revisions/${zoo.revision.number}`)
    const rowOf = schemaRow(page, 'Task config schema')
    await expect(rowOf('api_token')).toBeVisible()
    await expect(rowOf('api_token').getByText('secret', { exact: true })).toBeVisible({ timeout: 5_000 })
  })
})
