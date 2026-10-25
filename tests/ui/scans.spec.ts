import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page, Request } from '@playwright/test'
import type { Revision } from '#shared/types/revisions'
import type { Scan } from '#shared/types/scans'
import { expect, test, unique } from '../fixtures'
import { ok } from '../helpers/api-client'
import { exampleTaskDir, packTask, publishAndWait, waitForRevision } from '../helpers/tasks'
import {
  PENDING_SETTINGS,
  SHARED_SETUP_TIMEOUT_MS,
  badges,
  completedScan,
  deleteOwnScans,
  expectAfterRefresh,
  failWithApiError,
  formSection,
  formValue,
  gotoApp,
  headerState,
  openScanPage,
  openScanTab,
  patchJsonResponses,
  privilegedCopy,
  reloadApp,
  renderedFieldPaths,
  row,
  scanTab,
  schemaField,
  sharedTask,
  sharedTasksOf,
  shieldFromNetworkChanges,
  startOwnScan,
  trackOwnScan,
  uTable,
  waitForOwnScan,
  expectToast,
} from '../helpers/ui-scans-kit'

// The scans list, the new-scan form and the scan detail page (docs/ui.md §5.11–§5.13.1). Tasks are built once per
// worker (helpers/ui-scans-kit.ts); scans that only need to be active use a node selector no node matches, so they
// cost no worker, and tests that only read a finished scan share one.

// Chromium aborts in-flight requests whenever the inner dockerd changes networks (helpers/ui-scans-kit.ts).
test.beforeEach(async ({ page }) => shieldFromNetworkChanges(page))
// The shared tasks and the shared finished scan of this spec are prepared before its first test in a worker, outside
// the tests' timeouts.
test.beforeAll(async ({ user, openapi }) => {
  test.setTimeout(SHARED_SETUP_TIMEOUT_MS)
  await Promise.all([sharedTasksOf(user, openapi, ['throws', 'sleep', 'schema-zoo', 'hostile-label', 'range-echo']), completedScan(user, openapi)])
})
test.afterEach(deleteOwnScans)

const SCAN_ACTIONS = ['Open', 'Pause', 'Resume', 'Cancel', 'Restart', 'Delete'] as const

async function openRowMenu(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: `Scan actions for ${name}` }).click()
  await expect(page.getByRole('menu')).toBeVisible()
}

/** The enabled row actions of the open row menu. */
async function enabledActions(page: Page): Promise<string[]> {
  const enabled: string[] = []
  for (const label of SCAN_ACTIONS) {
    const item = page.getByRole('menuitem', { name: label, exact: true })
    await expect(item).toBeVisible()
    if ((await item.getAttribute('data-disabled')) === null && (await item.getAttribute('aria-disabled')) !== 'true') enabled.push(label)
  }
  return enabled
}

const controls = (page: Page) => page.getByRole('toolbar', { name: 'Scan controls' })
const control = (page: Page, name: string) => controls(page).getByRole('button', { name, exact: true })
/** USelectMenu triggers are buttons named by their aria-label (USelect triggers are comboboxes). */
const selectMenu = (page: Page, name: string) => page.getByRole('button', { name, exact: true })

async function expectTooltip(page: Page, button: string, text: string): Promise<void> {
  await control(page, button).locator('..').hover()
  await expect(page.getByRole('tooltip').filter({ hasText: text }).first()).toBeVisible()
  await page.mouse.move(0, 0)
}

function isStartScan(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === '/api/scans'
}

test.describe('scans list', () => {
  test(
    'state and task filters narrow the table and persist across reloads; rows show every column',
    { tag: ['@UI-SCAN-001', '@UI-SCAN-002'] },
    async ({ page, user, openapi }) => {
      const [throws, done] = await Promise.all([sharedTask(user, openapi, 'throws'), completedScan(user, openapi)])
      const pending = await startOwnScan(user, openapi, { revision: throws.revision.id, name: unique('list-pending'), settings: PENDING_SETTINGS })

      await gotoApp(page, '/scans')
      const stateFilter = selectMenu(page, 'Filter by state')
      const taskFilter = selectMenu(page, 'Filter by task')
      await expect(stateFilter).toContainText('All states except deleted')
      await expect(taskFilter).toContainText('All tasks')
      const table = uTable(page, 'Scans')
      await expect(table.getByRole('columnheader')).toHaveText(['Scan', 'Revision', 'State', 'Progress', 'Rate', 'ETA', 'Workers', 'Created', 'Finished', ''])
      await expectAfterRefresh(page, async () => {
        await expect(row(table, pending.id).locator('[data-state="running"]')).toBeVisible({ timeout: 2000 })
      })
      const pendingRow = row(table, pending.id)
      await expect(pendingRow.getByRole('link', { name: pending.name! })).toHaveAttribute('href', `/scans/${pending.id}`)
      await expect(pendingRow.locator(`code[data-id="${pending.id}"]`)).toHaveText(pending.id.slice(0, 8))
      await expect(pendingRow.getByRole('link', { name: throws.revision.ref })).toHaveAttribute('href', `/tasks/${throws.task.id}/revisions/1`)
      await expectAfterRefresh(page, async () => {
        await expect(pendingRow).toContainText(/1\s*conditions/, { timeout: 2000 })
      })
      const cells = pendingRow.getByRole('cell')
      await expect(cells.nth(4)).toHaveText('0 / min')
      await expect(cells.nth(5)).toHaveText('–')
      await expect(cells.nth(6)).toHaveText('1 × 1')
      await expect(cells.nth(7)).toHaveText(/just now|min ago/)
      await expect(cells.nth(8)).toHaveText('–')
      const doneRow = row(table, done.id)
      await expect(badges(doneRow)).toHaveText('completed')
      await expect(doneRow).toContainText('4 / 4 · 100.0 %')
      await expect(doneRow.getByRole('cell').nth(8)).toHaveText(/just now|min ago|h ago/)

      // State filter.
      await stateFilter.click()
      await page.getByRole('option', { name: 'completed', exact: true }).click()
      await page.keyboard.press('Escape')
      await expect(row(table, done.id)).toBeVisible()
      await expect(row(table, pending.id)).toHaveCount(0)
      // Task filter on top.
      await taskFilter.click()
      await page.getByRole('option', { name: throws.task.name, exact: true }).click()
      await expect(taskFilter).toContainText(throws.task.name)
      await expect(row(table, done.id)).toBeVisible()

      await reloadApp(page)
      await expect(stateFilter).toContainText('completed')
      await expect(taskFilter).toContainText(throws.task.name)
      await expect(row(table, done.id)).toBeVisible()
      await expect(row(table, pending.id)).toHaveCount(0)
      // Users get no "Only mine" switch and no owner column.
      await expect(page.getByRole('switch', { name: 'Only mine' })).toHaveCount(0)
      await expect(table.getByRole('columnheader', { name: 'Owner' })).toHaveCount(0)
    },
  )

  test('row actions follow the state; cancel and delete confirm, restart opens its dialog', { tag: ['@UI-SCAN-003'] }, async ({ page, user, openapi }) => {
    const throws = await sharedTask(user, openapi, 'throws')
    const scan = await startOwnScan(user, openapi, { revision: throws.revision.id, name: unique('row-actions'), settings: PENDING_SETTINGS })
    await waitForOwnScan(user, openapi, scan.id, 'running', 60_000)
    const name = scan.name!

    await gotoApp(page, '/scans')
    const table = uTable(page, 'Scans')
    await expect(row(table, scan.id).locator('[data-state="running"]')).toBeVisible()
    await openRowMenu(page, name)
    expect(await enabledActions(page)).toEqual(['Open', 'Pause', 'Cancel', 'Restart'])
    await page.getByRole('menuitem', { name: 'Pause', exact: true }).click()
    await expectToast(page, 'Scan paused')
    await expect(row(table, scan.id).locator('[data-state="paused"]')).toBeVisible()

    await openRowMenu(page, name)
    expect(await enabledActions(page)).toEqual(['Open', 'Resume', 'Cancel', 'Restart'])
    await page.getByRole('menuitem', { name: 'Restart', exact: true }).click()
    const restart = page.getByRole('dialog', { name: 'Restart scan' })
    await expect(restart.getByLabel('Name')).toHaveValue(`${name} (restart)`)
    await restart.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(restart).toHaveCount(0)

    await openRowMenu(page, name)
    await page.getByRole('menuitem', { name: 'Cancel', exact: true }).click()
    const cancel = page.getByRole('dialog', { name: `Cancel scan ${name}?` })
    await expect(cancel).toContainText('In-flight analyses are aborted')
    await cancel.getByRole('button', { name: 'Cancel scan', exact: true }).click()
    await expectToast(page, 'Scan cancelled')
    await expect(row(table, scan.id).locator('[data-state="cancelled"]')).toBeVisible()

    await openRowMenu(page, name)
    expect(await enabledActions(page)).toEqual(['Open', 'Restart', 'Delete'])
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
    const remove = page.getByRole('dialog', { name: `Delete scan ${name}?` })
    const confirmDelete = remove.getByRole('button', { name: 'Delete scan', exact: true })
    await expect(confirmDelete).toBeDisabled()
    await remove.getByLabel(`Type ${name} to confirm`).fill(name)
    await confirmDelete.click()
    await expectToast(page, 'Scan deletion started')
    await expect(row(table, scan.id)).toHaveCount(0)
  })

  test('"Load more" pages through the list', { tag: ['@UI-SCAN-004'] }, async ({ page, user, openapi }) => {
    const throws = await sharedTask(user, openapi, 'throws')
    const started: Scan[] = []
    for (let index = 0; index < 3; index++)
      started.push(await startOwnScan(user, openapi, { revision: throws.revision.id, name: unique(`page-${index}`), settings: PENDING_SETTINGS }))
    // Pages of 2 instead of 50: the real API pages with its cursor, so three scans need "Load more".
    await page.route('**/api/scans?*', async (route) => {
      const url = new URL(route.request().url())
      if (route.request().method() === 'GET' && url.searchParams.get('limit') === '50') url.searchParams.set('limit', '2')
      await route.fallback({ url: url.toString() })
    })
    await gotoApp(page, '/scans')
    const table = uTable(page, 'Scans')
    await expect(row(table, started[2]!.id)).toBeVisible()
    await expect(row(table, started[1]!.id)).toBeVisible()
    await expect(row(table, started[0]!.id)).toHaveCount(0)
    const more = page.getByRole('button', { name: 'Load more' })
    const paged = page.waitForRequest((request) => request.url().includes('/api/scans?') && new URL(request.url()).searchParams.has('cursor'))
    await more.click()
    await paged
    await expect(row(table, started[0]!.id)).toBeVisible()
    await expect(row(table, started[2]!.id)).toBeVisible()
  })

  test('"Load more" keeps its page when a refresh of the list was in flight', { tag: ['@UI-SCAN-004'] }, async ({ page, user, openapi }) => {
    const throws = await sharedTask(user, openapi, 'throws')
    const started: Scan[] = []
    for (let index = 0; index < 3; index++)
      started.push(await startOwnScan(user, openapi, { revision: throws.revision.id, name: unique(`race-${index}`), settings: PENDING_SETTINGS }))
    // Pages of 2; the next read of the first page (the refresh) is held until "Load more" has loaded its page.
    let holdNextFirstPage = false
    let refreshHeld!: () => void
    const held = new Promise<void>((resolve) => (refreshHeld = resolve))
    let releaseRefresh!: () => void
    const released = new Promise<void>((resolve) => (releaseRefresh = resolve))
    await page.route('**/api/scans?*', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const url = new URL(route.request().url())
      if (url.searchParams.get('limit') === '50') url.searchParams.set('limit', '2')
      if (holdNextFirstPage && !url.searchParams.has('cursor')) {
        holdNextFirstPage = false
        refreshHeld()
        await released
      }
      await route.fallback({ url: url.toString() })
    })
    await gotoApp(page, '/scans')
    const table = uTable(page, 'Scans')
    await expect(row(table, started[1]!.id)).toBeVisible()
    await expect(row(table, started[0]!.id)).toHaveCount(0)

    holdNextFirstPage = true
    const refreshButton = page.getByRole('button', { name: 'Refresh', exact: true })
    await refreshButton.click()
    await held
    const paged = page.waitForResponse((response) => response.url().includes('/api/scans?') && new URL(response.url()).searchParams.has('cursor'))
    await page.getByRole('button', { name: 'Load more' }).click()
    await paged
    await expect(row(table, started[0]!.id)).toBeVisible()
    // The refresh ends after "Load more": the loaded page must stay.
    releaseRefresh()
    await expect(refreshButton).toBeEnabled()
    await expect(row(table, started[0]!.id)).toBeVisible({ timeout: 2000 })
  })
})

test.describe('scans list for admins', () => {
  test.use({ role: 'admin' })

  test('admins see the owner column and can show only their own scans', { tag: ['@UI-SCAN-001', '@UI-SCAN-002'] }, async ({ page, user, openapi }) => {
    // A scan of the tenant (the admin's own fixtures act as the admin); the newest scans come first.
    const throws = await sharedTask(user, openapi, 'throws')
    const foreign = await startOwnScan(user, openapi, { revision: throws.revision.id, name: unique('admin-foreign-scan'), settings: PENDING_SETTINGS })
    await gotoApp(page, '/scans')
    const table = uTable(page, 'Scans')
    await expect(table.getByRole('columnheader', { name: 'Owner' })).toBeVisible()
    await expectAfterRefresh(page, async () => {
      await expect(row(table, foreign.id)).toContainText(user.email, { timeout: 2000 })
    })
    const onlyMine = page.getByRole('switch', { name: 'Only mine' })
    await expect(onlyMine).not.toBeChecked()
    await onlyMine.click()
    await expect(onlyMine).toBeChecked()
    await expect(row(table, foreign.id)).toHaveCount(0)
    await expect(table.getByRole('columnheader', { name: 'Owner' })).toHaveCount(0)
    await reloadApp(page)
    await expect(page.getByRole('switch', { name: 'Only mine' })).toBeChecked()
    await expect(row(table, foreign.id)).toHaveCount(0)
  })
})

test.describe('new scan form', () => {
  test(
    'the revision picker explains unknown tasks, missing and non-ready revisions',
    { tag: ['@UI-SCAN-005'] },
    async ({ page, api, user, openapi, tasks }) => {
      const [zoo, failed] = await Promise.all([sharedTask(user, openapi, 'schema-zoo'), sharedTask(user, openapi, 'hostile-label')])
      const draft = unique('draft-only')
      ok(await api.uploadTask(await packTask(exampleTaskDir('echo'), { name: draft }), { publish: false }), 'uploadTask')
      tasks.track(draft)

      await gotoApp(page, `/scans/new?revision=${zoo.task.name}@latest`)
      await expect(selectMenu(page, 'Task')).toContainText(zoo.task.name)
      await expect(page.getByRole('combobox', { name: 'Revision' })).toContainText('latest ready revision')
      const facts = page.locator('div', { has: page.getByRole('link', { name: zoo.revision.ref }) }).last()
      await expect(facts.getByRole('link', { name: zoo.revision.ref })).toHaveAttribute('href', `/tasks/${zoo.task.id}/revisions/1`)
      await expect(facts).toContainText('python')
      await expect(facts).toContainText('template: single')
      await expect(facts).toContainText(/published (just now|\d+ min ago|\d+ h ago)/)
      await expect(facts).not.toContainText('privileged')
      await page.getByRole('combobox', { name: 'Revision' }).click()
      await expect(page.getByRole('option')).toHaveText(['latest ready revision', '@1'])
      await page.getByRole('option', { name: '@1' }).click()
      await expect(page.getByRole('button', { name: 'Start scan' })).toBeEnabled()

      await gotoApp(page, '/scans/new?revision=no-such-task-anywhere@latest')
      await expect(page.getByText('Task no-such-task-anywhere was not found among your tasks.')).toBeVisible()
      await gotoApp(page, `/scans/new?revision=${draft}`)
      await expect(page.getByText('This task has no ready revision yet. Publish one first.')).toBeVisible()
      await gotoApp(page, `/scans/new?revision=${failed.task.name}@1`)
      await expect(page.getByText('Revision @1 is failed; only ready revisions can be scanned.')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Start scan' })).toHaveCount(0)

      // Picking the task by hand (the search asks the server, so every task can be found).
      await gotoApp(page, '/scans/new')
      await selectMenu(page, 'Task').click()
      await page.getByPlaceholder('Search tasks…').fill(zoo.task.name)
      await page.getByRole('option').filter({ hasText: zoo.task.name }).click()
      await expect(page.getByRole('link', { name: zoo.revision.ref })).toBeVisible()
      // Another task starts at "latest ready revision" again, not at the number chosen for the first one.
      await page.getByRole('combobox', { name: 'Revision' }).click()
      await page.getByRole('option', { name: '@1' }).click()
      await selectMenu(page, 'Task').click()
      await page.getByPlaceholder('Search tasks…').fill(draft)
      await page.getByRole('option').filter({ hasText: draft }).click()
      await expect(page.getByRole('combobox', { name: 'Revision' })).toContainText('latest ready revision')
      await expect(page.getByText('This task has no ready revision yet. Publish one first.')).toBeVisible()
    },
  )

  test(
    'config forms follow the revision\'s schemas in source order with "Edit as JSON"; another revision resets configs, settings and estimate',
    { tag: ['@UI-SCAN-007'] },
    async ({ page, api, tasks }) => {
      // Two revisions with different schemas need a task of its own (shared tasks never change): two builds.
      test.setTimeout(180_000)
      const sleep = await tasks.example('sleep')
      // Revision 2 adds two task config fields after `seconds`, in an order that is not alphabetical.
      const main = await readFile(join(exampleTaskDir('sleep'), 'main.py'), 'utf8')
      const seconds = '    seconds: float = Field(default=5, ge=0, le=86400, description="How long each analysis sleeps.")\n'
      const changed = main.replace(
        seconds,
        `${seconds}    zeta: str = Field(default="z", description="Added in revision 2.")\n    alpha: int = Field(default=1, description="Added in revision 2.")\n`,
      )
      expect(changed).not.toBe(main)
      ok(await api.call('writeTaskFiles', { path: { task: sleep.task.name }, body: { files: { 'main.py': changed } } }), 'writeTaskFiles')
      const second = await publishAndWait(api, sleep.task.name)
      expect(second.number).toBe(2)
      const firstSchema = sleep.revision.description!.schemas.taskConfig as { properties: Record<string, unknown> }
      const secondSchema = second.description!.schemas.taskConfig as { properties: Record<string, unknown> }
      expect(Object.keys(secondSchema.properties)).toEqual(['seconds', 'zeta', 'alpha'])

      await gotoApp(page, `/scans/new?revision=${sleep.task.name}@1`)
      const taskConfig = formSection(page, '3 · Task config')
      const scanConfig = formSection(page, '4 · Scan config')
      await expect(schemaField(taskConfig, 'seconds')).toBeVisible()
      await expect.poll(() => renderedFieldPaths(taskConfig)).toEqual(Object.keys(firstSchema.properties))
      await expect.poll(() => renderedFieldPaths(scanConfig)).toEqual(['times'])
      // "Edit as JSON" edits a config as text, and the form takes the value back.
      await taskConfig.getByRole('button', { name: 'Edit as JSON' }).click()
      await taskConfig.getByRole('textbox', { name: 'taskConfig as JSON' }).fill('{"seconds": 2}')
      await taskConfig.getByRole('button', { name: 'Edit as JSON' }).click()
      await expect(schemaField(taskConfig, 'seconds').getByRole('spinbutton')).toHaveValue('2')
      // Settings and an estimate that needs a confirmation.
      const workers = page.getByRole('spinbutton', { name: 'Runner workers' })
      await workers.fill('3')
      await workers.blur()
      const times = schemaField(scanConfig, 'times').getByRole('spinbutton')
      await times.fill('1500')
      await times.blur()
      const size = formSection(page, '6 · Size')
      await expect(size.getByRole('status')).toContainText('exactly 1,500 analyses')
      await expect(page.getByRole('checkbox', { name: 'I want to start about 1,500 analyses' })).toBeVisible()

      // Another revision: its own schemas, and configs, settings and the estimate start over.
      await page.getByRole('combobox', { name: 'Revision' }).click()
      await page.getByRole('option', { name: '@2', exact: true }).click()
      await expect(schemaField(taskConfig, 'zeta')).toBeVisible()
      await expect.poll(() => renderedFieldPaths(taskConfig)).toEqual(['seconds', 'zeta', 'alpha'])
      await expect(schemaField(taskConfig, 'seconds').getByRole('spinbutton')).toHaveValue('')
      await expect(times).toHaveValue('')
      await expect(workers).toHaveValue(String(second.settingsDefaults!.workers))
      await expect(page.getByRole('checkbox', { name: /^I want to start about/ })).toHaveCount(0)
      await expect(size.getByRole('status')).toContainText('exactly 1 analyses')
      expect(await formValue(taskConfig, 'taskConfig')).toEqual({})
      expect(await formValue(scanConfig, 'scanConfig')).toEqual({})
    },
  )

  test(
    'scaling, advanced settings and the estimate with its confirmation; only changed settings are sent',
    { tag: ['@UI-SCAN-008', '@UI-SCAN-009', '@UI-SCAN-010', '@UI-SCAN-011', '@UI-SCAN-012'] },
    async ({ page, api, user, openapi }) => {
      const sleep = await sharedTask(user, openapi, 'sleep')
      const defaults = sleep.revision.settingsDefaults
      if (!defaults) throw new Error(`${sleep.revision.ref} has no settings defaults`)
      const info = ok(await api.getInstanceInfo(), 'getInstanceInfo')

      await gotoApp(page, `/scans/new?revision=${sleep.task.name}@latest`)
      const workers = page.getByRole('spinbutton', { name: 'Runner workers' })
      const processes = page.getByRole('spinbutton', { name: 'Processes per worker' })
      await expect(workers).toHaveValue(String(defaults.workers))
      await expect(processes).toHaveValue(String(defaults.processes))
      await expect(page.getByText(`1–${info.limits.maxWorkersPerScan}`, { exact: true })).toBeVisible()
      await expect(page.getByText(`1–${info.limits.maxProcessesPerWorker}`, { exact: true })).toBeVisible()
      const total = formSection(page, '5 · Scaling and limits').locator('p', { hasText: 'Total:' })
      const perWorker = (count: number) =>
        `per worker: ${Math.round(count * defaults.resources.cpus * 100) / 100} CPUs, ${new Intl.NumberFormat('en-US').format(count * defaults.resources.memoryMiB + 256)} MiB memory`
      await expect(total).toHaveText(`Total: 1 runner worker × 1 process = 1 concurrent analysis; ${perWorker(1)}`)
      await workers.fill('2')
      await processes.fill('3')
      await processes.blur()
      await expect(total).toHaveText(`Total: 2 runner workers × 3 processes = 6 concurrent analyses; ${perWorker(3)}`)
      // Bounded by the instance limits.
      await workers.fill(String(info.limits.maxWorkersPerScan + 5))
      await workers.blur()
      await expect(workers).toHaveValue(String(info.limits.maxWorkersPerScan))
      await workers.fill('2')
      await workers.blur()

      // The estimate of the repeat template: a confirmation above the threshold, a block above the instance maximum.
      const size = formSection(page, '6 · Size')
      const start = page.getByRole('button', { name: 'Start scan' })
      await expect(size.getByRole('status')).toContainText('exactly 1 analyses')
      const times = page.getByRole('spinbutton', { name: 'times' })
      await times.fill('1500')
      await times.blur()
      await expect(size).toContainText('exactly 1,500 analyses')
      await expect(size).toContainText('Large scan: confirmation required')
      const confirm = page.getByRole('checkbox', { name: 'I want to start about 1,500 analyses' })
      await expect(confirm).not.toBeChecked()
      await expect(start).toBeDisabled()
      await confirm.check()
      await expect(start).toBeEnabled()
      await times.fill('30000000')
      await times.blur()
      await expect(size).toContainText('exactly 30,000,000 analyses')
      await expect(size).toContainText('Above the instance maximum')
      await expect(start).toBeDisabled()
      await times.fill('1500')
      await times.blur()
      await expect(size).toContainText('exactly 1,500 analyses')
      await expect(start).toBeEnabled()

      // Advanced settings: every limit is there; only the changed ones are sent.
      await page.getByRole('button', { name: 'Advanced settings' }).click()
      for (const label of [
        'Timeout per analysis (seconds)',
        'Attempts per analysis',
        'Analyses per process before recycling',
        'Backoff: first delay (ms)',
        'Backoff: factor',
        'Backoff: longest delay (ms)',
        'Backoff jitter',
        'CPUs per process',
        'Memory per process (MiB)',
        'Node pool',
      ])
        await expect(page.getByLabel(label, { exact: true })).toBeVisible()
      await expect(page.getByRole('switch', { name: 'Backoff jitter' })).toBeChecked()
      await expect(page.getByText('Randomize retry delays', { exact: true })).toBeVisible()
      await expect(page.getByText('Node labels', { exact: true })).toBeVisible()
      await expect(page.getByLabel('Timeout per analysis (seconds)')).toHaveValue(String(Math.round(defaults.timeoutMs / 1000)))
      await page.getByLabel('Attempts per analysis').fill('5')
      await page.getByLabel('Attempts per analysis').blur()
      // A node label no node carries keeps the scan from running.
      await page.getByRole('button', { name: 'Add label' }).click()
      await page.getByLabel('Key of label 1').fill('zone')
      // The value is named after its key once the key is set.
      await page.getByLabel('Value of zone', { exact: true }).fill('scantor-test-nowhere')

      const request = page.waitForRequest(isStartScan)
      await page.getByRole('button', { name: 'Start scan' }).click()
      const body = (await request).postDataJSON() as {
        revision: string
        settings: Record<string, unknown>
        confirm?: boolean
        scanConfig: Record<string, unknown>
      }
      expect(body.revision).toBe(sleep.revision.id)
      expect(body.confirm).toBe(true)
      expect(body.scanConfig).toEqual({ times: 1500 })
      expect(body.settings).toEqual({ workers: 2, processes: 3, maxAttempts: 5, nodeSelector: { labels: { zone: 'scantor-test-nowhere' } } })
      await page.waitForURL(/\/scans\/[0-9a-f-]{36}$/)
      const scanId = page.url().split('/').pop()!
      trackOwnScan(user, openapi, scanId)
      await expect(controls(page)).toBeVisible()
      const started = ok(await api.getScan(scanId), 'getScan')
      expect(started.settings).toMatchObject({ workers: 2, processes: 3, maxAttempts: 5 })
    },
  )

  test('the confirmation checkbox is named after the current estimate', { tag: ['@UI-SCAN-011'] }, async ({ page, user, openapi }) => {
    const sleep = await sharedTask(user, openapi, 'sleep')
    await gotoApp(page, `/scans/new?revision=${sleep.task.name}@latest`)
    const size = formSection(page, '6 · Size')
    const times = page.getByRole('spinbutton', { name: 'times' })
    await times.fill('1500')
    await times.blur()
    await expect(page.getByRole('checkbox', { name: 'I want to start about 1,500 analyses' })).toBeVisible()
    await times.fill('2000')
    await times.blur()
    await expect(size).toContainText('exactly 2,000 analyses')
    await expect(size.getByText('I want to start about 2,000 analyses')).toBeVisible()
    await expect(page.getByRole('checkbox', { name: 'I want to start about 2,000 analyses' })).toBeVisible({ timeout: 5000 })
  })

  test(
    'custom schedules explain that their size is known later; estimates that are no exact count show "≈"',
    { tag: ['@UI-SCAN-010'] },
    async ({ page, user, openapi }) => {
      const [throws, sleep] = await Promise.all([sharedTask(user, openapi, 'throws'), sharedTask(user, openapi, 'sleep')])
      await gotoApp(page, `/scans/new?revision=${throws.task.name}@latest`)
      await expect(page.getByText('custom schedule', { exact: true })).toBeVisible()
      await expect(formSection(page, '6 · Size').getByRole('status')).toHaveText('The number of analyses is known after scheduling starts.')
      // An upper bound (as crux answers): the estimate is patched, the template's own estimates are exact.
      await page.route('**/api/templates/repeat/estimate', async (route) => {
        const response = await route.fetch()
        await route.fulfill({ response, json: { ...((await response.json()) as Record<string, unknown>), exact: false } })
      })
      await gotoApp(page, `/scans/new?revision=${sleep.task.name}@latest`)
      await expect(page.getByText('template: repeat', { exact: true })).toBeVisible()
      await expect(formSection(page, '6 · Size').getByRole('status')).toContainText('≈ 1 analyses')
    },
  )

  test(
    'server answers: configInvalid lands on the field or the form, other rejections are form alerts',
    { tag: ['@UI-SCAN-012', '@UI-SCAN-013'] },
    async ({ page, user, openapi }) => {
      const range = await sharedTask(user, openapi, 'range-echo')
      await gotoApp(page, `/scans/new?revision=${range.task.name}@latest`)
      const scanConfig = formSection(page, '4 · Scan config')
      const requests: string[] = []
      page.on('request', (request) => {
        if (isStartScan(request)) requests.push(request.url())
      })

      // A client-side failure (an integer field with a fraction) sends nothing.
      const step = scanConfig.getByRole('spinbutton', { name: 'step' })
      await scanConfig.getByRole('button', { name: 'Edit as JSON' }).click()
      const json = scanConfig.getByRole('textbox', { name: 'scanConfig as JSON' })
      await json.fill('{"step": 1.5}')
      await page.getByRole('button', { name: 'Start scan' }).click()
      await expect(page.getByText('Check the highlighted fields')).toBeVisible()
      expect(requests).toHaveLength(0)

      // step 0 passes the JSON Schema but the range template rejects it at scan start (configInvalid).
      await json.fill('{"step": 0}')
      const rejected = page.waitForResponse((response) => isStartScan(response.request()))
      await page.getByRole('button', { name: 'Start scan' }).click()
      const answer = await rejected
      expect(answer.status()).toBe(422)
      const issue = ((await answer.json()) as { error: { code: string; details: { issues: { path: string; message: string }[] } } }).error
      expect(issue.code).toBe('configInvalid')
      const stepIssue = issue.details.issues.find((entry) => entry.path === '/scanConfig/step')!
      expect(stepIssue).toBeDefined()
      // In JSON mode no field is rendered: the issue is listed at form level.
      const formLevel = scanConfig.getByText('The server rejected this configuration')
      await expect(formLevel).toBeVisible()
      await expect(scanConfig).toContainText(`step: ${stepIssue.message}`)

      // In form mode the same issue lands on its field (the value is not typed: a keystroke would schedule the field's
      // own validation, which replaces server issues).
      await scanConfig.getByRole('button', { name: 'Edit as JSON' }).click()
      await expect(step).toHaveValue('0')
      await page.getByRole('button', { name: 'Start scan' }).click()
      const field = schemaField(scanConfig, 'step')
      await expect(field).toContainText(stepIssue.message)
      await expect(step).toHaveAttribute('aria-invalid', 'true')
      await expect(formLevel).toHaveCount(0)
      expect(requests).toHaveLength(2)

      // Other rejections are form-level alerts with the server's message.
      await step.fill('1')
      await step.blur()
      for (const [code, status, title] of [
        ['scanTooLarge', 422, 'The scan is too large'],
        ['revisionNotReady', 409, 'The revision is not ready'],
        ['brokerAlarm', 503, 'The message broker is out of resources'],
      ] as const) {
        await page.unroute('**/api/scans')
        await failWithApiError(page, '**/api/scans', { status, code, message: `${code} message from the server` })
        await page.getByRole('button', { name: 'Start scan' }).click()
        await expect(page.getByText(title, { exact: true })).toBeVisible()
        await expect(page.getByText(`${code} message from the server`)).toBeVisible()
      }
      await expect(page).toHaveURL(/\/scans\/new/)
    },
  )

  test(
    "an upload field offers the user's uploads, uploads a list and explains unknown ids",
    { tag: ['@UI-SCAN-014'] },
    async ({ page, api, user, openapi }) => {
      const zoo = await sharedTask(user, openapi, 'schema-zoo')
      const fileName = `${unique('wordlist')}.txt`
      await gotoApp(page, `/scans/new?revision=${zoo.task.name}@latest`)
      const taskConfig = formSection(page, '3 · Task config')
      const chooser = page.waitForEvent('filechooser')
      await taskConfig.getByRole('button', { name: 'Upload a list for Wordlist' }).click()
      await (await chooser).setFiles({ name: fileName, mimeType: 'text/plain', buffer: Buffer.from('alpha\nbeta\ngamma\n') })
      const select = taskConfig.getByRole('combobox', { name: 'Wordlist' })
      await expect(select).toContainText(`${fileName} · 3 lines · 17 B`)
      const uploads = ok(await api.call<{ items: { id: string; name: string }[] }>('listUploads', { query: { limit: 200 } }), 'listUploads').items
      const upload = uploads.find((entry) => entry.name === fileName)!
      try {
        expect(upload).toBeDefined()
        await expect(taskConfig.locator(`code[data-id="${upload.id}"]`)).toBeVisible()
        // The list offers the upload (and "None").
        await select.click()
        await expect(page.getByRole('option', { name: 'None' })).toBeVisible()
        await expect(page.getByRole('option', { name: `${fileName} · 3 lines · 17 B` })).toBeVisible()
        await page.keyboard.press('Escape')
        // An id that is not among the user's uploads.
        await taskConfig.getByRole('button', { name: 'Edit as JSON' }).click()
        await taskConfig.getByRole('textbox', { name: 'taskConfig as JSON' }).fill('{"wordlist": "00000000-0000-4000-8000-0000000000aa"}')
        await taskConfig.getByRole('button', { name: 'Edit as JSON' }).click()
        await expect(taskConfig.getByText('Upload 00000000 (not in your recent uploads)')).toBeVisible()
      } finally {
        if (upload) await api.call('deleteUpload', { path: { uploadId: upload.id } })
      }
    },
  )
})

test.describe('privileged revisions', () => {
  test.use({ pageUser: 'fresh' })
  // The fresh user publishes its own privileged revision (one build).
  test.describe.configure({ timeout: 180_000 })

  test(
    'a user without canRunPrivileged cannot start a privileged revision until an admin grants it',
    { tag: ['@UI-SCAN-006', '@UI-SCAN-004', '@UI-SCAN-012', '@UI-SCAN-015'] },
    async ({ page, freshUser, freshApi, adminApi }) => {
      const grant = async (canRunPrivileged: boolean) =>
        ok(await adminApi.call('updateUser', { path: { userId: freshUser.id }, body: { canRunPrivileged } }), 'updateUser')
      // The empty list of a user without scans.
      await gotoApp(page, '/scans')
      const empty = page.getByText('No scans yet', { exact: true })
      await expect(empty).toBeVisible()
      await expect(empty.locator('..').getByRole('link', { name: 'New scan' })).toHaveAttribute('href', '/scans/new')

      // Publishing a privileged revision needs the permission; the permission is then taken away. The fresh user, its
      // task and its scans are deleted at the end of the test.
      await grant(true)
      const folder = await privilegedCopy({ example: 'echo' })
      let revision: Revision
      const name = unique('privileged')
      try {
        const uploaded = ok(await freshApi.uploadTask(await packTask(folder.dir, { name }), { publish: true, wait: 120 }), 'uploadTask')
        revision = await waitForRevision(freshApi, uploaded.task.id, uploaded.revision!.id)
      } finally {
        await folder.dispose()
      }
      expect(revision.state).toBe('ready')
      expect(revision.privileged).toBe(true)
      await grant(false)

      await gotoApp(page, `/scans/new?revision=${name}@latest`)
      await expect(page.getByText('privileged', { exact: true })).toBeVisible()
      const blocked = page.getByText('Privileged revision', { exact: true })
      await expect(blocked).toBeVisible()
      await expect(page.getByRole('button', { name: 'Start scan' })).toBeDisabled()

      await grant(true)
      await reloadApp(page)
      await expect(page.getByRole('button', { name: 'Start scan' })).toBeEnabled()
      await expect(blocked).toHaveCount(0)

      // Revoked while the form is open: the server refuses and the form says why.
      await grant(false)
      await page.getByLabel('Name', { exact: true }).fill(unique('privileged-scan'))
      await page.getByRole('button', { name: 'Start scan' }).click()
      await expect(page.getByText('Privileged revisions need permission', { exact: true })).toBeVisible()

      // With the permission the scan starts; its header carries the privileged badge. It never gets a worker.
      await grant(true)
      await page.route('**/api/scans', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback()
        const sent = route.request().postDataJSON() as Record<string, unknown>
        await route.fallback({
          postData: JSON.stringify({ ...sent, settings: { ...((sent.settings as Record<string, unknown>) ?? {}), ...PENDING_SETTINGS } }),
        })
      })
      await page.getByRole('button', { name: 'Start scan' }).click()
      await page.waitForURL(/\/scans\/[0-9a-f-]{36}$/)
      await expect(page.locator('header').getByText('privileged', { exact: true })).toBeVisible()
    },
  )
})

test.describe('scan detail', () => {
  test(
    'controls follow the state, explain disabled ones and lock while an action runs; pause, resume, scale and cancel',
    { tag: ['@UI-SCAN-017', '@UI-SCAN-018', '@UI-SCAN-019', '@UI-SCAN-020', '@UI-SCAN-015', '@UI-SCAN-023'] },
    async ({ page, api, user, openapi }) => {
      test.setTimeout(180_000)
      const sleep = await sharedTask(user, openapi, 'sleep')
      const scan = await startOwnScan(user, openapi, {
        revision: sleep.revision.id,
        name: unique('controls'),
        taskConfig: { seconds: 2 },
        scanConfig: { times: 500 },
      })
      await waitForOwnScan(user, openapi, scan.id, 'running', 60_000)
      await expect.poll(async () => ok(await api.getScan(scan.id), 'getScan').workers.byState.running ?? 0, { timeout: 120_000 }).toBeGreaterThan(0)

      await openScanPage(page, scan.id)
      const header = page.locator('header').filter({ has: page.getByRole('button', { name: 'Copy scan id' }) })
      await expect(header.getByRole('heading', { level: 2 })).toHaveText(scan.name!)
      await expect(header.locator(`code[data-id="${scan.id}"]`)).toHaveText(scan.id.slice(0, 8))
      await expect(header.getByRole('link', { name: sleep.revision.ref })).toHaveAttribute('href', `/tasks/${sleep.task.id}/revisions/1`)
      await expect(header).toContainText('template repeat')
      await expect(header).toContainText(/Created (just now|\d+ min ago)/)
      await expect(header).toContainText(/Started (just now|\d+ min ago)/)
      await expect(header).not.toContainText('round')
      await expect(header).not.toContainText('Owner')
      await expect(header).not.toContainText('privileged')
      await expect(headerState(page)).toHaveText('running')

      const enabled = async () =>
        await controls(page)
          .getByRole('button')
          .evaluateAll((buttons) => buttons.filter((button) => !(button as HTMLButtonElement).disabled).map((button) => button.getAttribute('aria-label')))
      expect(await enabled()).toEqual(['Pause scan', 'Scale scan', 'Cancel scan', 'Restart scan', 'Export results'])
      await expectTooltip(page, 'Resume scan', 'Only paused scans can be resumed')
      await expectTooltip(page, 'Retry failed analyses', 'Needs finished scheduling and failed or lost analyses')
      await expectTooltip(page, 'Delete scan', 'Only completed, failed or cancelled scans can be deleted')

      // While the pause request runs, every control is disabled.
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      await page.route(`**/api/scans/${scan.id}/pause`, async (route) => {
        await held
        await route.fallback()
      })
      await control(page, 'Pause scan').click()
      await expect(controls(page).getByRole('button')).toHaveCount(8)
      for (const button of await controls(page).getByRole('button').all()) await expect(button).toBeDisabled()
      release()
      await expectToast(page, 'Scan paused')
      await expect(headerState(page)).toHaveText(/paused/)
      expect(await enabled()).toEqual(['Resume scan', 'Scale scan', 'Cancel scan', 'Restart scan', 'Export results'])
      await page.unroute(`**/api/scans/${scan.id}/pause`)

      // The workers drain away.
      await openScanTab(page, 'Workers')
      const summary = page.getByText(/^\d+ active · \d+ pending · \d+ desired$/)
      await expectAfterRefresh(page, async () => {
        await expect(summary).toHaveText('0 active · 0 pending · 0 desired', { timeout: 2000 })
      })

      // Resume: the runners come back.
      await control(page, 'Resume scan').click()
      await expectToast(page, 'Scan resumed')
      await expect(headerState(page)).toHaveText('running')
      await expectAfterRefresh(page, async () => {
        await expect(summary).toHaveText(/^[1-9]\d* active · \d+ pending · [1-9]\d* desired$/, { timeout: 2000 })
      })

      // Scale within the instance limits.
      const info = ok(await api.getInstanceInfo(), 'getInstanceInfo')
      await control(page, 'Scale scan').click()
      const scale = page.getByRole('dialog', { name: 'Scale scan' })
      await expect(scale.getByLabel('Runner workers')).toHaveValue('1')
      await expect(scale.getByText(`1–${info.limits.maxWorkersPerScan}`, { exact: true })).toBeVisible()
      await expect(scale.getByText(`1–${info.limits.maxProcessesPerWorker}`, { exact: true })).toBeVisible()
      await scale.getByLabel('Runner workers').fill('2')
      await scale.getByLabel('Runner workers').blur()
      await expect(scale).toContainText('2 concurrent analyses; per worker 0.25 CPUs, 512 MiB memory')
      await scale.getByRole('button', { name: 'Scale scan' }).click()
      await expectToast(page, /Scan scaled/)
      await expectToast(page, '2 workers × 1 processes')
      await expect(scale).toHaveCount(0)
      expect(ok(await api.getScan(scan.id), 'getScan').settings.workers).toBe(2)

      // Cancel asks first.
      await control(page, 'Cancel scan').click()
      const cancel = page.getByRole('dialog', { name: `Cancel scan ${scan.name}?` })
      await cancel.getByRole('button', { name: 'Cancel scan', exact: true }).click()
      await expectToast(page, 'Scan cancelled')
      await expect(headerState(page)).toHaveText(/cancelled/)
      expect(await enabled()).toEqual(['Restart scan', 'Export results', 'Delete scan'])
    },
  )

  test('resuming a scan whose revision was deleted says so', { tag: ['@UI-SCAN-018'] }, async ({ page, api, user, openapi }) => {
    const throws = await sharedTask(user, openapi, 'throws')
    const scan = await startOwnScan(user, openapi, { revision: throws.revision.id, name: unique('resume-gone'), settings: PENDING_SETTINGS })
    await waitForOwnScan(user, openapi, scan.id, 'running', 60_000)
    ok(await api.call('pauseScan', { path: { scanId: scan.id } }), 'pauseScan')
    await openScanPage(page, scan.id)
    await expect(headerState(page)).toHaveText(/paused/)
    // The revision disappears while the scan is paused (the shared revision itself must stay: the answer is produced).
    await failWithApiError(page, `**/api/scans/${scan.id}/resume`, {
      status: 409,
      code: 'revisionUnavailable',
      message: "the scan's revision no longer exists",
    })
    await control(page, 'Resume scan').click()
    await expectToast(page, 'Revision no longer exists')
    await expect(headerState(page)).toHaveText(/paused/)
  })

  test(
    'retry-failed confirms the count and round, follows its job and reports "Nothing to retry"',
    { tag: ['@UI-SCAN-021', '@UI-SCAN-015'] },
    async ({ page, api, user, openapi }) => {
      test.setTimeout(180_000)
      const throws = await sharedTask(user, openapi, 'throws')
      const scan = await startOwnScan(user, openapi, {
        revision: throws.revision.id,
        name: unique('retry'),
        taskConfig: { mode: 'fatal' },
        scanConfig: { start: 0, end: 3 },
      })
      const done = await waitForOwnScan(user, openapi, scan.id, 'completed', 120_000)
      expect(done.stats.failed + done.stats.lost).toBe(3)

      await openScanPage(page, scan.id)
      await expect(control(page, 'Retry failed analyses')).toBeEnabled()
      await control(page, 'Retry failed analyses').click()
      const confirm = page.getByRole('dialog', { name: 'Retry failed analyses?' })
      await expect(confirm).toContainText('Retry up to 3 failed or lost analyses in round 2.')
      // The job's first poll is held at "running" with progress, so the inline progress is seen before the job ends.
      let holdJob = true
      await page.route('**/api/jobs/*', async (route) => {
        if (!holdJob || route.request().method() !== 'GET') return route.fallback()
        const response = await route.fetch()
        const job = (await response.json()) as Record<string, unknown>
        await route.fulfill({ response, json: { ...job, state: 'running', progress: { done: 1, total: 3 } } })
      })
      const accepted = page.waitForResponse((response) => response.url().includes(`/api/scans/${scan.id}/retry-failed`))
      await confirm.getByRole('button', { name: 'Retry failed analyses' }).click()
      expect((await accepted).status()).toBe(202)
      await expectToast(page, 'Retrying failed analyses')
      await expectToast(page, 'Round 2 started.')
      const header = page.locator('header').filter({ has: page.getByRole('button', { name: 'Copy scan id' }) })
      await expect(header.getByText('round 2', { exact: true })).toBeVisible()
      const jobStatus = page.getByRole('status').filter({ has: page.getByRole('progressbar', { name: 'Retry progress' }) })
      await expect(jobStatus).toContainText('Retrying failed analyses')
      await expect(jobStatus).toContainText('1 / 3')
      await expect(jobStatus.locator('[data-state="running"]')).toBeVisible()
      holdJob = false
      await expect(jobStatus).toHaveCount(0, { timeout: 60_000 })
      await waitForOwnScan(user, openapi, scan.id, 'completed', 120_000)
      expect(ok(await api.getScan(scan.id), 'getScan').round).toBe(2)

      // A retry the server refuses (nothing left that it may retry).
      await expectAfterRefresh(page, async () => {
        await expect(control(page, 'Retry failed analyses')).toBeEnabled({ timeout: 2000 })
      })
      await failWithApiError(page, `**/api/scans/${scan.id}/retry-failed`, {
        status: 409,
        code: 'nothingToRetry',
        message: 'no failed or lost analysis has a stored config',
      })
      await control(page, 'Retry failed analyses').click()
      await page.getByRole('dialog', { name: 'Retry failed analyses?' }).getByRole('button', { name: 'Retry failed analyses' }).click()
      await expectToast(page, 'Nothing to retry')
    },
  )

  test(
    'restart clones the scan with the chosen scaling and opens the clone',
    { tag: ['@UI-SCAN-022', '@UI-SCAN-015'] },
    async ({ page, api, user, openapi }) => {
      const scan = await completedScan(user, openapi)
      await openScanPage(page, scan.id)
      await control(page, 'Restart scan').click()
      const dialog = page.getByRole('dialog', { name: 'Restart scan' })
      await expect(dialog.getByLabel('Name')).toHaveValue(`${scan.name} (restart)`)
      await expect(dialog.getByLabel('Runner workers')).toHaveValue('1')
      await expect(dialog.getByLabel('Processes per worker')).toHaveValue('1')
      await dialog.getByLabel('Processes per worker').fill('2')
      await dialog.getByLabel('Processes per worker').blur()
      const restarted = page.waitForResponse((response) => response.url().endsWith(`/api/scans/${scan.id}/restart`))
      await dialog.getByRole('button', { name: 'Restart scan' }).click()
      const clone = (await (await restarted).json()) as Scan
      trackOwnScan(user, openapi, clone.id)
      await expectToast(page, 'Scan restarted')
      await expect(page).toHaveURL(new RegExp(`/scans/${clone.id}$`))
      const header = page.locator('header').filter({ has: page.getByRole('button', { name: 'Copy scan id' }) })
      await expect(header.getByRole('heading', { level: 2 })).toHaveText(`${scan.name} (restart)`)
      await expect(header.getByText('Restarted from')).toBeVisible()
      await expect(header.getByRole('link', { name: scan.id.slice(0, 8) })).toHaveAttribute('href', `/scans/${scan.id}`)
      const stored = ok(await api.getScan(clone.id), 'getScan')
      expect(stored.clonedFrom).toBe(scan.id)
      expect(stored.settings).toMatchObject({ workers: 1, processes: 2 })
    },
  )

  test(
    'deleting a scan requires its name and opens the scans list; running scans cannot be deleted',
    { tag: ['@UI-SCAN-023'] },
    async ({ page, api, user, openapi }) => {
      const throws = await sharedTask(user, openapi, 'throws')
      const scan = await startOwnScan(user, openapi, { revision: throws.revision.id, name: unique('delete'), settings: PENDING_SETTINGS })
      await waitForOwnScan(user, openapi, scan.id, 'running', 60_000)
      await openScanPage(page, scan.id)
      await expect(control(page, 'Delete scan')).toBeDisabled()
      expect([200, 409]).toContain((await api.cancelScan(scan.id)).status)
      await expectAfterRefresh(page, async () => {
        await expect(control(page, 'Delete scan')).toBeEnabled({ timeout: 2000 })
      })

      await control(page, 'Delete scan').click()
      const dialog = page.getByRole('dialog', { name: `Delete scan ${scan.name}?` })
      const confirm = dialog.getByRole('button', { name: 'Delete scan', exact: true })
      await expect(confirm).toBeDisabled()
      await dialog.getByLabel(`Type ${scan.name} to confirm`).fill('not the name')
      await expect(confirm).toBeDisabled()
      await dialog.getByLabel(`Type ${scan.name} to confirm`).fill(scan.name!)
      await confirm.click()
      await expectToast(page, 'Scan deletion started')
      await expect(page).toHaveURL(/\/scans$/)
      await expect
        .poll(
          async () => {
            const current = await api.getScan(scan.id)
            return current.status === 404 ? 'gone' : (current.body as Scan).state
          },
          { timeout: 60_000 },
        )
        .toMatch(/deleting|deleted|gone/)
    },
  )

  test(
    'tabs sync with ?tab=, ?analysis= opens the drawer from any tab, and the page refreshes itself',
    { tag: ['@UI-SCAN-024', '@UI-SCAN-025'] },
    async ({ page, user, openapi }) => {
      test.setTimeout(180_000)
      const sleep = await sharedTask(user, openapi, 'sleep')
      const scan = await startOwnScan(user, openapi, {
        revision: sleep.revision.id,
        name: unique('tabs'),
        taskConfig: { seconds: 2 },
        scanConfig: { times: 2 },
      })
      await waitForOwnScan(user, openapi, scan.id, 'running', 60_000)

      await openScanPage(page, scan.id)
      await expect(scanTab(page, 'Overview')).toHaveAttribute('aria-selected', 'true')
      for (const [name, value] of [
        ['Results', 'results'],
        ['Query', 'query'],
        ['Workers', 'workers'],
        ['Events', 'events'],
        ['Exports', 'exports'],
      ] as const) {
        await openScanTab(page, name)
        await expect(page).toHaveURL(new RegExp(`[?&]tab=${value}(&|$)`))
      }
      await openScanTab(page, 'Overview')
      await expect(page).not.toHaveURL(/tab=/)
      await gotoApp(page, `/scans/${scan.id}?tab=events`)
      await expect(scanTab(page, 'Events')).toHaveAttribute('aria-selected', 'true')

      // The page follows the scan to completion without a reload ...
      await expect(headerState(page)).toHaveText(/completed/, { timeout: 180_000 })
      // ... and keeps polling for the final recount.
      await page.waitForRequest((request) => request.method() === 'GET' && new URL(request.url()).pathname === `/api/scans/${scan.id}`, { timeout: 30_000 })
      // "Refresh" reloads at once.
      const reload = page.waitForRequest((request) => request.method() === 'GET' && new URL(request.url()).pathname === `/api/scans/${scan.id}`, {
        timeout: 5000,
      })
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await reload

      for (const value of ['workers', 'query', 'overview']) {
        await gotoApp(page, `/scans/${scan.id}?tab=${value}&analysis=1`)
        const drawer = page.getByRole('dialog', { name: 'Analysis 1' })
        await expect(drawer).toBeVisible()
        await expect(drawer.getByTestId('analysis-slideover')).toContainText(`${scan.id}-1`)
        await page.keyboard.press('Escape')
        await expect(drawer).toHaveCount(0)
        await expect(page).not.toHaveURL(/analysis=/)
      }
    },
  )

  test(
    'progress and stats cards: totals, scheduling, tiles that filter the results, exact and live captions',
    { tag: ['@UI-SCAN-026', '@UI-SCAN-027'] },
    async ({ page, user, openapi }) => {
      const [throws, finished] = await Promise.all([sharedTask(user, openapi, 'throws'), completedScan(user, openapi)])
      // A custom schedule that never runs: no total yet.
      const pending = await startOwnScan(user, openapi, { revision: throws.revision.id, name: unique('progress-pending'), settings: PENDING_SETTINGS })

      await openScanPage(page, finished.id)
      const progress = page.getByTestId('scan-progress')
      await expect(progress).toContainText('4 / 4 analyses (100.0 %)')
      await expect(progress).toContainText('4 scheduled')
      await expect(progress.locator('[data-state="done"]')).toBeVisible()
      await expect(progress).toContainText(`${new Intl.NumberFormat('en-US').format(Math.round(finished.stats.ratePerMin))} / min`)
      await expect(progress.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
      await expect(progress).not.toContainText('≈')
      const stats = page.getByTestId('scan-stats')
      await expect(stats).toContainText(/exact as of (just now|\d+ min ago|\d+ h ago)/)
      for (const [label, count] of [
        ['pending', 0],
        ['retrying', 0],
        ['succeeded', 4],
        ['failed', 0],
        ['lost', 0],
        ['cancelled', 0],
      ] as const) {
        await expect(stats.getByRole('link', { name: `${count} ${label} analyses` })).toBeVisible()
      }
      await stats.getByRole('link', { name: '4 succeeded analyses' }).click()
      await expect(page).toHaveURL(/tab=results/)
      await expect(page).toHaveURL(/status=succeeded/)
      await expect(scanTab(page, 'Results')).toHaveAttribute('aria-selected', 'true')
      await expect(selectMenu(page, 'Filter by status')).toContainText('succeeded')

      await openScanPage(page, pending.id)
      await expect(progress).toContainText('0 analyses')
      await expect(progress.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow', /.+/)
      await expect(progress.getByRole('progressbar')).toHaveAttribute('data-state', 'indeterminate')
      await expect(progress).toContainText('0 scheduled')
      await expect(progress.locator('[data-state="pending"]')).toBeVisible()
      // Before the first recount the tiles are a live estimate (the answer is patched: recounts run every few seconds).
      await patchJsonResponses(page, `**/api/scans/${pending.id}`, (body) => ({
        ...body,
        stats: { ...(body.stats as Record<string, unknown>), recountedAt: null },
      }))
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await expect(stats).toContainText('live estimate')
    },
  )
})
