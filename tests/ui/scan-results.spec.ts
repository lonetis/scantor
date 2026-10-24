import type { Locator, Page, Request } from '@playwright/test'
import type { Analysis } from '#shared/types/analyses'
import type { Scan } from '#shared/types/scans'
import { expect, test, unique } from '../fixtures'
import { ok, type ApiClient } from '../helpers/api-client'
import type { OpenApiIndex } from '../helpers/openapi'
import {
  SHARED_SETUP_TIMEOUT_MS,
  badges,
  deleteOwnScans,
  expectAfterRefresh,
  failWithApiError,
  gotoApp,
  openScanPage,
  openScanTab,
  patchJsonResponses,
  recordDialogs,
  reloadApp,
  row,
  sharedScan,
  sharedTask,
  sharedTasksOf,
  shieldFromNetworkChanges,
  startOwnScan,
  tenantApi,
  uTable,
  expectToast,
  openToasts,
} from '../helpers/ui-scans-kit'

// The results area of a scan page (docs/ui.md §5.13.2–§5.13.6): results table and filters, the analysis drawer,
// the query console, workers and in-flight analyses, events and exports, and the inert rendering of hostile task
// output (docs/security.md HDR-5). Read-only tests share one finished scan of the results-zoo task per worker
// (helpers/ui-scans-kit.ts); tests that need a running scan start their own.

// Chromium aborts in-flight requests whenever the inner dockerd changes networks (helpers/ui-scans-kit.ts).
test.beforeEach(async ({ page }) => shieldFromNetworkChanges(page))
// The shared tasks and the shared finished scans of this spec are prepared before its first test in a worker, outside
// the tests' timeouts.
test.beforeAll(async ({ user, openapi }) => {
  test.setTimeout(SHARED_SETUP_TIMEOUT_MS)
  await sharedTasksOf(user, openapi, ['results-zoo', 'sleep', 'throws', 'hostile-output'])
  await Promise.all([resultsScan(user, openapi), hostileScans(user, openapi)])
})
test.afterEach(deleteOwnScans)

/**
 * The results-zoo scan (helpers/ui-scans-kit.ts resultsTask): config value 0 fails twice and succeeds in attempt 3,
 * 1, 4 and 7 fail fatally, 5 crashes in every attempt, 2, 3 and 6 succeed (3 also stores chart.png).
 */
const ANALYSES = 8
const SUCCEEDED = [0, 2, 3, 6]

interface ResultsScan {
  scan: Scan
  /** seq of each analysis by its config value */
  seq: (value: number) => number
}

async function resultsScan(owner: { id: string; apiKey: string }, openapi: OpenApiIndex): Promise<ResultsScan> {
  const scan = await sharedScan(owner, openapi, 'results-zoo', async () => ({
    revision: (await sharedTask(owner, openapi, 'results-zoo')).revision.id,
    name: unique('results'),
    scanConfig: { count: ANALYSES },
    settings: { workers: 1, processes: 2, resources: { cpus: 0.25, memoryMiB: 256 } },
  }))
  const api = await tenantApi(owner, openapi)
  const items = ok(await api.queryAnalyses(scan.id, { filter: {}, projection: { seq: 1, 'config.value': 1 }, limit: 100 }), 'queryAnalyses').items as {
    seq: number
    config: { value: number }
  }[]
  const seqs = new Map(items.map((item) => [item.config.value, item.seq]))
  expect(seqs.size).toBe(ANALYSES)
  return { scan, seq: (value) => seqs.get(value)! }
}

const resultsTable = (page: Page) => uTable(page, 'Analyses')
const drawer = (page: Page, seq: number | string) => page.getByRole('dialog', { name: `Analysis ${seq}` })
const queryEditor = (page: Page, label: string) => page.getByRole('textbox', { name: label, exact: true })
/** USelectMenu triggers are buttons named by their aria-label (USelect triggers are comboboxes). */
const selectMenu = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
const queryOutput = (page: Page) => page.locator('#query-output')

/** The seq of the first visible results row. */
async function firstSeq(page: Page): Promise<string> {
  return (await resultsTable(page).locator('tbody tr[data-row-id]').first().getAttribute('data-row-id')) ?? ''
}

async function getAnalysis(api: ApiClient, analysisId: string): Promise<Analysis> {
  return ok(await api.call<Analysis>('getAnalysis', { path: { analysisId } }), 'getAnalysis')
}

test.describe('results of a finished scan', () => {
  test('the status filter syncs with ?status= and "Go to seq" starts the table at a seq', { tag: ['@UI-RES-001'] }, async ({ page, user, openapi }) => {
    const { scan, seq } = await resultsScan(user, openapi)
    await openScanPage(page, scan.id, '?tab=results')
    await expect(resultsTable(page).locator(`tr[data-row-id="${seq(0)}"]`)).toBeVisible()
    const status = selectMenu(page, 'Filter by status')
    await status.click()
    await page.getByRole('option', { name: 'failed', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(page).toHaveURL(/status=failed/)
    await expect(resultsTable(page).locator(`tr[data-row-id="${seq(1)}"]`)).toBeVisible()
    await expect(resultsTable(page).locator(`tr[data-row-id="${seq(0)}"]`)).toHaveCount(0)
    await expect(badges(resultsTable(page).locator('tbody'))).toHaveText(Array(ANALYSES - SUCCEEDED.length).fill('failed'))

    await gotoApp(page, `/scans/${scan.id}?tab=results&status=succeeded`)
    await expect(status).toContainText('succeeded')
    await expect(resultsTable(page).locator(`tr[data-row-id="${seq(0)}"]`)).toBeVisible()
    await expect(resultsTable(page).locator(`tr[data-row-id="${seq(1)}"]`)).toHaveCount(0)
    await status.click()
    await page.getByRole('option', { name: 'succeeded', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(page).not.toHaveURL(/status=/)

    const input = page.getByRole('textbox', { name: 'Seq to go to' })
    const go = page.getByRole('button', { name: 'Go to seq' })
    await input.fill('2x')
    await expect(go).toBeDisabled()
    await input.fill('-3')
    await expect(go).toBeDisabled()
    await input.fill(String(seq(6)))
    await go.click()
    await expect(page.getByText(`Starting at seq ${seq(6)}`)).toBeVisible()
    await expect.poll(() => firstSeq(page)).toBe(String(seq(6)))
    await page.getByRole('button', { name: 'Show from the start' }).click()
    await expect.poll(() => firstSeq(page)).toBe(String(Math.min(...Array.from({ length: ANALYSES }, (_, value) => seq(value)))))
  })

  test(
    'the advanced filter switches to the query API and shows rejected filters with their path',
    { tag: ['@UI-RES-002'] },
    async ({ page, user, openapi }) => {
      const { scan, seq } = await resultsScan(user, openapi)
      await openScanPage(page, scan.id, '?tab=results')
      await page.getByRole('button', { name: 'Advanced filter' }).click()
      const editor = page.getByRole('textbox', { name: 'Advanced filter', exact: true })
      await expect(editor).toHaveValue('{"status": "failed"}')
      const apply = page.getByRole('button', { name: 'Apply filter' })
      await editor.fill('{"result.value": ')
      await expect(apply).toBeDisabled()
      await editor.fill('{"result.value": {"$gte": 3}}')
      const query = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith(`/api/scans/${scan.id}/analyses/query`))
      await apply.click()
      expect((await query).postDataJSON()).toMatchObject({ filter: { 'result.value': { $gte: 3 } } })
      await expect(selectMenu(page, 'Filter by status')).toBeDisabled()
      // Only succeeded analyses have a result: values 3 and 6.
      await expect(resultsTable(page).locator('tbody tr[data-row-id]')).toHaveCount(2)
      for (const value of [3, 6]) await expect(resultsTable(page).locator(`tr[data-row-id="${seq(value)}"]`)).toBeVisible()

      await editor.fill('{"$where": "1"}')
      await apply.click()
      await expect(page.getByText(/\(at filter\.\$where\)/)).toBeVisible()
      await page.getByRole('button', { name: 'Hide advanced filter' }).click()
      await expect(selectMenu(page, 'Filter by status')).toBeEnabled()
    },
  )

  test(
    'result columns default to four, are remembered per task, and cells render as text or file chips',
    { tag: ['@UI-RES-003', '@UI-RES-004', '@UI-RES-006'] },
    async ({ page, user, openapi }) => {
      const { scan, seq } = await resultsScan(user, openapi)
      await openScanPage(page, scan.id, '?tab=results')
      const table = resultsTable(page)
      await expect(table.locator(`tr[data-row-id="${seq(2)}"]`)).toBeVisible()
      // A finished scan offers no auto-refresh.
      await expect(page.getByRole('switch', { name: 'Auto-refresh' })).toHaveCount(0)
      await expect(table.getByRole('columnheader')).toHaveText(['Seq', 'Status', 'Attempt', 'Duration', 'Error', 'value', 'label', 'long', 'url', 'Finished'])
      const succeeded = table.locator(`tr[data-row-id="${seq(2)}"]`)
      await expect(succeeded.getByRole('cell').nth(0)).toHaveText(String(seq(2)))
      await expect(badges(succeeded)).toHaveText('succeeded')
      await expect(succeeded.getByRole('cell').nth(2)).toHaveText('1')
      await expect(succeeded.getByRole('cell').nth(3)).toHaveText(/\d/)
      await expect(succeeded.getByRole('cell').nth(4)).toHaveText('–')
      await expect(succeeded.getByRole('cell').nth(5)).toHaveText('2')
      await expect(succeeded.getByRole('cell').nth(6)).toHaveText('label-2')
      // Long values are cut at 200 characters; URL-like strings stay text.
      await expect(succeeded.getByRole('cell').nth(7)).toHaveText(`${'x'.repeat(200)}…`)
      await expect(succeeded.getByRole('cell').nth(8)).toHaveText('https://example.org/2')
      await expect(succeeded.getByRole('cell').nth(9)).toHaveText(/just now|min ago|h ago/)
      await expect(table.locator('tbody a')).toHaveCount(0)
      // The error column: type and message (the ANSI sequences of the message are checked by the hostile-output tests).
      const failed = table.locator(`tr[data-row-id="${seq(1)}"]`)
      await expect(failed.getByRole('cell').nth(4)).toContainText('fatal')
      await expect(failed.getByRole('cell').nth(4)).toContainText('failure of value 1')
      // The flaky analysis needed three attempts.
      await expect(
        table
          .locator(`tr[data-row-id="${seq(0)}"]`)
          .getByRole('cell')
          .nth(2),
      ).toHaveText('3')
      // No retry rounds in this scan.
      await expect(table.getByRole('columnheader', { name: 'Round' })).toHaveCount(0)

      // At most four columns; the choice is kept per task.
      const picker = selectMenu(page, 'Result columns')
      await picker.click()
      await page.getByRole('option', { name: 'url', exact: true }).click()
      await page.getByRole('option', { name: 'report', exact: true }).click()
      await page.getByRole('option', { name: 'extra', exact: true }).click()
      await page.keyboard.press('Escape')
      await expect(table.getByRole('columnheader')).toHaveText([
        'Seq',
        'Status',
        'Attempt',
        'Duration',
        'Error',
        'value',
        'label',
        'long',
        'report',
        'Finished',
      ])
      const chip = succeeded.locator('[data-file-id]')
      await expect(chip).toContainText('report-2.txt')
      await expect(chip.getByRole('button', { name: 'Download report-2.txt' })).toBeVisible()
      await reloadApp(page)
      await expect(table.getByRole('columnheader')).toHaveText([
        'Seq',
        'Status',
        'Attempt',
        'Duration',
        'Error',
        'value',
        'label',
        'long',
        'report',
        'Finished',
      ])

      // A row opens the analysis drawer.
      await table
        .locator(`tr[data-row-id="${seq(2)}"]`)
        .getByRole('cell')
        .first()
        .click()
      await expect(page).toHaveURL(new RegExp(`analysis=${seq(2)}`))
      await expect(drawer(page, seq(2))).toBeVisible()
    },
  )

  test('results load page by page with "Load more" and stop at 5,000 rows', { tag: ['@UI-RES-005'] }, async ({ page, user, openapi }) => {
    const { scan, seq } = await resultsScan(user, openapi)
    // Pages of 3 instead of 50 from the real API, so the eight analyses need "Load more". The page's own requests are
    // recorded before the rewrite.
    const requested: URLSearchParams[] = []
    await page.route(`**/api/scans/${scan.id}/analyses?*`, async (route) => {
      const url = new URL(route.request().url())
      requested.push(new URLSearchParams(url.searchParams))
      if (url.searchParams.get('limit') === '50') url.searchParams.set('limit', '3')
      await route.fallback({ url: url.toString() })
    })
    await openScanPage(page, scan.id, '?tab=results')
    const rows = resultsTable(page).locator('tbody tr[data-row-id]')
    const more = page.getByRole('button', { name: 'Load more' })
    // Three rows do not fill the table, so its infinite scroll asks for the next pages at once; "Load more" does
    // whatever is left.
    await expect(async () => {
      if (await more.isVisible()) await more.click({ timeout: 1000 })
      await expect(rows).toHaveCount(ANALYSES, { timeout: 1000 })
    }).toPass({ timeout: 20_000 })
    await expect(more).toHaveCount(0)
    // Pages of 50, each after the last seq loaded before (the scan page's polls after the end re-read the loaded range
    // with the same cursors).
    expect([...new Set(requested.map((params) => params.get('limit')))]).toEqual(['50'])
    expect([...new Set(requested.map((params) => params.get('afterSeq')))]).toEqual([null, String(seq(2)), String(seq(5))])

    // The cap needs more than 5,000 rows: the pages are synthesized in the browser for this scan (1,000 rows each, so
    // a few "Load more" clicks reach it).
    await page.unroute(`**/api/scans/${scan.id}/analyses?*`)
    await page.route(`**/api/scans/${scan.id}/analyses?*`, async (route) => {
      const params = new URL(route.request().url()).searchParams
      const after = Number(params.get('afterSeq') ?? 0)
      const items = Array.from({ length: 1000 }, (_, index) => {
        const seqNumber = after + index + 1
        return { id: `${scan.id}-${seqNumber}`, seq: seqNumber, status: 'succeeded', attempt: 1, round: 1, result: { value: seqNumber } }
      })
      await route.fulfill({ json: { items, nextCursor: String(after + 1000) } })
    })
    await reloadApp(page)
    const limit = page.getByText('Showing the first 5,000 rows. Use the query console or an export for more.')
    await expect(async () => {
      if (await limit.isVisible()) return
      await more.click({ timeout: 1000 })
      await expect(limit).toBeVisible({ timeout: 100 })
    }).toPass({ timeout: 30_000, intervals: [0] })
    await expect(more).toHaveCount(0)
  })

  test(
    '?analysis= opens the drawer with the summary; closing removes it; copy and "Query similar"',
    { tag: ['@UI-RES-007', '@UI-RES-008'] },
    async ({ page, user, openapi }) => {
      const { scan, seq } = await resultsScan(user, openapi)
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
      const failedSeq = seq(4)
      const analysis = await getAnalysis(await tenantApi(user, openapi), `${scan.id}-${failedSeq}`)
      await openScanPage(page, scan.id, `?tab=results&analysis=${failedSeq}`)
      const panel = drawer(page, failedSeq)
      await expect(panel).toBeVisible()
      await expect(panel.locator(`code[data-id="${analysis.id}"]`)).toHaveText(analysis.id)
      await expect(badges(panel).first()).toHaveText('failed')
      // The summary's attempt badge (the error section repeats the attempt).
      await expect(panel.locator('#analysis-header + div').getByText('attempt 1', { exact: true })).toBeVisible()
      const summary = panel.locator('dl').first()
      await expect(summary.locator(`code[data-id="${analysis.workerId}"]`)).toBeVisible()
      // Users see the node id; only admins get a link to the node.
      await expect(summary.locator(`code[data-id="${analysis.nodeId}"]`)).toHaveText(analysis.nodeId!.slice(0, 8))
      await expect(summary.getByRole('link')).toHaveCount(0)
      for (const label of ['Scheduled', 'Started', 'Finished']) {
        await expect(summary.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]')).toHaveText(/just now|min ago|h ago/)
      }
      await expect(summary.locator('dt', { hasText: 'Duration' }).locator('xpath=following-sibling::dd[1]')).toHaveText(/\d/)

      await panel.getByRole('button', { name: 'Copy as JSON' }).click()
      await expectToast(page, 'Copied')
      const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText())) as Analysis
      expect(copied.id).toBe(analysis.id)
      expect(copied.seq).toBe(failedSeq)

      // Closing removes ?analysis=.
      await page.keyboard.press('Escape')
      await expect(panel).toHaveCount(0)
      await expect(page).not.toHaveURL(/analysis=/)

      // "Query similar" opens the query tab with the error type ...
      await gotoApp(page, `/scans/${scan.id}?tab=results&analysis=${failedSeq}`)
      await drawer(page, failedSeq).getByRole('button', { name: 'Query similar' }).click()
      await expect(page.getByLabel('Scan tabs').getByRole('tab', { name: 'Query', exact: true })).toHaveAttribute('aria-selected', 'true')
      await expect(queryEditor(page, 'Filter')).toHaveValue(JSON.stringify({ 'error.type': analysis.error!.type }))
      await expect(page).not.toHaveURL(/filter=/)
      await expect(page).not.toHaveURL(/analysis=/)
      // ... and with the seq for an analysis without error.
      await gotoApp(page, `/scans/${scan.id}?analysis=${seq(2)}`)
      await drawer(page, seq(2)).getByRole('button', { name: 'Query similar' }).click()
      await expect(queryEditor(page, 'Filter')).toHaveValue(JSON.stringify({ seq: seq(2) }))

      // A seq without an analysis document.
      await gotoApp(page, `/scans/${scan.id}?analysis=999999`)
      await expect(drawer(page, '999,999')).toContainText('No such analysis yet')
    },
  )

  test(
    'the drawer shows masked config secrets, file chips at the FileRef paths, other files, previews and downloads',
    { tag: ['@UI-RES-009', '@UI-RES-013'] },
    async ({ page, user, openapi }) => {
      const { scan, seq } = await resultsScan(user, openapi)
      await openScanPage(page, scan.id, `?analysis=${seq(3)}`)
      const panel = drawer(page, seq(3))
      const config = panel.locator('section', { has: page.getByRole('heading', { name: 'Config' }) })
      await expect(config).toContainText('"value"')
      await expect(config.getByTitle('Secret value, not shown')).toHaveText('secret')
      await expect(panel).not.toContainText('token-3')

      const result = panel.locator('section', { has: page.getByRole('heading', { name: 'Result' }) })
      await expect(result).toContainText('/report')
      const report = result.locator('[data-file-id]')
      await expect(report).toContainText('report-3.txt')
      await expect(report).toContainText('9 B')
      await expect(report).toContainText('text/plain')
      const files = panel.locator('section', { has: page.getByRole('heading', { name: 'Files' }) })
      const chart = files.locator('[data-file-id]')
      await expect(chart).toHaveCount(1)
      await expect(chart).toContainText('chart.png')
      await expect(chart).toContainText('image/png')
      const preview = chart.getByRole('img', { name: 'Preview of chart.png' })
      await expect(preview).toBeVisible()
      await expect(preview).toHaveAttribute('referrerpolicy', 'no-referrer')
      expect(new URL((await preview.getAttribute('src'))!).origin).toBe('https://s3.scantor.localhost')
      // The preview loads lazily: once scrolled into the drawer's view, the presigned image renders.
      await preview.scrollIntoViewIfNeeded()
      await expect.poll(() => preview.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(1)

      // Downloads go through a presigned URL with a forced attachment.
      const download = page.waitForEvent('download')
      await report.getByRole('button', { name: 'Download report-3.txt' }).click()
      expect((await download).suggestedFilename()).toBe('report-3.txt')

      // A preview link that cannot be created.
      await failWithApiError(page, /\/api\/analyses\/[^/]+\/files\/[^/]+$/, { status: 500, code: 'internal', message: 'presign failed' }, 'GET')
      await reloadApp(page)
      await expect(drawer(page, seq(3)).getByText('Preview unavailable.')).toBeVisible()

      // No config stored (an analysis lost before its config was recorded).
      await page.unroute(/\/api\/analyses\/[^/]+\/files\/[^/]+$/)
      await patchJsonResponses(page, `**/api/analyses/${scan.id}-${seq(2)}`, (body) => ({ ...body, config: null }))
      await gotoApp(page, `/scans/${scan.id}?analysis=${seq(2)}`)
      await expect(drawer(page, seq(2))).toContainText('No config was stored for this analysis.')
    },
  )

  test('the drawer shows the error with its stack, details and the log tail', { tag: ['@UI-RES-010', '@UI-RES-012'] }, async ({ page, user, openapi }) => {
    const { scan, seq } = await resultsScan(user, openapi)
    const api = await tenantApi(user, openapi)
    const fatal = await getAnalysis(api, `${scan.id}-${seq(4)}`)
    await openScanPage(page, scan.id, `?analysis=${seq(4)}`)
    const panel = drawer(page, seq(4))
    const error = panel.locator('section', { has: page.getByRole('heading', { name: 'Error' }) })
    await expect(error).toContainText(fatal.error!.type)
    await expect(error).toContainText(`phase ${fatal.error!.phase}`)
    await expect(error).toContainText('not retryable')
    await expect(error).toContainText(`attempt ${fatal.error!.attempt}`)
    // The message (its ANSI sequences are checked by the hostile-output tests).
    await expect(error).toContainText('failure of value 4')
    expect(fatal.error!.stack).toBeTruthy()
    await error.getByRole('button', { name: 'Show stack trace' }).click()
    const stack = error.locator('pre')
    await expect(stack).toBeVisible()
    await expect(stack).toContainText('fatal failure of value 4')
    expect(await stack.textContent()).not.toContain('\u001b')
    await error.getByRole('button', { name: 'Hide stack trace' }).click()
    await expect(stack).toHaveCount(0)
    const logs = panel.locator('section', { has: page.getByRole('heading', { name: 'Logs' }) })
    await expect(logs).toContainText('stdout line 4')
    expect(await logs.textContent()).not.toContain('\u001b')
    await expect(logs.getByRole('button', { name: 'Wrap lines' })).toHaveAttribute('aria-pressed', 'true')
    await logs.getByRole('button', { name: 'Wrap lines' }).click()
    await expect(logs.getByRole('button', { name: 'Wrap lines' })).toHaveAttribute('aria-pressed', 'false')
    await expect(logs.getByRole('button', { name: 'Follow log' })).toBeVisible()

    // A crash carries details (exit code) and is retryable.
    const crash = await getAnalysis(api, `${scan.id}-${seq(5)}`)
    expect(crash.error!.type).toBe('crash')
    await gotoApp(page, `/scans/${scan.id}?analysis=${seq(5)}`)
    const crashError = drawer(page, seq(5)).locator('section', { has: page.getByRole('heading', { name: 'Error' }) })
    await expect(crashError).toContainText('crash')
    await expect(crashError).not.toContainText('not retryable')
    await expect(crashError.locator('[data-slot="json-view"]')).toContainText('"exitCode"')

    // No output at all.
    await patchJsonResponses(page, `**/api/analyses/${scan.id}-${seq(2)}`, (body) => ({ ...body, logTail: null }))
    await gotoApp(page, `/scans/${scan.id}?analysis=${seq(2)}`)
    await expect(drawer(page, seq(2)).locator('section', { has: page.getByRole('heading', { name: 'Logs' }) })).toContainText('No output captured.')
  })

  test(
    'the query console runs queries and aggregations with Ctrl+Enter, tables, "Load more" and truncation',
    { tag: ['@UI-RES-014', '@UI-RES-015'] },
    async ({ page, user, openapi }) => {
      const { scan } = await resultsScan(user, openapi)
      await openScanPage(page, scan.id, '?tab=query')
      const mode = (name: string) => page.getByLabel('Query mode').getByRole('tab', { name, exact: true })
      const run = page.getByRole('button', { name: 'Run query' })
      const filter = queryEditor(page, 'Filter')
      await expect(mode('Query')).toHaveAttribute('aria-selected', 'true')
      await expect(filter).toHaveValue('{"status": "failed"}')
      await filter.fill('{"status": ')
      await expect(run).toBeDisabled()
      await filter.fill('{"status": "succeeded"}')
      await queryEditor(page, 'Projection').fill('{"seq": 1, "status": 1}')
      await page.getByRole('spinbutton', { name: 'Limit' }).fill('2')
      // Ctrl+Enter runs it.
      await filter.click()
      await page.keyboard.press('Control+Enter')
      await expect(queryOutput(page)).toHaveText('2 items')
      await page.getByLabel('Output format').getByRole('tab', { name: 'Table', exact: true }).click()
      const results = uTable(page, 'Query results')
      await expect(results.getByRole('columnheader', { name: 'seq', exact: true })).toBeVisible()
      await expect(results.getByRole('columnheader', { name: 'status', exact: true })).toBeVisible()
      await expect(results.locator('tbody tr')).toHaveCount(2)
      await page.getByRole('button', { name: 'Load more' }).click()
      await expect(queryOutput(page)).toHaveText(`${SUCCEEDED.length} items`)

      // Nested items have no table view: they stay JSON.
      await queryEditor(page, 'Projection').fill('{"result": 1}')
      await run.click()
      await expect(page.locator('section', { has: queryOutput(page) }).locator('[data-slot="json-view"]')).toContainText('"result"')
      await expect(results).toHaveCount(0)

      // Aggregate mode with a cut output.
      await mode('Aggregate').click()
      const pipeline = queryEditor(page, 'Pipeline')
      await expect(pipeline).toHaveValue('[{"$group": {"_id": "$error.type", "n": {"$sum": 1}}}]')
      await pipeline.fill('[{"$group": {"_id": "$status", "n": {"$sum": 1}}}]')
      await page.getByRole('spinbutton', { name: 'Limit' }).fill('1')
      await run.click()
      await expect(queryOutput(page)).toHaveText('1 item')
      await expect(page.getByText('Output truncated')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0)
    },
  )

  test(
    'query errors stay inline with their path, and a filter naming another scan finds nothing',
    { tag: ['@UI-RES-016'] },
    async ({ page, user, openapi }) => {
      const { scan } = await resultsScan(user, openapi)
      const toasts = openToasts(page)
      await openScanPage(page, scan.id, '?tab=query')
      const filter = queryEditor(page, 'Filter')
      await filter.fill('{"$where": "sleep(1)"}')
      await page.getByRole('button', { name: 'Run query' }).click()
      await expect(page.getByText(/\(at filter\.\$where\)/)).toBeVisible()
      await expect(toasts).toHaveCount(0)

      await filter.fill(JSON.stringify({ scanId: '00000000-0000-4000-8000-000000000000' }))
      await page.getByRole('button', { name: 'Run query' }).click()
      await expect(queryOutput(page)).toHaveText('0 items')

      for (const [status, code, title] of [
        [504, 'queryTimeout', 'Query timed out'],
        [429, 'tooManyRequests', 'Too many requests'],
      ] as const) {
        await page.unroute(`**/api/scans/${scan.id}/analyses/query`)
        await failWithApiError(page, `**/api/scans/${scan.id}/analyses/query`, { status, code, message: `${code} from the server` })
        await filter.fill('{"status": "failed"}')
        await page.getByRole('button', { name: 'Run query' }).click()
        await expect(page.getByText(title, { exact: true })).toBeVisible()
        await expect(page.getByText(`${code} from the server`)).toBeVisible()
        await expect(toasts).toHaveCount(0)
      }
    },
  )

  test('recent queries, the ?filter= prefill and "Export these results"', { tag: ['@UI-RES-017'] }, async ({ page, user, openapi }) => {
    const { scan, seq } = await resultsScan(user, openapi)
    await openScanPage(page, scan.id, '?tab=query')
    const filter = queryEditor(page, 'Filter')
    for (const text of ['{"status": "succeeded"}', '{"result.label": "label-2"}']) {
      await filter.fill(text)
      const answered = page.waitForResponse(
        (response) => response.request().method() === 'POST' && response.url().endsWith(`/api/scans/${scan.id}/analyses/query`),
      )
      await page.getByRole('button', { name: 'Run query' }).click()
      expect((await answered).status()).toBe(200)
      await expect(queryOutput(page)).toHaveText(text.includes('label-2') ? '1 item' : `${SUCCEEDED.length} items`)
    }
    await reloadApp(page)
    await expect(filter).toHaveValue('{"status": "failed"}')
    await selectMenu(page, 'Recent queries').click()
    await expect(page.getByRole('option', { name: 'Query: {"result.label": "label-2"}' })).toBeVisible()
    await page.getByRole('option', { name: 'Query: {"status": "succeeded"}' }).click()
    await expect(filter).toHaveValue('{"status": "succeeded"}')

    await gotoApp(page, `/scans/${scan.id}?tab=query&filter=${encodeURIComponent(JSON.stringify({ seq: seq(6) }))}`)
    await expect(filter).toHaveValue(JSON.stringify({ seq: seq(6) }))
    await expect(page).not.toHaveURL(/filter=/)

    await page.getByRole('button', { name: 'Export these results' }).click()
    const dialog = page.getByRole('dialog', { name: `Export results of ${scan.name}` })
    await expect(dialog.getByRole('tab', { name: 'JSON filter' })).toHaveAttribute('aria-selected', 'true')
    await expect(dialog.getByRole('textbox', { name: 'Filter', exact: true })).toHaveValue(JSON.stringify({ seq: seq(6) }, null, 2))
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
  })

  test(
    'exports: the dialog validates and starts an export that is followed until ready; download and delete',
    { tag: ['@UI-RES-022', '@UI-RES-023'] },
    async ({ page, user, openapi }) => {
      const { scan } = await resultsScan(user, openapi)
      const api = await tenantApi(user, openapi)
      await openScanPage(page, scan.id, '?tab=exports')
      await page.getByRole('button', { name: 'New export' }).click()
      const dialog = page.getByRole('dialog', { name: `Export results of ${scan.name}` })
      await expect(dialog.getByRole('radio', { name: /JSON Lines/ })).toBeChecked()
      await dialog.getByRole('radio', { name: /CSV/ }).check()
      await expect(dialog).toContainText('Default columns:')
      const fields = dialog.getByRole('textbox', { name: 'Fields' })
      await fields.fill(Array.from({ length: 65 }, (_, index) => `result.f${index}`).join(', '))
      await expect(dialog.getByText('At most 64 fields.')).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Start export' })).toBeDisabled()
      await fields.fill('seq, $bad')
      await expect(dialog.getByText('"$bad" is not a dot path such as result.title.')).toBeVisible()
      // A server-side rejection lands on the filter.
      await dialog.getByRole('tab', { name: 'JSON filter' }).click()
      await dialog.getByRole('textbox', { name: 'Filter' }).fill('{"$where": "1"}')
      await fields.fill('seq, status, result.value')
      await dialog.getByRole('button', { name: 'Start export' }).click()
      await expect(dialog.getByText(/\(at filter\.\$where\)/)).toBeVisible()
      // A status selection instead.
      await dialog.getByRole('tab', { name: 'Status' }).click()
      await dialog.getByRole('button', { name: 'Statuses to export', exact: true }).click()
      await page.getByRole('option', { name: 'succeeded', exact: true }).click()
      await page.keyboard.press('Escape')
      await expect(dialog).toBeVisible()
      const created = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/scans/${scan.id}/exports`))
      await dialog.getByRole('button', { name: 'Start export' }).click()
      const exported = (await (await created).json()) as { id: string; format: string }
      expect(exported.format).toBe('csv')
      await expectToast(page, 'Export started')
      await expect(page.getByText('Export ready').first()).toBeVisible({ timeout: 90_000 })

      const table = uTable(page, 'Exports')
      await page.getByRole('button', { name: 'Refresh exports' }).click()
      const exportRow = row(table, exported.id)
      await expect(table.getByRole('columnheader')).toHaveText(['Format', 'State', 'Rows', 'Size', 'Selection', 'Created', 'Expires', ''])
      await expect(badges(exportRow)).toHaveText('ready')
      await expect(exportRow).toContainText('csv')
      await expect(exportRow).toContainText('{"status":{"$in":["succeeded"]}}')
      await expect(exportRow).toContainText('seq, status, result.value')
      await expect(exportRow).toContainText(/in \d+ days?/)
      const download = page.waitForEvent('download')
      await exportRow.getByRole('button', { name: `Download csv export ${exported.id.slice(0, 8)}` }).click()
      expect((await download).suggestedFilename()).toMatch(/\.csv$/)

      await exportRow.getByRole('button', { name: `Delete csv export ${exported.id.slice(0, 8)}` }).click()
      const confirm = page.getByRole('dialog', { name: 'Delete export?' })
      await confirm.getByRole('button', { name: 'Delete export' }).click()
      await expect(row(table, exported.id)).toHaveCount(0)
      expect((await api.call('getExport', { path: { exportId: exported.id } })).status).toBe(404)
    },
  )

  test('a failed export is reported, and deleted scans offer no new export', { tag: ['@UI-RES-022', '@UI-RES-023'] }, async ({ page, user, openapi }) => {
    const { scan } = await resultsScan(user, openapi)
    const api = await tenantApi(user, openapi)
    // The stack cannot be made to fail an export on purpose: the export answers are patched to "failed".
    await page.route('**/api/exports/*', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const response = await route.fetch()
      const body = (await response.json()) as Record<string, unknown>
      await route.fulfill({
        response,
        json: {
          ...body,
          state: 'failed',
          download: null,
          error: {
            type: 'platform',
            phase: 'export',
            message: 'the export file could not be written',
            retryable: false,
            attempt: 1,
            at: new Date().toISOString(),
          },
        },
      })
    })
    await openScanPage(page, scan.id, '?tab=exports')
    await page.getByRole('button', { name: 'New export' }).click()
    const dialog = page.getByRole('dialog', { name: `Export results of ${scan.name}` })
    const created = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/scans/${scan.id}/exports`))
    await dialog.getByRole('button', { name: 'Start export' }).click()
    const exported = (await (await created).json()) as { id: string }
    try {
      await expectToast(page, 'Export failed')
      await page.getByRole('button', { name: 'Refresh exports' }).click()
      const exportRow = row(uTable(page, 'Exports'), exported.id)
      await expect(badges(exportRow)).toHaveText('failed')
      await expect(exportRow).toContainText('the export file could not be written')
      await expect(exportRow.getByRole('button', { name: /^Download/ })).toHaveCount(0)
    } finally {
      await page.unroute('**/api/exports/*')
      const deleted = await api.call('deleteExport', { path: { exportId: exported.id } })
      expect([200, 202, 204, 404]).toContain(deleted.status)
    }

    await patchJsonResponses(page, `**/api/scans/${scan.id}`, (body) => ({ ...body, state: 'deleting' }))
    await reloadApp(page)
    await expect(page.getByRole('button', { name: 'New export' })).toBeDisabled()
    await expect(page.getByRole('toolbar', { name: 'Scan controls' }).getByRole('button', { name: 'Export results' })).toBeDisabled()
  })

  // product bug: the Workers tab of a finished scan ignores changes of its state filter
  test.fail(
    'the workers tab of a finished scan lists stopped workers once the state filter is cleared',
    {
      tag: ['@UI-RES-018'],
      annotation: {
        type: 'issue',
        description:
          'pages/scans/[scanId].vue loads the workers of a terminal scan once (workers.reset() when the tab opens, default filter: non-terminal states) but passes useWorkers `enabled: workersVisible && !terminal`, and useWorkers reloads on a filter change only while enabled: clearing the state filter keeps "No workers match."',
      },
    },
    async ({ page, user, openapi }) => {
      const { scan } = await resultsScan(user, openapi)
      await openScanPage(page, scan.id, '?tab=workers')
      await expect(page.getByText('0 active · 0 pending · 0 desired')).toBeVisible()
      const workers = uTable(page, 'Workers')
      await expect(workers).toContainText('No workers match.')
      const filter = selectMenu(page, 'Filter workers by state')
      await expect(filter).toContainText('running')
      // Clear the filter (every state).
      await filter.click()
      for (const state of ['pending', 'assigned', 'pulling', 'starting', 'running', 'backoff', 'draining'])
        await page.getByRole('option', { name: state, exact: true }).click()
      await page.keyboard.press('Escape')
      await expect(workers.locator('tbody tr[data-row-id]')).not.toHaveCount(0)
      await expect(workers.getByRole('columnheader')).toHaveText([
        'Worker',
        'Role',
        'State',
        'Node',
        'Processes',
        'Restarts',
        'Last exit',
        'Runtime',
        'Last seen',
        'Started',
        '',
      ])
      await expect(workers.getByText('scheduler', { exact: true })).toBeVisible()
      await expect(workers.getByText('runner', { exact: true }).first()).toBeVisible()
      await expect(workers.locator('[data-state="stopped"]').first()).toBeVisible()
      await expect(uTable(page, 'In-flight analyses')).toContainText('No analysis is being processed right now.')
    },
  )

  test(
    'the events tab lists events newest first, filters by kind, expands data and loads older ones',
    { tag: ['@UI-RES-021'] },
    async ({ page, user, openapi }) => {
      const { scan } = await resultsScan(user, openapi)
      const api = await tenantApi(user, openapi)
      type ScanEvent = { id: string; type: string; message: string; level: string; data?: unknown }
      const listEvents = async () =>
        ok(await api.call<{ items: ScanEvent[] }>('listScanEvents', { path: { scanId: scan.id }, query: { limit: 200 } }), 'listScanEvents').items
      expect((await listEvents()).length).toBeGreaterThan(6)
      // Pages of 3 instead of 50, so "Load more" is needed.
      await page.route(`**/api/scans/${scan.id}/events?*`, async (route) => {
        const url = new URL(route.request().url())
        if (url.searchParams.get('limit') === '50') url.searchParams.set('limit', '3')
        await route.fallback({ url: url.toString() })
      })
      // Reads of the first page (the load and the timeline's refreshes) that have not finished yet.
      let firstPagesInFlight = 0
      const countFirstPage = (delta: number) => (request: Request) => {
        const url = new URL(request.url())
        if (url.pathname === `/api/scans/${scan.id}/events` && !url.searchParams.has('cursor')) firstPagesInFlight += delta
      }
      page.on('request', countFirstPage(1))
      page.on('requestfinished', countFirstPage(-1))
      page.on('requestfailed', countFirstPage(-1))
      await openScanPage(page, scan.id, '?tab=events')
      const timeline = page.locator('[aria-label="Scan events"]')
      const rendered = timeline.locator('[data-row-id]')
      const renderedIds = () => rendered.evaluateAll((items) => items.map((item) => item.getAttribute('data-row-id') ?? ''))
      // A scan that finished moments ago may still record events (its workers stop), which the timeline's poll shows.
      let latest: ScanEvent[] = []
      await expect(async () => {
        latest = await listEvents()
        expect(await renderedIds()).toEqual(latest.slice(0, 3).map((event) => event.id))
      }).toPass({ timeout: 30_000, intervals: [1000, 2000, 3000] })
      await expect(timeline).toContainText(latest[0]!.type)
      await expect(timeline).toContainText(latest[0]!.message)
      // A refresh of the first page that overlaps "Load more" drops the loaded page (the product bug in scans.spec.ts):
      // the click waits until no refresh is in flight and is repeated if one still overlapped it. The poll stops after
      // "Load more", so nothing replaces the list afterwards.
      const more = page.getByRole('button', { name: 'Load more' })
      await expect.poll(() => firstPagesInFlight).toBe(0)
      await expect(async () => {
        if (await more.isVisible()) await more.click({ timeout: 1000 })
        await expect(rendered).toHaveCount(6, { timeout: 2000 })
      }).toPass({ timeout: 20_000 })
      await expect.poll(() => firstPagesInFlight).toBe(0)
      await expect(rendered).toHaveCount(6)

      const shown = await renderedIds()
      const withData = latest.find((event) => shown.includes(event.id) && event.data)
      if (withData) {
        const show = page.getByRole('button', { name: `Show data of event ${withData.type} ${withData.id.slice(0, 8)}` })
        await show.click()
        await expect(page.getByRole('button', { name: `Hide data of event ${withData.type} ${withData.id.slice(0, 8)}` })).toHaveAttribute(
          'aria-expanded',
          'true',
        )
        await expect(timeline.locator('[data-slot="json-view"]')).toHaveCount(1)
      }

      for (const [label, prefix] of [
        ['Worker events', 'worker.'],
        ['Scan events', 'scan.'],
      ] as const) {
        await page.getByRole('combobox', { name: 'Filter events by type' }).click()
        await page.getByRole('option', { name: label }).click()
        await expect(rendered.first()).toBeVisible()
        await expect.poll(async () => (await timeline.locator('[data-slot="title"]').allTextContents()).every((title) => title.startsWith(prefix))).toBe(true)
      }
    },
  )

  test(
    'the attempts of a flaky analysis: newest first, with errors, worker, node and expandable logs',
    { tag: ['@UI-RES-011'] },
    async ({ page, user, openapi }) => {
      // Config value 0 of the results scan fails twice (taskError) and succeeds in attempt 3, logging in every attempt.
      const { scan, seq } = await resultsScan(user, openapi)
      const flaky = await getAnalysis(await tenantApi(user, openapi), `${scan.id}-${seq(0)}`)
      expect(flaky.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2, 3])

      await openScanPage(page, scan.id, `?tab=results&analysis=${seq(0)}`)
      const attempts = uTable(drawer(page, seq(0)), 'Attempts')
      await expect(attempts.locator('tbody tr[data-row-id]')).toHaveCount(3)
      const cells = (index: number) => attempts.locator('tbody tr[data-row-id]').nth(index).getByRole('cell')
      await expect(cells(0).nth(0)).toHaveText('3')
      await expect(cells(0).nth(4)).toHaveText('succeeded')
      await expect(cells(1).nth(0)).toHaveText('2')
      await expect(cells(1).nth(4)).toContainText('flaky failure in attempt 2')
      await expect(cells(2).nth(0)).toHaveText('1')
      await expect(cells(2).nth(4)).toContainText('flaky failure in attempt 1')
      await expect(cells(2).nth(4)).toContainText('taskError')
      await expect(cells(2).nth(1)).toHaveText('1')
      await expect(cells(2).nth(5).locator(`code[data-id="${flaky.attempts[0]!.workerId}"]`)).toBeVisible()
      await expect(cells(2).nth(6).locator(`code[data-id="${flaky.attempts[0]!.nodeId}"]`)).toBeVisible()
      // Each attempt's log tail expands below the table.
      await attempts.getByRole('button', { name: 'Show log of attempt 1 round 1' }).click()
      const log = drawer(page, seq(0))
        .locator('div', { has: page.getByText('Log of attempt 1, round 1', { exact: true }) })
        .last()
      await expect(log).toContainText('analysis 0 starts')
      await expect(attempts.getByRole('button', { name: 'Hide log of attempt 1 round 1' })).toHaveAttribute('aria-expanded', 'true')
    },
  )
})

test.describe('results of a running scan', () => {
  test(
    'auto-refresh, workers, worker logs and the in-flight analyses while the scan runs',
    { tag: ['@UI-RES-006', '@UI-RES-018', '@UI-RES-019', '@UI-RES-020'] },
    async ({ page, api, user, openapi }) => {
      test.setTimeout(180_000)
      const sleep = await sharedTask(user, openapi, 'sleep')
      const scan = await startOwnScan(user, openapi, {
        revision: sleep.revision.id,
        name: unique('running'),
        taskConfig: { seconds: 120 },
        scanConfig: { times: 4 },
        settings: { workers: 1, processes: 2, resources: { cpus: 0.25, memoryMiB: 256 } },
      })
      await expect
        .poll(async () => ok(await api.call<{ items: unknown[] }>('listInflightAnalyses', { path: { scanId: scan.id } }), 'inflight').items.length, {
          timeout: 150_000,
        })
        .toBeGreaterThan(0)

      await openScanPage(page, scan.id, '?tab=results')
      const autoRefresh = page.getByRole('switch', { name: 'Auto-refresh' })
      await expect(autoRefresh).toBeChecked()
      await page.waitForRequest((request) => request.url().includes(`/api/scans/${scan.id}/analyses?`), { timeout: 20_000 })
      await autoRefresh.click()
      await expect(autoRefresh).not.toBeChecked()

      await openScanTab(page, 'Workers')
      await expect(page.getByText(/^\d+ active · \d+ pending · \d+ desired$/)).toBeVisible()
      const workers = uTable(page, 'Workers')
      const runner = workers.locator('tbody tr[data-row-id]', { hasText: 'runner' }).first()
      await expect(runner.locator('[data-state="running"]')).toBeVisible({ timeout: 60_000 })
      await expect(runner.getByRole('link', { name: /builtin|remote-1/ })).toHaveAttribute('href', /\/admin\/nodes\//)
      await expect(runner).toContainText('2 / ')
      await expect(runner).toContainText('dev')
      const workerId = (await runner.getAttribute('data-row-id'))!

      // In flight: the sleeping analyses with a live timer and their progress.
      const inflight = uTable(page, 'In-flight analyses')
      await expectAfterRefresh(page, async () => {
        await expect(inflight.locator('tbody tr[data-row-id]').first()).toBeVisible({ timeout: 2000 })
      })
      const first = inflight.locator('tbody tr[data-row-id]').first()
      await expect(inflight.getByRole('columnheader')).toHaveText(['Analysis', 'Seq', 'Attempt', 'Round', 'Running for', 'Worker', 'Node', 'Progress'])
      const timer = first.getByRole('cell').nth(4)
      const before = await timer.textContent()
      await expect(timer).not.toHaveText(before!, { timeout: 5000 })
      await expect(page.getByText(/^updated (just now|\d+ min ago)$/)).toBeVisible()

      // Worker logs.
      await runner.getByRole('button', { name: `Show worker logs of ${workerId.slice(0, 8)}` }).click()
      const modal = page.getByRole('dialog', { name: `Logs of runner ${workerId.slice(0, 8)}` })
      await expect(modal).toBeVisible()
      await expect(modal.getByText('Requesting the latest output from the node…').or(modal.getByText(/^Collected/))).toBeVisible()
      await expect(modal.getByText(/^Collected (just now|\d+ min ago)$/)).toBeVisible({ timeout: 30_000 })
      await expect(modal.getByTestId('worker-logs')).not.toContainText('No output collected yet.')
      const refreshLogs = page.waitForRequest((request) => request.url().includes(`/workers/${workerId}/logs`))
      await modal.getByRole('button', { name: 'Refresh' }).click()
      await refreshLogs
      await expect(modal.getByText(/^Collected/)).toBeVisible()
    },
  )
})

test.describe('results for admins', () => {
  test.use({ role: 'admin' })

  test('admins get a node link in the analysis drawer', { tag: ['@UI-RES-008'] }, async ({ page, user, openapi }) => {
    // The tenant's shared scan, opened by the admin.
    const { scan, seq } = await resultsScan(user, openapi)
    const analysis = await getAnalysis(await tenantApi(user, openapi), `${scan.id}-${seq(2)}`)
    await openScanPage(page, scan.id, `?analysis=${seq(2)}`)
    const summary = drawer(page, seq(2)).locator('dl').first()
    await expect(summary.getByRole('link', { name: analysis.nodeId!.slice(0, 8) })).toHaveAttribute('href', `/admin/nodes/${analysis.nodeId}`)
  })
})

/** The two shared hostile-output scans of the worker: one returns the payload, one raises it (mode `fail`). */
async function hostileScans(owner: { id: string; apiKey: string }, openapi: OpenApiIndex): Promise<{ okScan: Scan; failScan: Scan }> {
  const revision = async () => (await sharedTask(owner, openapi, 'hostile-output')).revision.id
  const [okScan, failScan] = await Promise.all([
    sharedScan(owner, openapi, 'hostile-ok', async () => ({ revision: await revision(), name: unique('hostile-ok') })),
    sharedScan(owner, openapi, 'hostile-fail', async () => ({ revision: await revision(), name: unique('hostile-fail'), taskConfig: { mode: 'fail' } })),
  ])
  return { okScan, failScan }
}

/** The text a scope renders contains no escape character (docs/security.md HDR-5). */
async function expectNoEscapes(scope: Locator): Promise<void> {
  expect(await scope.evaluate((element) => (element as HTMLElement).innerText.includes('\u001b'))).toBe(false)
}

test.describe('hostile task output', () => {
  test('results, logs, errors, events and file names of hostile-output render as inert text', { tag: ['@UI-SEC-004'] }, async ({ page, user, openapi }) => {
    const { okScan, failScan } = await hostileScans(user, openapi)

    const dialogs = recordDialogs(page)
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    const assertInert = async () => {
      // Nothing from the payload became markup.
      await expect(page.locator('img[src="x"], [onerror], iframe, object, embed')).toHaveCount(0)
      expect(await page.locator('script').evaluateAll((scripts) => scripts.filter((script) => (script.textContent ?? '').includes('alert(')).length)).toBe(0)
      // The only links are the app's own or http(s) links that cannot reach back.
      const links = await page
        .locator('a[href]')
        .evaluateAll((anchors) => anchors.map((anchor) => ({ href: anchor.getAttribute('href') ?? '', rel: anchor.getAttribute('rel') ?? '' })))
      for (const link of links) {
        expect(link.href.toLowerCase()).not.toContain('javascript:')
        if (/^https?:/i.test(link.href) && !link.href.startsWith('https://scantor.localhost')) {
          expect(link.rel).toContain('noopener')
          expect(link.rel).toContain('noreferrer')
        }
      }
      expect(dialogs).toEqual([])
    }

    // Results table: the result columns hold the payload as text.
    await openScanPage(page, okScan.id, '?tab=results')
    const table = resultsTable(page)
    await expect(table.locator('tbody tr[data-row-id]').first()).toContainText('<img src=x onerror=alert(1)><script>alert(2)</script>')
    await expect(table.locator('tbody tr[data-row-id]').first()).toContainText('javascript:alert(6)')
    const seq = (await table.locator('tbody tr[data-row-id]').first().getAttribute('data-row-id'))!
    await assertInert()

    // The drawer: result JSON, file chips with hostile names, logs (ANSI-free: LogView strips them).
    await gotoApp(page, `/scans/${okScan.id}?analysis=${seq}`)
    const panel = drawer(page, seq)
    await expect(panel).toContainText('<img src=x onerror=alert(1)><script>alert(2)</script>')
    await expect(panel).toContainText('javascript:alert(6)')
    for (const name of ['x.html', 'x.svg', 'x.png']) await expect(panel.locator('[data-file-id]', { hasText: name }).first()).toBeVisible()
    await expect(panel.locator('[data-file-id]', { hasText: 'quoted' }).first()).toContainText('"quoted"')
    const logs = panel.locator('section', { has: page.getByRole('heading', { name: 'Logs' }) })
    await expect(logs).toContainText('<img src=x onerror=alert(1)>')
    await expect(logs).toContainText('red')
    await expectNoEscapes(logs)
    await assertInert()
    // The SVG with a script and the HTML file are never previewed.
    await expect(panel.getByRole('img', { name: 'Preview of x.svg' })).toHaveCount(0)
    await expect(panel.getByRole('img', { name: 'Preview of x.html' })).toHaveCount(0)

    // The error of the failing variant, in the table and the drawer (with its stack, ANSI-free).
    await gotoApp(page, `/scans/${failScan.id}?tab=results&analysis=${seq}`)
    const failed = drawer(page, seq)
    const error = failed.locator('section', { has: page.getByRole('heading', { name: 'Error' }) })
    await expect(error).toContainText('<img src=x onerror=alert(1)><script>alert(2)</script>')
    await error.getByRole('button', { name: 'Show stack trace' }).click()
    await expect(error.locator('pre')).toBeVisible()
    await expectNoEscapes(error.locator('pre'))
    await expect(resultsTable(page).locator(`tr[data-row-id="${seq}"]`)).toContainText('<img src=x')
    await assertInert()

    // Events (messages and data) and the query console's output.
    await gotoApp(page, `/scans/${failScan.id}?tab=events`)
    await expect(page.locator('[aria-label="Scan events"]')).toBeVisible()
    await expectNoEscapes(page.locator('[aria-label="Scan events"]'))
    await assertInert()
    await gotoApp(page, `/scans/${okScan.id}?tab=query`)
    await queryEditor(page, 'Filter').fill('{}')
    await page.getByRole('button', { name: 'Run query' }).click()
    await expect(queryOutput(page)).toHaveText('1 item')
    await expect(page.locator('section', { has: queryOutput(page) })).toContainText('onerror=alert(1)')
    await assertInert()
    expect(pageErrors.filter((message) => message.includes('alert'))).toEqual([])
  })

  // product bug: result strings and error messages keep their ANSI sequences (only logs and stacks are stripped)
  test.fail(
    'ANSI sequences of result strings and error messages are stripped in the results table and the drawer',
    {
      tag: ['@UI-SEC-004'],
      annotation: {
        type: 'issue',
        description:
          'ScanResultsTable.vue renders result cells (cellText) and error.message, AnalysisSlideover.vue error.message and AttemptsTable.vue error.message without stripAnsi (app/utils/ansi.ts), so ESC sequences of task output reach the DOM (docs/security.md HDR-5)',
      },
    },
    async ({ page, user, openapi }) => {
      const { okScan, failScan } = await hostileScans(user, openapi)
      // A result string (`ansi`, `html`) in the results table.
      await openScanPage(page, okScan.id, '?tab=results')
      const okRow = resultsTable(page).locator('tbody tr[data-row-id]').first()
      await expect(okRow).toContainText('bold')
      await expectNoEscapes(okRow)
      // The error message in the results table, the drawer's error section and the attempts table.
      await gotoApp(page, `/scans/${failScan.id}?tab=results`)
      const failedRow = resultsTable(page).locator('tbody tr[data-row-id]').first()
      await expect(failedRow).toContainText('<img src=x')
      const seq = (await failedRow.getAttribute('data-row-id'))!
      await expectNoEscapes(failedRow)
      await gotoApp(page, `/scans/${failScan.id}?tab=results&analysis=${seq}`)
      const error = drawer(page, seq).locator('section', { has: page.getByRole('heading', { name: 'Error' }) })
      await expect(error).toContainText('<img src=x')
      await expectNoEscapes(error)
      await expectNoEscapes(uTable(drawer(page, seq), 'Attempts'))
    },
  )
})
