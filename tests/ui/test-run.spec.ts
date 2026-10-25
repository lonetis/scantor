import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { TestRun } from '#shared/types/test-runs'
import { expect, test, unique } from '../fixtures'
import { ok, type ApiClient } from '../helpers/api-client'
import { fixtureTaskDir, packTask } from '../helpers/tasks'
import {
  SHARED_SETUP_TIMEOUT_MS,
  badges,
  failWithApiError,
  gotoApp,
  reloadApp,
  sharedTask,
  sharedTasksOf,
  shieldFromNetworkChanges,
  uTable,
} from '../helpers/ui-scans-kit'

// The test-run panel of a task (docs/ui.md §5.8): inputs from the latest known schemas, the live run over SSE (with
// the polling fallback), cancel, the analysis slideover, the history and the per-task drafts without secrets. The
// tasks are shared per worker (helpers/ui-scans-kit.ts), so the draft image of an unchanged workspace is built once.

// Chromium aborts in-flight requests whenever the inner dockerd changes networks (helpers/ui-scans-kit.ts).
test.beforeEach(async ({ page }) => shieldFromNetworkChanges(page))
// The shared tasks of this spec are built before its first test in a worker, outside the tests' timeouts.
test.beforeAll(async ({ user, openapi }) => {
  test.setTimeout(SHARED_SETUP_TIMEOUT_MS)
  await sharedTasksOf(user, openapi, ['throws', 'sleep', 'schema-zoo', 'results-zoo'])
})

const RUN_TIMEOUT = 120_000

/** The run card: its first row holds the run's state badge. */
const runState = (page: Page) => badges(page.getByTestId('test-run-log').locator('xpath=..').locator(':scope > div').first()).first()
const startButton = (page: Page) => page.getByRole('button', { name: 'Start test run' })

async function openTestTab(page: Page, taskId: string): Promise<void> {
  await gotoApp(page, `/tasks/${taskId}?tab=test`)
  await expect(page.getByRole('form', { name: 'Test run inputs' })).toBeVisible()
}

const TERMINAL_RUN_STATES: readonly string[] = ['completed', 'failed', 'cancelled']

/**
 * Waits until a run settles (getTestRun long-polls) and expects `state`, failing with the run's errors otherwise, then
 * expects the panel's badge to show that state.
 */
async function expectRunSettled(page: Page, api: ApiClient, runId: string, state: TestRun['state'] = 'completed'): Promise<void> {
  const read = async (wait: number) => ok(await api.call<TestRun>('getTestRun', { path: { testRunId: runId }, query: { wait, analyses: false } }), 'getTestRun')
  const deadline = Date.now() + RUN_TIMEOUT
  let run = await read(0)
  while (!TERMINAL_RUN_STATES.includes(run.state) && Date.now() < deadline) run = await read(30)
  expect(run.state, `test run ${runId} ended ${run.state} with errors ${JSON.stringify(run.errors)}`).toBe(state)
  await expect(runState(page)).toHaveText(state, { timeout: 30_000 })
}

/** Starts a run from the panel and returns its id. */
async function startRun(page: Page): Promise<string> {
  const created = page.waitForResponse(
    (response) => response.request().method() === 'POST' && /\/api\/tasks\/[^/]+\/test-runs$/.test(new URL(response.url()).pathname),
  )
  await startButton(page).click()
  const response = await created
  expect(response.status()).toBe(201)
  return ((await response.json()) as { id: string }).id
}

/**
 * Serves the test-run event streams through Playwright (`route.fetch`, Node's HTTP stack, buffered until the stream
 * ends) instead of Chromium's network stack: Chromium aborts a long-lived stream with net::ERR_NETWORK_CHANGED whenever
 * the inner dockerd changes networks, which every concurrent run's containers do, and the panel then polls without log
 * lines. The panel still reads the events through its EventSource, in order, once the run settled.
 */
async function bufferTestRunStreams(page: Page): Promise<void> {
  await page.route('**/api/test-runs/*/stream', async (route) => {
    let response
    try {
      response = await route.fetch({ timeout: RUN_TIMEOUT })
    } catch (error) {
      if (page.isClosed()) return
      await route.abort('failed')
      throw error
    }
    await route.fulfill({ response })
  })
}

/** Records the states the run badge shows, in order, in `window.__runStates`. */
async function recordRunStates(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as { __runStates: string[] }
    target.__runStates = []
    new MutationObserver(() => {
      const card = document.querySelector('[data-testid="test-run-log"]')?.parentElement
      const value = card?.querySelector(':scope > div span[data-slot="base"][data-state]')?.getAttribute('data-state')
      if (value && target.__runStates.at(-1) !== value) target.__runStates.push(value)
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] })
  })
}

async function selectInForm(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

test.describe('test runs', () => {
  test('the test tab offers both modes with their inputs, bounds and the manifest timeout', { tag: ['@UI-TRUN-001'] }, async ({ page, user, openapi }) => {
    const throws = await sharedTask(user, openapi, 'throws')
    await openTestTab(page, throws.task.id)
    await expect(page.getByRole('radio', { name: 'Schedule + run' })).toBeChecked()
    await expect(page.getByText('Task config', { exact: true })).toBeVisible()
    await expect(page.getByText('Scan config', { exact: true })).toBeVisible()
    const limit = page.getByLabel('Limit', { exact: true })
    await expect(limit).toHaveValue('5')
    await expect(page.getByText('1–50', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Max attempts')).toHaveValue('1')
    await expect(page.getByText('1–5', { exact: true })).toBeVisible()
    // The manifest says `timeout: 30s`.
    await expect(page.getByText('default 30', { exact: true })).toBeVisible()
    // The task config form follows the revision's schema; the scan config is the range template's.
    await expect(page.getByRole('combobox', { name: 'Mode', exact: true })).toBeVisible()
    await expect(page.locator('[data-field-path="end"]')).toBeVisible()
    // Bounds.
    await limit.fill('99')
    await limit.blur()
    await expect(limit).toHaveValue('50')
    await page.getByLabel('Max attempts').fill('9')
    await page.getByLabel('Max attempts').blur()
    await expect(page.getByLabel('Max attempts')).toHaveValue('5')

    await page.getByRole('radio', { name: 'One analysis' }).check()
    await expect(page.getByText('Analysis config', { exact: true })).toBeVisible()
    await expect(page.getByText('Scan config', { exact: true })).toHaveCount(0)
    await expect(page.getByLabel('Limit', { exact: true })).toHaveCount(0)
    await expect(page.locator('[data-field-path="value"]')).toBeVisible()
  })

  test(
    'a live run streams its state, logs and analyses; the history loads earlier runs; the draft image is cached',
    { tag: ['@UI-TRUN-004', '@UI-TRUN-008'] },
    async ({ page, api, user, openapi }) => {
      test.setTimeout(180_000)
      // results-zoo logs from every analysis: value 0 succeeds in attempt 3, value 1 fails fatally, value 2 succeeds.
      const zoo = await sharedTask(user, openapi, 'results-zoo')
      await openTestTab(page, zoo.task.id)
      await page.getByLabel('Limit', { exact: true }).fill('3')
      await page.getByLabel('Limit', { exact: true }).blur()
      await page.getByLabel('Max attempts').fill('3')
      await page.getByLabel('Max attempts').blur()
      await bufferTestRunStreams(page)
      await recordRunStates(page)
      const stream = page.waitForRequest((request) => /\/api\/test-runs\/[^/]+\/stream$/.test(new URL(request.url()).pathname))
      const first = await startRun(page)
      await stream
      await expectRunSettled(page, api, first)
      // The badge followed the stream's state events forward and ended completed.
      const states = await page.evaluate(() => (window as unknown as { __runStates: string[] }).__runStates)
      const ORDER = ['queued', 'building', 'running', 'completed']
      expect(
        states.every((value) => ORDER.includes(value)),
        states.join(' → '),
      ).toBe(true)
      const positions = states.map((value) => ORDER.indexOf(value))
      expect(positions, states.join(' → ')).toEqual([...new Set(positions)].sort((a, b) => a - b))
      expect(states).toContain('running')
      expect(states.at(-1)).toBe('completed')
      await expect(page.getByText('3 analyses · 2 succeeded · 1 failed')).toBeVisible()
      const log = page.getByTestId('test-run-log')
      await expect(log.getByText('Build', { exact: true })).toBeVisible()
      await expect(log.getByText('Run', { exact: true })).toBeVisible()
      // An earlier test of this worker may have built the draft image of the shared task already.
      const firstRun = ok(await api.call<{ draftImage?: { cached: boolean } | null }>('getTestRun', { path: { testRunId: first } }), 'getTestRun')
      if (firstRun.draftImage?.cached === false) await expect(log).not.toContainText('No build output yet.')
      // Run lines carry the seq of their analysis; ANSI sequences are stripped.
      await expect(log).toContainText(/\[\d+\] .*analysis 2 starts/)
      await expect(log).toContainText('stdout line 2')
      expect(await log.textContent()).not.toContain('\u001b')
      const analyses = uTable(page, 'Test run analyses')
      const rows = analyses.locator('tbody tr[data-row-id]')
      await expect(rows).toHaveCount(3)
      await expect(badges(rows)).toHaveText(['succeeded', 'failed', 'succeeded'])
      await expect(rows.nth(0)).toContainText('"label":"label-0"')
      // The outcome of a failure: type and message (ANSI in messages: see the hostile-output tests of scan-results).
      await expect(rows.nth(1)).toContainText('fatal: ')
      await expect(rows.nth(1)).toContainText('failure of value 1')

      // The same workspace again: the draft image is reused.
      await page.getByLabel('Limit', { exact: true }).fill('1')
      await page.getByLabel('Limit', { exact: true }).blur()
      await page.getByLabel('Max attempts').fill('1')
      await page.getByLabel('Max attempts').blur()
      const second = await startRun(page)
      await expect(page.getByText('draft image cached')).toBeVisible({ timeout: RUN_TIMEOUT })
      expect(
        ok(await api.call<{ draftImage?: { cached: boolean } | null }>('getTestRun', { path: { testRunId: second } }), 'getTestRun').draftImage?.cached,
      ).toBe(true)
      await expectRunSettled(page, api, second)
      await expect(page.getByText('1 analysis · 0 succeeded · 1 failed')).toBeVisible()

      // History: newest first, state, x / y succeeded and the pack hash; a row loads that run.
      const history = uTable(page, 'Test run history')
      await expect(history.locator(`tr[data-row-id="${second}"]`)).toBeVisible()
      const older = history.locator(`tr[data-row-id="${first}"]`)
      await expect(badges(older)).toHaveText('completed')
      await expect(older).toContainText('2 / 3 succeeded')
      await expect(older.getByRole('button', { name: `Copy pack hash of test run ${first}` })).toBeVisible()
      await expect(history.locator(`tr[data-row-id="${second}"]`)).toContainText('0 / 1 succeeded')
      const order = await history.locator('tbody tr[data-row-id]').evaluateAll((items) => items.map((item) => item.getAttribute('data-row-id')))
      expect(order.indexOf(second)).toBeLessThan(order.indexOf(first))
      await older.getByRole('cell').first().click()
      await expect(page.getByText('3 analyses · 2 succeeded · 1 failed')).toBeVisible()
      await expect(rows).toHaveCount(3)
    },
  )

  test(
    'start is disabled while a run is active, cancel cancels it, and start errors are shown',
    { tag: ['@UI-TRUN-003', '@UI-TRUN-006'] },
    async ({ page, user, openapi }) => {
      test.setTimeout(180_000)
      const sleep = await sharedTask(user, openapi, 'sleep')
      await openTestTab(page, sleep.task.id)
      await page.locator('[data-field-path="seconds"]').getByRole('spinbutton').fill('300')
      const runId = await startRun(page)
      await expect(startButton(page)).toBeDisabled()
      await expect(runState(page)).toHaveText('running', { timeout: RUN_TIMEOUT })
      await expect(startButton(page)).toBeDisabled()
      await page.getByRole('button', { name: 'Cancel test run' }).click()
      await expect(runState(page)).toHaveText('cancelled', { timeout: 60_000 })
      await expect(page.getByRole('button', { name: 'Cancel test run' })).toHaveCount(0)
      await expect(startButton(page)).toBeEnabled()
      const history = uTable(page, 'Test run history')
      await expect(badges(history.locator(`tr[data-row-id="${runId}"]`))).toHaveText('cancelled', { timeout: 30_000 })

      // The form keeps limits within bounds, so the server's validation error is produced by an answer of the API.
      await failWithApiError(page, /\/api\/tasks\/[^/]+\/test-runs$/, {
        status: 400,
        code: 'validationFailed',
        message: 'limit: must be at most 50',
        details: { issues: [{ path: 'limit', message: 'must be at most 50' }] },
      })
      await startButton(page).click()
      await expect(page.getByText('The test run could not start')).toBeVisible()
      await expect(page.getByText('limit: must be at most 50')).toBeVisible()
    },
  )

  test('when the event stream fails, the panel polls the run and still shows its results', { tag: ['@UI-TRUN-005'] }, async ({ page, api, user, openapi }) => {
    test.setTimeout(120_000)
    const throws = await sharedTask(user, openapi, 'throws')
    await page.route('**/api/test-runs/*/stream', (route) => route.abort())
    await openTestTab(page, throws.task.id)
    await selectInForm(page, 'Mode', 'ok')
    await page.getByLabel('Limit', { exact: true }).fill('1')
    await page.getByLabel('Limit', { exact: true }).blur()
    const polls: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'GET' && /\/api\/test-runs\/[0-9a-f-]+\?/.test(request.url())) polls.push(request.url())
    })
    const runId = await startRun(page)
    await expectRunSettled(page, api, runId)
    expect(polls.filter((url) => url.includes(runId)).length).toBeGreaterThan(1)
    await expect(page.getByText('1 analysis · 1 succeeded · 0 failed')).toBeVisible()
    await expect(uTable(page, 'Test run analyses').locator('tbody tr[data-row-id]')).toHaveCount(1)
  })

  test(
    'an analysis opens its slideover with error, stack, config, result, earlier attempts, log tail and file downloads',
    { tag: ['@UI-TRUN-007'] },
    async ({ page, api, user, openapi }) => {
      test.setTimeout(180_000)
      const [throws, zoo] = await Promise.all([sharedTask(user, openapi, 'throws'), sharedTask(user, openapi, 'schema-zoo')])
      await openTestTab(page, throws.task.id)
      // The required number is typed first: leaving it shifts the form for a moment (see schema-form.spec.ts), which
      // would swallow a click on "Start test run" made while it still has the focus.
      await page.getByRole('radio', { name: 'One analysis' }).check()
      await page.locator('[data-field-path="value"]').getByRole('spinbutton').fill('7')
      await selectInForm(page, 'Mode', 'error')
      await page.getByLabel('Max attempts').fill('2')
      await page.getByLabel('Max attempts').blur()
      await expectRunSettled(page, api, await startRun(page))
      await expect(page.getByText('1 analysis · 0 succeeded · 1 failed')).toBeVisible()
      const analyses = uTable(page, 'Test run analyses')
      const seq = (await analyses.locator('tbody tr[data-row-id]').first().getAttribute('data-row-id'))!
      await analyses.locator('tbody tr[data-row-id]').first().getByRole('cell').first().click()
      const slideover = page.getByRole('dialog', { name: `Analysis ${seq}` })
      const body = slideover.getByTestId('analysis-slideover')
      await expect(badges(body).first()).toHaveText('failed')
      await expect(body).toContainText('attempt 2')
      await expect(body).toContainText(/\d+(\.\d)?\s?(ms|s)/)
      await expect(body).toContainText('taskError: RuntimeError: demo exception in run')
      const stack = body.getByRole('region', { name: 'Stack' })
      await expect(stack).toBeVisible()
      await expect(stack).toContainText('Traceback (most recent call last)')
      await expect(stack).toContainText('RuntimeError: demo exception in run')
      await expect(body.getByText('Analysis config')).toBeVisible()
      await expect(body).toContainText('"value"')
      await expect(body.getByText('Earlier attempts')).toBeVisible()
      await expect(body).toContainText('#1')
      await expect(body.getByText('Log tail')).toBeVisible()
      await page.keyboard.press('Escape')

      // Files and the result of a succeeding analysis.
      await openTestTab(page, zoo.task.id)
      await expectRunSettled(page, api, await startRun(page))
      await uTable(page, 'Test run analyses').locator('tbody tr[data-row-id]').first().getByRole('cell').first().click()
      const zooSlideover = page.getByRole('dialog', { name: /^Analysis \d+$/ })
      await expect(zooSlideover.getByText('Result', { exact: true })).toBeVisible()
      await expect(zooSlideover).toContainText('"api_token_sha256"')
      // The button fetches a presigned link and opens it in a new tab. The forced attachment turns that navigation into
      // a download, so the tab may close or stay blank: the S3 request of the context is what shows the link was followed.
      const link = page.waitForResponse((response) => /\/api\/test-runs\/[^/]+\/files\/[^/]+$/.test(new URL(response.url()).pathname))
      const followed = page.context().waitForEvent('request', (request) => request.url().startsWith('https://s3.scantor.localhost/'))
      await zooSlideover.getByRole('button', { name: 'Download report.txt' }).click()
      const linkResponse = await link
      expect(linkResponse.status()).toBe(200)
      const presigned = ((await linkResponse.json()) as { url: string }).url
      expect(new URL(presigned).origin).toBe('https://s3.scantor.localhost')
      expect((await followed).url()).toBe(presigned)
      for (const other of page.context().pages()) if (other !== page) await other.close()
    },
  )

  test(
    'without known schemas the inputs start as JSON; after runs the form follows the workspace and announces changed schemas',
    { tag: ['@UI-TRUN-002', '@UI-FORM-011'] },
    async ({ page, api, tasks }) => {
      // Two draft builds of a workspace of its own.
      test.setTimeout(180_000)
      const name = unique('schemas')
      const uploaded = ok(await api.uploadTask(await packTask(fixtureTaskDir('schema-zoo'), { name }), { publish: false }), 'uploadTask')
      tasks.track(name)
      await openTestTab(page, uploaded.task.id)
      await expect(page.getByText('No schemas known yet', { exact: true })).toBeVisible()
      const taskJson = page.getByRole('textbox', { name: 'taskConfig as JSON' })
      await expect(taskJson).toHaveValue('{}')
      await expect(page.getByText('This schema can only be edited as JSON.').first()).toBeVisible()
      await expect(page.getByRole('button', { name: 'Edit as JSON' }).first()).toBeDisabled()

      await expectRunSettled(page, api, await startRun(page))
      await expect(page.getByText('No schemas known yet', { exact: true })).toHaveCount(0)
      await expect(page.locator('[data-field-path="text"]')).toBeVisible()
      await expect(page.locator('[data-field-path="added_field"]')).toHaveCount(0)

      // The workspace changes its schema; the next run's description replaces the form.
      const main = await readFile(join(fixtureTaskDir('schema-zoo'), 'main.py'), 'utf8')
      const changed = main.replace(
        'class TaskConfig(scantor.Config):\n',
        'class TaskConfig(scantor.Config):\n    added_field: int = Field(default=7, description="Added after the first run.")\n',
      )
      expect(changed).not.toBe(main)
      ok(await api.call('writeTaskFiles', { path: { task: name }, body: { files: { 'main.py': changed } } }), 'writeTaskFiles')
      await expectRunSettled(page, api, await startRun(page))
      await expect(page.getByText('Schemas changed in your workspace; the form now uses the new schemas')).toBeVisible()
      await expect(page.locator('[data-field-path="added_field"]')).toBeVisible()
    },
  )

  test('unsent inputs are restored per task after a reload, without secrets', { tag: ['@UI-TRUN-009'] }, async ({ page, user, openapi }) => {
    const [zoo, throws] = await Promise.all([sharedTask(user, openapi, 'schema-zoo'), sharedTask(user, openapi, 'throws')])
    const secret = `draft-secret-${unique('value')}`
    await openTestTab(page, zoo.task.id)
    await page.locator('[data-field-path="text"]').getByRole('textbox').fill('draft text')
    await page.locator('[data-field-path="api_token"]').locator('input[type="password"]').fill(secret)
    await page.getByLabel('Limit', { exact: true }).fill('3')
    await page.getByLabel('Limit', { exact: true }).blur()
    await page.getByLabel('Max attempts').fill('2')
    await page.getByLabel('Max attempts').blur()
    // Writes are debounced; a reload flushes them.
    await reloadApp(page)
    await expect(page.locator('[data-field-path="text"]').getByRole('textbox')).toHaveValue('draft text')
    await expect(page.locator('[data-field-path="api_token"]').locator('input[type="password"]')).toHaveValue('')
    await expect(page.getByLabel('Limit', { exact: true })).toHaveValue('3')
    await expect(page.getByLabel('Max attempts')).toHaveValue('2')
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }))
    expect(stored).toContain('draft text')
    expect(stored).not.toContain(secret)
    // Drafts are per task.
    await openTestTab(page, throws.task.id)
    await expect(page.getByLabel('Limit', { exact: true })).toHaveValue('5')
  })

  test(
    'config values typed while no schemas are known are not stored, also not after the run describes the schemas',
    { tag: ['@UI-TRUN-009'] },
    async ({ page, api, tasks }) => {
      // A draft build of a workspace of its own: no revision and no described test run yet.
      test.setTimeout(180_000)
      const name = unique('drafts')
      const uploaded = ok(await api.uploadTask(await packTask(fixtureTaskDir('schema-zoo'), { name }), { publish: false }), 'uploadTask')
      tasks.track(name)
      const secret = `draft-secret-${unique('value')}`
      const stored = () => page.evaluate(() => localStorage.getItem('scantor-ui') ?? '')
      await openTestTab(page, uploaded.task.id)
      await expect(page.getByText('No schemas known yet', { exact: true })).toBeVisible()
      const taskJson = page.getByRole('textbox', { name: 'taskConfig as JSON' })
      await taskJson.fill(JSON.stringify({ text: 'draft text', api_token: secret }))
      await taskJson.blur()
      await page.getByLabel('Limit', { exact: true }).fill('3')
      await page.getByLabel('Limit', { exact: true }).blur()
      // Writes are debounced: once the limit is stored, the config must be missing.
      await expect.poll(stored).toContain('"limit":3')
      expect(await stored()).not.toContain('draft text')
      expect(await stored()).not.toContain(secret)

      // The run's description makes the schemas known: the draft is stored again, with the declared values only.
      await expectRunSettled(page, api, await startRun(page))
      await expect(page.locator('[data-field-path="text"]').getByRole('textbox')).toHaveValue('draft text')
      await expect.poll(stored).toContain('draft text')
      expect(await stored()).not.toContain(secret)
    },
  )
})
