import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page, Request } from '@playwright/test'
import type { Scan } from '#shared/types/scans'
import type { Script, ScriptRun } from '#shared/types/scripts'
import { ApiError, ok, type ApiClient } from '../helpers/api-client'
import { waitForScriptRun } from '../helpers/authz-ui'
import { env } from '../helpers/env'
import type { OpenApiIndex } from '../helpers/openapi'
import { exampleTaskDir, renameManifest, uploadAndPublish, type UploadedTask } from '../helpers/tasks'
import {
  badges,
  expectToast,
  gotoApp,
  openScanPage,
  row,
  schemaField,
  SHARED_SETUP_TIMEOUT_MS,
  sharedScan,
  shieldFromNetworkChanges,
  tenantApi,
  uTable,
} from '../helpers/ui-scans-kit'
import { alertBox, browserStorage, freshTenantHandle, fulfillJson, nodeRouted, openPage, reloadPage, stopEditorAndWait } from '../helpers/ui-shell-tasks'
import { expect, test as base, unique, type Tenant } from '../fixtures'

// The script pages of the dashboard (docs/ui.md §4, docs/scripts.md): the list with search and empty state, the new-script
// form, the script page with its tabs and actions, the run form (scan picker, config, secrets, sample and full runs),
// the run page (progress, result, outputs, log, cancel, run again, resume, failures), "Run script" on the scan page and
// the editor on a script folder. Runs read a completed scan of the `files` example that each worker builds once.

/** A script the test created (or a test of the UI created), deleted after the test. */
interface ScriptsFixture {
  /** Creates a script from the scaffold (default name unique('script')) and writes `files` over the scaffold's. */
  create(options?: { name?: string; description?: string; files?: Record<string, string> }): Promise<Script>
  /** Registers a script created another way (the new-script form) for deletion after the test. */
  track(name: string): void
}

const test = base.extend<{ uiScripts: ScriptsFixture }>({
  // The deletion's job (cancel the runs, remove outputs, images and the folder) is not awaited: the tenant's purge at
  // worker teardown removes whatever it left (docs/testing.md §7.7).
  uiScripts: async ({ api }, use) => {
    const created: string[] = []
    await use({
      create: async (options = {}) => {
        const name = options.name ?? unique('script')
        created.push(name)
        const body = { name, ...(options.description ? { description: options.description } : {}) }
        const script = ok(await api.call<Script>('createScript', { body }), 'createScript')
        if (options.files) ok(await api.call('writeScriptFiles', { path: { script: script.id }, body: { files: options.files } }), 'writeScriptFiles')
        return script
      },
      track: (name) => void created.push(name),
    })
    for (const name of [...new Set(created)].reverse()) {
      const deleted = await api.call('deleteScript', { path: { script: name } })
      if (deleted.status !== 202 && deleted.status !== 404) throw new ApiError(`deleteScript ${name}`, deleted)
    }
  },
})

/** A build, a container start and the run itself; builds queue behind every concurrent build of the stack. */
const RUN_TIMEOUT = 240_000

const FILES_REPORT_DIR = join(env.paths.tests, 'fixtures', 'scripts', 'files-report')

/** The files of tests/fixtures/scripts/files-report with the manifest renamed to `name`. */
async function filesReportFiles(name: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const entry of await readdir(FILES_REPORT_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const content = await readFile(join(FILES_REPORT_DIR, entry.name), 'utf8')
    files[entry.name] = entry.name === 'scantor-script.yaml' ? renameManifest(content, name) : content
  }
  return files
}

/**
 * Ticks once a second up to `seconds` (600 by default), saving its position as checkpoint on every tick, so a run stays
 * active until it is cancelled and a resumed run continues after the last checkpoint. It prints the API_TOKEN secret,
 * which the log masks.
 */
const TICKER_MAIN = `"""ticker: ticks once a second up to \`seconds\` and checkpoints every tick."""

import time

from pydantic import BaseModel

import scantor
from scantor.script import Script, ScriptContext


class Config(scantor.Config):
    seconds: int = 600


class Summary(BaseModel):
    ticks: int
    start: int


def run(ctx: ScriptContext, config: Config) -> Summary:
    if "API_TOKEN" in ctx.secrets:
        print(f"secret API_TOKEN={ctx.secrets['API_TOKEN']}", flush=True)
    state = ctx.resume_state or {"ticks": 0}
    start = state["ticks"]
    for tick in range(start, config.seconds):
        ctx.check_cancelled()
        print(f"tick {tick}", flush=True)
        state["ticks"] = tick + 1
        ctx.progress(state["ticks"], config.seconds, f"tick {tick}")
        ctx.checkpoint(state)
        time.sleep(1)
    return Summary(ticks=state["ticks"], start=start)


script = Script(run=run, config=Config, result=Summary)
`

/** Raises at once: the run fails with a scriptError and exit code 1. */
const FAILING_MAIN = `"""failing: raises at once."""

import scantor
from scantor.script import Script, ScriptContext


def run(ctx: ScriptContext, config: scantor.Empty) -> None:
    raise ValueError("script failure marker")


script = Script(run=run)
`

// ── the scan the runs read ─────────────────────────────────────────────────────────────────────────────

const filesTasks = new Map<string, Promise<UploadedTask>>()

/** The `files` example of the tenant, published once per worker. */
function filesTask(owner: Tenant, openapi: OpenApiIndex): Promise<UploadedTask> {
  let task = filesTasks.get(owner.id)
  if (!task) {
    task = tenantApi(owner, openapi).then((api) => uploadAndPublish(api, exampleTaskDir('files'), unique('files')))
    filesTasks.set(owner.id, task)
    task.catch(() => filesTasks.delete(owner.id))
  }
  return task
}

/** A completed scan of the `files` example with two analyses, shared by the tests of this worker (they only read it). */
function filesScan(owner: Tenant, openapi: OpenApiIndex): Promise<Scan> {
  return sharedScan(owner, openapi, 'scripts-files', async () => ({
    revision: (await filesTask(owner, openapi)).revision.id,
    name: unique('script-input'),
    scanConfig: { items: ['alpha.example', 'beta.example'] },
  }))
}

// ── page helpers ───────────────────────────────────────────────────────────────────────────────────────

const scriptTitle = (page: Page) => page.locator('#scantor-dashboard-panel-script h1[data-slot="title"]')
const runTitle = (page: Page) => page.locator('#scantor-dashboard-panel-script-run h1[data-slot="title"]')
/** The state badge in the run page's title. */
const runState = (page: Page) => badges(runTitle(page)).first()
const runForm = (page: Page) => page.getByTestId('script-run-form')
const scriptTab = (page: Page, name: string) => page.getByLabel('Script tabs').getByRole('tab', { name, exact: true })
/** A card by its section label ("Inputs", "Code and state", "Latest run"). */
const card = (page: Page, label: string) => page.locator('p.section-label', { hasText: label }).first().locator('xpath=..')
/** The value (dd) of a term (dt) of a definition list in `scope`. */
const definition = (scope: Locator, term: string) => scope.locator('dt', { hasText: new RegExp(`^${term}$`) }).locator('xpath=following-sibling::dd[1]')

const isApi = (request: Request, method: string, path: string) => request.method() === method && new URL(request.url()).pathname === path

/** Selects a scan in the run form's picker by searching its name (listScans?q=). */
async function pickScan(page: Page, scan: Scan): Promise<void> {
  const form = runForm(page)
  const searched = page.waitForRequest((request) => {
    const url = new URL(request.url())
    return url.pathname === '/api/scans' && url.searchParams.get('q') === scan.name
  })
  await form.getByRole('button', { name: 'Scans', exact: true }).click()
  await page.getByPlaceholder('Search scans by name…').fill(scan.name!)
  await searched
  await page.getByRole('option').filter({ hasText: scan.name! }).click()
  await page.keyboard.press('Escape')
  await expect(form.getByText('1 of at most 20 scans selected')).toBeVisible()
}

/** Clicks a start button of the run form; returns the started run and the request body once its page is open. */
async function startFromForm(page: Page, script: Script, button: string): Promise<{ run: ScriptRun; body: unknown }> {
  const started = page.waitForResponse((response) => isApi(response.request(), 'POST', `/api/scripts/${script.id}/runs`))
  await runForm(page).getByRole('button', { name: button, exact: true }).click()
  const response = await started
  expect(response.status(), await response.text()).toBe(201)
  const run = (await response.json()) as ScriptRun
  await expect(page).toHaveURL((url) => url.pathname === `/scripts/${script.id}/runs/${run.id}`)
  return { run, body: response.request().postDataJSON() }
}

/** Confirms the "Run again" or "Resume" dialog; returns the new run and the request body once its page is open. */
async function restartFromDialog(page: Page, dialog: Locator, button: string, from: ScriptRun): Promise<{ run: ScriptRun; body: unknown }> {
  const started = page.waitForResponse((response) => isApi(response.request(), 'POST', `/api/script-runs/${from.id}/restart`))
  await dialog.getByRole('button', { name: button, exact: true }).click()
  const response = await started
  expect(response.status(), await response.text()).toBe(201)
  const run = (await response.json()) as ScriptRun
  await expect(page).toHaveURL((url) => url.pathname === `/scripts/${from.scriptId}/runs/${run.id}`)
  return { run, body: response.request().postDataJSON() }
}

/** Replaces the config of a schema form in `scope` through "Edit as JSON" (a form without known schema is JSON already). */
async function setConfigJson(scope: Locator, value: Record<string, unknown>): Promise<void> {
  const toggle = scope.getByRole('button', { name: 'Edit as JSON', exact: true })
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  await scope.getByRole('textbox', { name: 'config as JSON' }).fill(JSON.stringify(value))
}

/** Waits until the run has ended in `state` (getScriptRun long-polls), then until the run page shows that state. */
async function expectRunEnded(page: Page, api: ApiClient, runId: string, state: ScriptRun['state'] = 'completed'): Promise<ScriptRun> {
  const run = await waitForScriptRun(api, runId, RUN_TIMEOUT)
  expect(run.state, `script run ${runId}: ${JSON.stringify({ errors: run.errors, error: run.error, logTail: run.logTail })}`).toBe(state)
  await expect(runState(page)).toHaveText(state, { timeout: 30_000 })
  return run
}

function getRun(api: ApiClient, scriptRunId: string): Promise<ScriptRun> {
  return api.call<ScriptRun>('getScriptRun', { path: { scriptRunId } }).then((response) => ok(response, 'getScriptRun'))
}

// ── tests ──────────────────────────────────────────────────────────────────────────────────────────────

test.describe('script pages', () => {
  // Chromium aborts in-flight requests whenever the inner dockerd changes networks (helpers/ui-scans-kit.ts).
  test.beforeEach(async ({ page }) => shieldFromNetworkChanges(page))

  test.describe('of a user without scripts', () => {
    test.use({ pageUser: 'fresh' })

    test('the list shows "No scripts yet" with a link to the new-script form', { tag: ['@UI-SCRIPT-001'] }, async ({ page }) => {
      await gotoApp(page, '/scripts')
      await expect(page).toHaveTitle('Scripts · scantor')
      await expect(page.getByText('No scripts yet', { exact: true })).toBeVisible()
      const first = page.getByRole('link', { name: 'Create your first script' })
      await expect(first).toHaveAttribute('href', '/scripts/new')
      await first.click()
      await expect(page).toHaveURL((url) => url.pathname === '/scripts/new')
    })
  })

  test(
    'the list shows the scripts, searches their names and descriptions and a row opens the script',
    { tag: ['@UI-SCRIPT-001'] },
    async ({ page, uiScripts }) => {
      const marker = unique('marker')
      const [described, plain] = await Promise.all([
        uiScripts.create({ name: unique('list-a'), description: `Reads the ${marker} results.` }),
        uiScripts.create({ name: unique('list-b') }),
      ])
      await gotoApp(page, '/scripts')
      const table = uTable(page, 'Scripts')
      await expect(table.getByRole('columnheader')).toHaveText(['Name', 'Language', 'Source', 'Latest run', 'Updated'])
      const describedRow = row(table, described.id)
      await expect(describedRow.getByRole('link', { name: described.name, exact: true })).toHaveAttribute('href', `/scripts/${described.id}`)
      await expect(describedRow).toContainText(`Reads the ${marker} results.`)
      const cells = describedRow.getByRole('cell')
      await expect(cells.nth(1)).toHaveText('python')
      await expect(cells.nth(2)).toHaveText('scaffold')
      await expect(cells.nth(3)).toHaveText('none')
      await expect(row(table, plain.id)).toBeVisible()
      await expect(page.getByRole('switch', { name: 'Only mine' })).toHaveCount(0)

      // The search asks the server (listScripts?q=) and matches descriptions too.
      const search = page.getByRole('textbox', { name: 'Search scripts' })
      const searched = page.waitForRequest((request) => {
        const url = new URL(request.url())
        return url.pathname === '/api/scripts' && url.searchParams.get('q') === marker
      })
      await search.fill(marker)
      await searched
      await expect(row(table, described.id)).toBeVisible()
      await expect(row(table, plain.id)).toHaveCount(0)
      await search.fill(plain.name)
      await expect(row(table, plain.id)).toBeVisible()
      await expect(row(table, described.id)).toHaveCount(0)
      await search.fill(unique('nothing'))
      await expect(table.getByText('No scripts.', { exact: true })).toBeVisible()
      await expect(page.getByText('No scripts yet', { exact: true })).toHaveCount(0)

      await search.fill(described.name)
      await row(table, described.id).getByRole('cell').nth(1).click()
      await expect(page).toHaveURL((url) => url.pathname === `/scripts/${described.id}`)
      await expect(scriptTitle(page)).toContainText(described.name)
    },
  )

  test(
    '"New script" creates a script from the scaffold and opens it with the ready banner; taken and invalid names are refused',
    { tag: ['@UI-SCRIPT-002'] },
    async ({ page, api, uiScripts }) => {
      const name = unique('new-script')
      uiScripts.track(name)
      await gotoApp(page, '/scripts')
      await page.getByRole('link', { name: 'New script', exact: true }).click()
      await expect(page).toHaveURL((url) => url.pathname === '/scripts/new')
      await expect(page).toHaveTitle('New script · scantor')
      await expect(page.getByRole('region', { name: 'Upload a script with the CLI' })).toContainText('scantor scripts push')

      // An invalid name never reaches the server.
      const creates: string[] = []
      page.on('request', (request) => {
        if (isApi(request, 'POST', '/api/scripts')) creates.push(request.url())
      })
      const nameField = page.getByLabel('Name')
      await nameField.fill('Not A Slug')
      await page.getByRole('button', { name: 'Create script', exact: true }).click()
      await expect(page.locator('[data-slot="error"]').first()).toBeVisible()
      await expect(page).toHaveURL((url) => url.pathname === '/scripts/new')
      expect(creates).toEqual([])

      await nameField.fill(name)
      await page.getByLabel('Description').fill('made in the browser')
      await page.getByRole('button', { name: 'Create script', exact: true }).click()
      await expect(page).toHaveURL((url) => /^\/scripts\/[0-9a-f-]{36}$/.test(url.pathname) && url.searchParams.get('created') === '1')
      const script = ok(await api.call<Script>('getScript', { path: { script: name } }), 'getScript')
      expect(script).toMatchObject({ name, language: 'python', description: 'made in the browser', source: { kind: 'scaffold' } })
      expect(new URL(page.url()).pathname).toBe(`/scripts/${script.id}`)
      const banner = alertBox(page, `Script ${name} is ready`)
      await expect(banner).toBeVisible()
      await expect(banner.getByRole('link', { name: 'Open the editor' })).toHaveAttribute('href', `/editor?script=${name}`)
      await banner.getByRole('button', { name: 'Try it on a scan' }).click()
      await expect(scriptTab(page, 'Runs')).toHaveAttribute('aria-selected', 'true')
      await expect(runForm(page)).toBeVisible()

      // A taken name is shown under the field.
      await gotoApp(page, '/scripts/new')
      await page.getByLabel('Name').fill(name)
      await page.getByRole('button', { name: 'Create script', exact: true }).click()
      await expect(page.getByText('A script with this name already exists.', { exact: true })).toBeVisible()
      await expect(page).toHaveURL((url) => url.pathname === '/scripts/new')
    },
  )

  test(
    'a script page offers editor, run, download and delete; the overview shows folder, runs and schemas, the files tab the folder',
    { tag: ['@UI-SCRIPT-003'] },
    async ({ page, api, uiScripts }) => {
      const script = await uiScripts.create({ description: 'a script to look at' })
      await gotoApp(page, `/scripts/${script.id}`)
      await expect(page).toHaveTitle(`${script.name} · scantor`)
      await expect(scriptTitle(page)).toContainText(script.name)
      await expect(scriptTitle(page)).toContainText('python')
      await expect(scriptTitle(page).getByRole('link', { name: 'Back to the scripts' })).toHaveAttribute('href', '/scripts')
      await expect(page.getByRole('link', { name: 'Open in editor' }).first()).toHaveAttribute('href', `/editor?script=${script.name}`)
      const download = page.getByRole('link', { name: 'Download script' })
      await expect(download).toHaveAttribute('href', `/api/scripts/${script.id}/workspace/archive`)
      await expect(download).toHaveAttribute('download', /.*/)

      // Overview.
      await expect(scriptTab(page, 'Overview')).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByText('a script to look at', { exact: true })).toBeVisible()
      await expect(definition(card(page, 'Latest run'), 'State')).toHaveText('none')
      await expect(definition(card(page, 'Source'), 'Kind')).toHaveText('scaffold')
      await expect(page.getByText('No runs yet.', { exact: true })).toBeVisible()
      await expect(page.getByText(/^The schemas appear after the first run/)).toBeVisible()

      // "Run script" opens the run form.
      await page.getByRole('button', { name: 'Run script', exact: true }).click()
      await expect(scriptTab(page, 'Runs')).toHaveAttribute('aria-selected', 'true')
      await expect(page).toHaveURL((url) => url.searchParams.get('tab') === 'runs')
      await expect(runForm(page)).toBeVisible()

      // Files.
      await scriptTab(page, 'Files').click()
      const tree = page.getByRole('tree', { name: 'Script files' })
      for (const file of ['scantor-script.yaml', 'Dockerfile', 'main.py', 'models.py', 'requirements.txt'])
        await expect(tree.getByRole('treeitem', { name: file, exact: true })).toBeVisible()
      await expect(page.getByRole('link', { name: 'Open in editor' }).last()).toHaveAttribute('href', `/editor?script=${script.name}`)
      await tree.getByRole('treeitem', { name: 'main.py', exact: true }).click()
      await expect(page.getByRole('region', { name: 'main.py' })).toContainText('script = Script(run=run, config=Config, result=Summary)')
      await tree.getByRole('treeitem', { name: 'scantor-script.yaml', exact: true }).click()
      await expect(page.getByRole('region', { name: 'scantor-script.yaml' })).toContainText(`name: ${script.name}`)

      // "Delete script" asks for the name.
      await page.getByRole('button', { name: 'Delete script', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: `Delete ${script.name}` })
      const confirm = dialog.getByRole('button', { name: 'Delete script', exact: true })
      await expect(confirm).toBeDisabled()
      await dialog.getByLabel(`Type ${script.name} to confirm`).fill(script.name)
      await confirm.click()
      await expectToast(page, `Script ${script.name} is being deleted`)
      await expect(page).toHaveURL((url) => url.pathname === '/scripts')
      await expect.poll(async () => (await api.call('getScript', { path: { script: script.id } })).status, { timeout: 60_000 }).toBe(404)
    },
  )

  test(
    '"Open in editor" is the editor page with ?script=; an unknown script there offers "Open workspace"',
    { tag: ['@UI-EDIT-007'] },
    async ({ page, api }) => {
      const missing = unique('nosuchscript')
      expect((await api.call('getScript', { path: { script: missing } })).status).toBe(404)
      const notFound = page.waitForResponse((response) => isApi(response.request(), 'POST', '/api/editor/session'))
      await gotoApp(page, `/editor?script=${missing}`)
      const response = await notFound
      expect(response.status()).toBe(404)
      expect(response.request().postDataJSON()).toEqual({ openScript: missing })
      const alert = alertBox(page, `Script “${missing}” was not found`)
      await expect(alert).toBeVisible()

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
    },
  )

  test.describe('runs on a scan', () => {
    // The scan the runs read is published and run before the first test of this block in a worker, outside the tests'
    // timeouts: a build that queues behind the stack's other builds, then the scan.
    test.beforeAll(async ({ user, openapi }) => {
      test.setTimeout(SHARED_SETUP_TIMEOUT_MS + 150_000)
      await filesScan(user, openapi)
    })

    test(
      'the run form picks scans by name and starts a sample run; its page shows progress, result, outputs, log and source',
      { tag: ['@UI-SCRIPT-004', '@UI-SCRIPT-005'] },
      async ({ page, api, user, openapi, uiScripts }) => {
        test.setTimeout(360_000)
        const scan = await filesScan(user, openapi)
        const name = unique('files-report')
        const script = await uiScripts.create({ name, files: await filesReportFiles(name) })

        await gotoApp(page, `/scripts/${script.id}?tab=runs`)
        const form = runForm(page)
        // No run reported a config schema yet: the config is JSON.
        await expect(form.getByText('No config schema known yet', { exact: true })).toBeVisible()
        await expect(form.getByRole('textbox', { name: 'config as JSON' })).toBeVisible()
        await expect(form.getByText('0 of at most 20 scans selected')).toBeVisible()
        await expect(uTable(page, 'Script run history').getByText('No runs yet.', { exact: true })).toBeVisible()
        await pickScan(page, scan)
        const { run, body } = await startFromForm(page, script, 'Try on 100 analyses')
        expect(body).toEqual({ scans: [scan.id], config: {}, settings: { limit: 100 } })
        expect(run).toMatchObject({ scriptId: script.id, scriptName: name, scans: [{ id: scan.id, name: scan.name }], restartedFrom: null })

        await expect(runTitle(page)).toContainText(name)
        await expect(page).toHaveTitle(`${name} run ${run.id.slice(0, 8)} · scantor`)
        await expect(page.getByText('sample of 100 analyses per stream', { exact: true })).toBeVisible()
        const ended = await expectRunEnded(page, api, run.id)
        const result = ended.result as { scan: string; analyses: number; files: number; resumed: boolean }
        expect(result).toMatchObject({ scan: scan.name, analyses: 2, resumed: false })
        expect(result.files).toBeGreaterThan(0)
        expect(ended.progress).toMatchObject({ done: 2, total: 2, message: `${result.files} files read` })
        expect(ended.outputs.map((output) => output.name).sort()).toEqual(['files.csv', 'summary.json'])
        expect(ended.checkpoint).not.toBeNull()

        // Progress, result, inputs and state.
        const progress = page.getByTestId('script-run-progress')
        await expect(progress).toContainText('2 / 2')
        await expect(progress).toContainText(`${result.files} files read`)
        await expect(page.getByTestId('script-run-result')).toContainText('analyses')
        await expect(page.getByTestId('script-run-result')).toContainText(scan.name!)
        const inputs = card(page, 'Inputs')
        await expect(inputs.getByRole('link', { name: scan.name!, exact: true })).toHaveAttribute('href', `/scans/${scan.id}`)
        await expect(definition(inputs, 'Secrets')).toHaveText('none')
        await expect(definition(inputs, 'Sample limit')).toHaveText('100')
        await expect(card(page, 'Code and state')).toContainText(`scripts/${script.id}:`)
        await expect(page.getByRole('button', { name: 'Cancel script run', exact: true })).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible()

        // The log: the image build, the script's output and platform notices, each with its stream.
        const log = page.getByTestId('script-run-log')
        await expect(log.getByText(/^build +\S/).first()).toBeVisible()
        await expect(log.getByText(new RegExp(`^stdout +report written analyses=2 files=${result.files}$`))).toBeVisible()

        // Outputs download through their presigned URLs.
        const summary = ended.outputs.find((output) => output.name === 'summary.json')!
        const outputs = page.getByTestId('script-run-outputs')
        const summaryLink = outputs.getByRole('link', { name: 'Download summary.json', exact: true })
        await expect(summaryLink).toHaveAttribute('href', `/api/script-runs/${run.id}/outputs/${summary.id}?redirect=true`)
        await expect(outputs.getByRole('link', { name: 'Download files.csv', exact: true })).toBeVisible()
        const downloaded = page.waitForEvent('download')
        await summaryLink.click()
        const file = await downloaded
        expect(file.suggestedFilename()).toBe('summary.json')
        expect(JSON.parse(await readFile(await file.path(), 'utf8'))).toMatchObject({ scan: scan.name, analyses: 2, files: result.files })

        // The snapshot the run was built from.
        const source = page.getByRole('link', { name: 'Download source', exact: true })
        await expect(source).toHaveAttribute('href', `/api/script-runs/${run.id}/source?redirect=true`)
        const sourceDownload = page.waitForEvent('download')
        await source.click()
        expect((await sourceDownload).suggestedFilename()).toBe(`${name}-${run.id.slice(0, 8)}.tar.gz`)

        // Back on the script: the history lists the run, and the code's config schema now drives the form.
        await runTitle(page).getByRole('link', { name: 'Back to the script' }).click()
        await expect(page).toHaveURL((url) => url.pathname === `/scripts/${script.id}` && url.searchParams.get('tab') === 'runs')
        const history = uTable(page, 'Script run history')
        const historyRow = row(history, run.id)
        await expect(badges(historyRow)).toHaveText('completed')
        await expect(historyRow).toContainText('sample of 100')
        await expect(historyRow).toContainText('2 / 2')
        await expect(historyRow.locator(`code[data-id="${ended.source.packSha256}"]`)).toBeVisible()
        await expect(schemaField(runForm(page), 'workers')).toBeVisible()
        await expect(badges(scriptTitle(page))).toHaveText('completed')
        await scriptTab(page, 'Overview').click()
        await expect(page.locator(`a[href="/scripts/${script.id}/runs/${run.id}"]`).first()).toBeVisible()
        await expect(uTable(page, 'Config schema')).toBeVisible()
      },
    )

    test(
      '"Run on all" passes secrets that are never shown; cancel, "Resume" and "Run again" start new runs of the folder',
      { tag: ['@UI-SCRIPT-004', '@UI-SCRIPT-005', '@UI-SCRIPT-006'] },
      async ({ page, api, user, openapi, uiScripts }) => {
        test.setTimeout(420_000)
        const scan = await filesScan(user, openapi)
        const script = await uiScripts.create({ name: unique('ticker'), files: { 'main.py': TICKER_MAIN } })
        const secret = `s3cr3t-${unique('value')}`

        // `?scan=` (the scan page's "Run script") preselects the scan.
        await gotoApp(page, `/scripts/${script.id}?tab=runs&scan=${scan.id}`)
        const form = runForm(page)
        await expect(form.getByText('1 of at most 20 scans selected')).toBeVisible()
        await expect(form.getByRole('button', { name: 'Scans', exact: true })).toContainText(scan.name!)
        await form.getByRole('button', { name: 'Add secret', exact: true }).click()
        const secretName = form.getByRole('textbox', { name: 'Name of secret 1' })
        await secretName.fill('api_token')
        await expect(secretName).toHaveValue('API_TOKEN')
        const secretValue = form.getByLabel('Value of API_TOKEN', { exact: true })
        await secretValue.fill(secret)
        await expect(secretValue).toHaveAttribute('type', 'password')
        await form.getByRole('button', { name: 'Show value of API_TOKEN', exact: true }).click()
        await expect(secretValue).toHaveAttribute('type', 'text')
        await expect(form.getByRole('button', { name: 'Remove API_TOKEN', exact: true })).toBeVisible()
        const { run: first, body } = await startFromForm(page, script, 'Run on all')
        expect(body).toEqual({ scans: [scan.id], config: {}, secrets: { API_TOKEN: secret } })
        expect(first.secrets).toEqual(['API_TOKEN'])
        expect(first.input.settings.limit).toBeNull()

        // While it runs: progress, the secret's name and its masked value, never the value itself.
        await expect
          .poll(
            async () => {
              const current = await getRun(api, first.id)
              return current.state === 'running' && current.checkpoint !== null && (current.progress?.done ?? 0) >= 2
            },
            { timeout: RUN_TIMEOUT, intervals: [1000, 2000], message: 'the first run ticks and saved a checkpoint' },
          )
          .toBe(true)
        await expect(runState(page)).toHaveText('running')
        await expect(page.getByTestId('script-run-progress')).toContainText('/ 600')
        await expect(definition(card(page, 'Inputs'), 'Secrets')).toHaveText('API_TOKEN')
        await expect(definition(card(page, 'Inputs'), 'Sample limit')).toHaveText('all analyses')
        const log = page.getByTestId('script-run-log')
        await expect(log.getByText('stdout secret API_TOKEN=***', { exact: true })).toBeVisible()
        await expect(log.getByText(/^stdout +tick 1$/)).toBeVisible()
        await expect(page.locator('body')).not.toContainText(secret)
        expect(await browserStorage(page)).not.toContain(secret)
        await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0)

        // "Cancel script run" confirms first.
        await page.getByRole('button', { name: 'Cancel script run', exact: true }).click()
        const confirmation = page.getByRole('dialog', { name: 'Cancel script run' })
        await expect(confirmation).toContainText('its checkpoint are kept')
        await confirmation.getByRole('button', { name: 'Cancel script run', exact: true }).click()
        await expect(runState(page)).toHaveText('cancelled')
        await expect(page.getByRole('button', { name: 'Cancel script run', exact: true })).toHaveCount(0)
        expect((await getRun(api, first.id)).state).toBe('cancelled')

        // "Resume" hands the checkpoint to a new run of the folder; the config is changed in the dialog.
        await page.getByRole('button', { name: 'Resume', exact: true }).click()
        let dialog = page.getByRole('dialog', { name: 'Resume script run' })
        await expect(dialog.getByText("The new run continues from this run's checkpoint", { exact: true })).toBeVisible()
        await setConfigJson(dialog, { seconds: 2 })
        const { run: resumed, body: resumeBody } = await restartFromDialog(page, dialog, 'Resume', first)
        expect(resumeBody).toEqual({ resume: true, config: { seconds: 2 } })
        expect(resumed).toMatchObject({ restartedFrom: { id: first.id, resume: true }, secrets: ['API_TOKEN'], scans: [{ id: scan.id }] })
        const resumedFrom = page.getByText(/^resumed from/)
        await expect(resumedFrom).toBeVisible()
        await expect(resumedFrom.getByRole('link', { name: first.id.slice(0, 8), exact: true })).toHaveAttribute(
          'href',
          `/scripts/${script.id}/runs/${first.id}`,
        )
        const resumedEnd = await expectRunEnded(page, api, resumed.id)
        const resumedResult = resumedEnd.result as { ticks: number; start: number }
        expect(resumedResult.start, 'the resumed run starts after the checkpoint').toBeGreaterThanOrEqual(1)
        expect(resumedResult.ticks).toBe(Math.max(2, resumedResult.start))
        await expect(page.getByTestId('script-run-log').getByText('stdout secret API_TOKEN=***', { exact: true })).toBeVisible()
        await expect(page.getByTestId('script-run-result')).toContainText('start')

        // "Run again" starts from scratch with the run's config and secrets.
        await page.getByRole('button', { name: 'Run again', exact: true }).click()
        dialog = page.getByRole('dialog', { name: 'Run script again' })
        await expect(dialog.getByRole('spinbutton', { name: 'Sample limit' })).toHaveValue('')
        const { run: again, body: againBody } = await restartFromDialog(page, dialog, 'Run again', resumed)
        expect(againBody).toEqual({ resume: false })
        expect(again).toMatchObject({ restartedFrom: { id: resumed.id, resume: false }, input: { config: { seconds: 2 } } })
        await expect(page.getByText(/^restarted from/)).toBeVisible()
        const againEnd = await expectRunEnded(page, api, again.id)
        expect(againEnd.result).toEqual({ ticks: 2, start: 0 })
        await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible()

        // The history shows every run; the resumed one is marked.
        await runTitle(page).getByRole('link', { name: 'Back to the script' }).click()
        const history = uTable(page, 'Script run history')
        await expect(badges(row(history, first.id))).toHaveText('cancelled')
        await expect(row(history, resumed.id)).toContainText('resumed')
        await expect(badges(row(history, again.id))).toHaveText('completed')
        await expect(row(history, again.id)).not.toContainText('resumed')
      },
    )

    test(
      'a failed run shows its build errors, or its error with the stack trace and the exit code',
      { tag: ['@UI-SCRIPT-007'] },
      async ({ page, api, user, openapi, uiScripts }) => {
        test.setTimeout(300_000)
        const scan = await filesScan(user, openapi)
        const [misnamed, failing] = await Promise.all([
          // The manifest names another script: the build fails at its static check.
          uiScripts.create({ name: unique('misnamed'), files: { 'scantor-script.yaml': `scantor: 1\nname: ${unique('other-name')}\nlanguage: python\n` } }),
          uiScripts.create({ name: unique('failing'), files: { 'main.py': FAILING_MAIN } }),
        ])
        const start = (script: Script) =>
          api.call<ScriptRun>('startScriptRun', { path: { script: script.id }, body: { scans: [scan.id] } }).then((r) => ok(r, 'startScriptRun'))
        const [misnamedRun, failingRun] = await Promise.all([start(misnamed), start(failing)])
        const [misnamedEnd, failingEnd] = await Promise.all([
          waitForScriptRun(api, misnamedRun.id, RUN_TIMEOUT),
          waitForScriptRun(api, failingRun.id, RUN_TIMEOUT),
        ])
        expect(misnamedEnd.state).toBe('failed')
        expect(
          misnamedEnd.errors.some((error) => error.phase === 'static' && error.file === 'scantor-script.yaml'),
          JSON.stringify(misnamedEnd.errors),
        ).toBe(true)
        expect(failingEnd, JSON.stringify({ errors: failingEnd.errors, logTail: failingEnd.logTail })).toMatchObject({
          state: 'failed',
          exitCode: 1,
          error: { type: 'scriptError' },
        })

        await gotoApp(page, `/scripts/${misnamed.id}/runs/${misnamedRun.id}`)
        await expect(runState(page)).toHaveText('failed')
        const buildErrors = page.getByTestId('build-errors')
        await expect(buildErrors).toContainText('static')
        await expect(buildErrors).toContainText('scantor-script.yaml')
        await expect(page.getByTestId('script-run-error')).toHaveCount(0)
        await expect(page.getByTestId('script-run-result')).toHaveCount(0)

        await gotoApp(page, `/scripts/${failing.id}/runs/${failingRun.id}`)
        await expect(runState(page)).toHaveText('failed')
        const error = page.getByTestId('script-run-error')
        await expect(error).toContainText('scriptError')
        await expect(error).toContainText('script failure marker')
        await error.getByRole('button', { name: 'Stack trace', exact: true }).click()
        const stack = page.getByRole('region', { name: 'Stack trace' })
        await expect(stack).toContainText('Traceback')
        await expect(stack).toContainText('ValueError')
        await expect(page.getByText('exit code 1', { exact: true })).toBeVisible()
        await expect(page.getByTestId('build-errors')).toHaveCount(0)
        await expect(page.getByTestId('script-run-outputs')).toContainText('The run stored no output files.')
      },
    )

    test(
      '"Run script" on a scan page searches the owner\'s scripts and opens the chosen script\'s run form with the scan',
      { tag: ['@UI-SCRIPT-008'] },
      async ({ page, user, openapi, uiScripts }) => {
        const scan = await filesScan(user, openapi)
        const script = await uiScripts.create({ name: unique('from-scan'), description: 'started from a scan page' })
        await openScanPage(page, scan.id)
        await page.getByRole('button', { name: 'Run script', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: 'Run script' })
        await expect(dialog).toContainText(`Choose a script to evaluate ${scan.name}.`)
        const search = dialog.getByRole('textbox', { name: 'Search scripts' })
        await search.fill(unique('nothing'))
        await expect(dialog.getByText('No script matches', { exact: true })).toBeVisible()
        await search.fill(script.name)
        const choice = dialog.getByRole('list', { name: 'Scripts' }).getByRole('link', { name: new RegExp(`^${script.name}`) })
        await expect(choice).toHaveAttribute('href', `/scripts/${script.id}?tab=runs&scan=${encodeURIComponent(scan.id)}`)
        await expect(choice).toContainText('started from a scan page')
        await choice.click()
        await expect(dialog).toBeHidden()
        await expect(page).toHaveURL(
          (url) => url.pathname === `/scripts/${script.id}` && url.searchParams.get('tab') === 'runs' && url.searchParams.get('scan') === scan.id,
        )
        const form = runForm(page)
        await expect(form.getByText('1 of at most 20 scans selected')).toBeVisible()
        await expect(form.getByRole('button', { name: 'Scans', exact: true })).toContainText(scan.name!)
      },
    )
  })
})

// ── the editor on a script folder ──────────────────────────────────────────────────────────────────────

// Real editors run only for fresh users (an editor is account-level state, docs/testing.md §9), with the requests of the
// dashboard and the editor sent from Node except their documents, like ui/editor.spec.ts.
const editorTest = base.extend({
  freshUserHandle: freshTenantHandle,
  context: nodeRouted({ documents: false, origins: [env.editorUrl] }),
})

/** code-server's workbench needs the image's first start; a cold start may take a minute. */
const EDITOR_START_MS = 90_000
const WORKSPACE_ROOT = '/home/coder/workspace'

/** Waits until the editor iframe shows code-server's workbench (reloading after a net::ERR_NETWORK_CHANGED, ui/editor.spec.ts). */
async function expectWorkbench(page: Page): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    let networkChanged = false
    const onFailed = (request: Request) => {
      if (request.url().startsWith(env.editorUrl) && request.failure()?.errorText.includes('ERR_NETWORK_CHANGED')) networkChanged = true
    }
    page.on('requestfailed', onFailed)
    try {
      await expect(page.locator('iframe[title="Editor"]')).toBeVisible({ timeout: EDITOR_START_MS })
      const workbench = page.frameLocator('iframe[title="Editor"]').locator('.monaco-workbench')
      await expect
        .poll(async () => networkChanged || (await workbench.isVisible()), { timeout: EDITOR_START_MS, message: 'the code-server workbench in the iframe' })
        .toBe(true)
      if (await workbench.isVisible()) return
    } finally {
      page.off('requestfailed', onFailed)
    }
    if (attempt >= 5) throw new Error('the editor iframe failed with net::ERR_NETWORK_CHANGED five times')
    await reloadPage(page)
  }
}

/** The folder code-server opened: the iframe's document once the one-time code was exchanged for the editor cookie. */
async function openedFolder(page: Page): Promise<string | null> {
  let folder: string | null = null
  await expect
    .poll(() => {
      const frame = page.frames().find((candidate) => candidate.url().startsWith(env.editorUrl) && !candidate.url().includes('/_auth'))
      folder = frame ? new URL(frame.url()).searchParams.get('folder') : null
      return frame ? new URL(frame.url()).pathname : null
    })
    .toBe('/')
  return folder
}

editorTest.describe('the editor on a script folder', () => {
  editorTest.use({ pageUser: 'fresh' })

  editorTest(
    '"Open in editor" of a script opens its folder below .scripts in code-server',
    { tag: ['@UI-EDIT-007', '@UI-SCRIPT-003'] },
    async ({ page, freshApi }) => {
      editorTest.setTimeout(180_000)
      const script = ok(await freshApi.call<Script>('createScript', { body: { name: unique('edit-script') } }), 'createScript')
      try {
        await openPage(page, `/scripts/${script.id}`)
        const session = page.waitForRequest((request) => isApi(request, 'POST', '/api/editor/session'))
        await page.getByRole('link', { name: 'Open in editor' }).first().click()
        await expect(page).toHaveURL((url) => url.pathname === '/editor' && url.searchParams.get('script') === script.name)
        expect((await session).postDataJSON()).toEqual({ openScript: script.name })
        await expectWorkbench(page)
        expect(await openedFolder(page)).toBe(`${WORKSPACE_ROOT}/.scripts/${script.name}`)
      } finally {
        await stopEditorAndWait(freshApi)
      }
    },
  )
})
