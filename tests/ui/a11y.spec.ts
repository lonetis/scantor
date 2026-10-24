import type { Locator, Page } from '@playwright/test'
import type { NodeWithToken } from '#shared/types/nodes'
import type { TestRun } from '#shared/types/test-runs'
import { ok } from '../helpers/api-client'
import {
  builtinNode,
  createUiTenant,
  createWorld,
  CRAWL_CONCURRENCY,
  domFacts,
  labelShape,
  mapConcurrently,
  namelessButtons,
  open,
  routeThroughPlaywright,
  probeTooltips,
  stopTenantEditor,
  tenantApi,
  tooltipMatches,
  uiPages,
  Viewers,
  visit,
  type DomFacts,
  type UiPage,
  type UiTenant,
  type UiWorld,
} from '../helpers/authz-ui'
import { deleteUser } from '../helpers/users'
import { expect, test as base, unique } from '../fixtures'

// Accessibility contract of the dashboard (docs/ui.md §11, docs/testing.md §8.2): every page of docs/ui.md §4 is
// crawled once per worker as a user, an admin or signed out, with a world of resources that makes the pages render
// their tables, forms, logs and badges. The crawl records the accessibility tree, the tables, the status badges, the
// test ids and the tooltips of icon-only buttons; the tests assert on those facts, and the interactive checks (menus,
// modals, slideovers, the wizard) drive the pages themselves.

interface PageReport {
  spec: UiPage
  /** why the page could not be crawled; the other fields are then empty */
  error?: string
  snapshot: string
  facts: DomFacts
  /** icon-only buttons and the tooltip each opens (null: none) */
  tooltips: { label: string; tooltip: string | null }[]
  /** native dialogs (alert, confirm, prompt) the page opened */
  dialogs: string[]
}

const NO_FACTS: DomFacts = { tables: [], badges: [], testIds: [], iconButtons: [] }

interface A11yWorker {
  uiTenant: UiTenant
  world: UiWorld
  crawl: PageReport[]
}

const test = base.extend<{ viewers: Viewers }, A11yWorker>({
  uiTenant: [
    async ({ adminApi, openapi }, use) => {
      const tenant = await createUiTenant(adminApi, openapi, 'a11y')
      await use(tenant)
      // The purge removes the world with the tenant (docs/data-model.md §5).
      await deleteUser(adminApi, tenant.id)
    },
    { scope: 'worker', timeout: 60_000 },
  ],
  world: [
    async ({ uiTenant, openapi }, use) => {
      const api = await tenantApi(uiTenant, openapi)
      try {
        await use(await createWorld(api, 'a11y', { sleep: true }))
      } finally {
        await api.request.dispose()
      }
    },
    { scope: 'worker', timeout: 180_000 },
  ],
  crawl: [
    async ({ browser, adminApi, openapi, uiTenant, world }, use) => {
      const node = await builtinNode(adminApi)
      const viewers = new Viewers(browser, uiTenant)
      try {
        const reports = await crawlAll(viewers, uiPages(world, uiTenant, node))
        await stopTenantEditor(uiTenant, openapi)
        await use(reports)
      } finally {
        await viewers.dispose()
      }
    },
    { scope: 'worker', timeout: 150_000 },
  ],
  // Pages of the tests run as this spec's own tenant, never as the shared per-worker fixture tenant.
  storageState: async ({ uiTenant }, use) => use(uiTenant.storageState),
  page: async ({ page }, use) => {
    await routeThroughPlaywright(page.context())
    await use(page)
    await page.context().unrouteAll({ behavior: 'ignoreErrors' })
  },
  viewers: async ({ browser, uiTenant }, use) => {
    const viewers = new Viewers(browser, uiTenant)
    await use(viewers)
    await viewers.dispose()
  },
})

// One worker runs the file's tests in order, so the world is built and the crawl happens once.
test.describe.configure({ mode: 'default' })

/**
 * Visits every page in a fresh tab, a few at a time, and records its facts. The tooltip of each label shape is probed
 * once per page and skipped on later pages once seen. A page that cannot be crawled is recorded with its error instead
 * of failing the fixture, so one broken page fails the route-map test and leaves the other tests their facts (a
 * failing fixture would rebuild the world for every test).
 */
async function crawlAll(viewers: Viewers, pages: UiPage[]): Promise<PageReport[]> {
  const probed = new Set<string>()
  return mapConcurrently(pages, CRAWL_CONCURRENCY, async (spec): Promise<PageReport> => {
    const page = await (await viewers.context(spec.viewer)).newPage()
    const dialogs: string[] = []
    page.on('dialog', (dialog) => {
      dialogs.push(`${dialog.type()}: ${dialog.message()}`)
      void dialog.dismiss()
    })
    try {
      await visit(page, spec)
      const snapshot = await page.locator('body').ariaSnapshot({ timeout: 10_000 })
      const facts = await domFacts(page)
      const shapes = new Set<string>()
      const probes = facts.iconButtons.filter((button) => {
        const shape = labelShape(button.label)
        if (probed.has(shape) || shapes.has(shape)) return false
        shapes.add(shape)
        return true
      })
      const tooltips = await probeTooltips(
        page,
        probes.map((button) => button.probe),
      )
      for (const tooltip of tooltips) probed.add(labelShape(tooltip.label))
      return { spec, snapshot, facts, tooltips, dialogs }
    } catch (error) {
      return { spec, error: String(error), snapshot: '', facts: NO_FACTS, tooltips: [], dialogs }
    } finally {
      await page.close()
    }
  })
}

/** Accessible names of interactive elements in an ARIA snapshot, by role. */
function namesIn(snapshot: string): { role: string; name: string }[] {
  const out: { role: string; name: string }[] = []
  for (const match of snapshot.matchAll(/^\s*- (button|link|menuitem|menuitemradio|menuitemcheckbox|radio|tab|switch|checkbox) "((?:[^"\\]|\\.)*)"/gm)) {
    out.push({ role: match[1]!, name: match[2]!.replace(/\\(.)/g, '$1') })
  }
  return out
}

const where = (report: PageReport) => `${report.spec.name} (${report.spec.path}, ${report.spec.viewer})`

/**
 * Every crawl-based test first checks that the crawl it reads is complete: a worker that replaced a failed one crawls
 * again, and a page missing from that crawl would otherwise show up as a confusing missing fact.
 */
function expectComplete(crawl: PageReport[]): void {
  expect(
    crawl.filter((r) => r.error).map((r) => `${where(r)}: ${r.error}`),
    'every page of the route map was crawled',
  ).toEqual([])
}

const row = (page: Page, id: string | number) => expect(page.locator(`tr[data-row-id="${id}"]`).first()).toBeVisible({ timeout: 20_000 })

/** The canonical names of docs/ui.md §11 rule 2; a name may be followed by its context (" for …", " of …"). */
const CANONICAL_NAMES = [
  'Refresh',
  'Open navigation',
  'Collapse sidebar',
  'Use system theme',
  'Use light theme',
  'Use dark theme',
  'Sign in',
  'Sign in with passkey',
  'Sign out',
  'New task',
  'New scan',
  'Open in editor',
  'Publish revision',
  'Start scan',
  'Pull from git',
  'Download workspace',
  'Delete task',
  'Start test run',
  'Cancel test run',
  'Pause scan',
  'Resume scan',
  'Scale scan',
  'Cancel scan',
  'Retry failed analyses',
  'Restart scan',
  'Delete scan',
  'Export results',
  'Scan actions',
  'Run query',
  'Show worker logs',
  'Follow log',
  'Edit as JSON',
  'Show value',
  'Add item',
  'Copy to clipboard',
  'Add node',
  'Node actions',
  'Rotate token',
  'Revoke token',
  'Create key',
  'Stop editor',
  'Approve',
  'Deny',
  'Read only',
  'Read and write',
  'Admin',
]

/** Tables whose rows lack data-row-id (the product bug of 'the rows of every table carry data-row-id'). */
const KNOWN_ROWS_WITHOUT_ID = /(^| )schema$|^Pending reasons$/

const hasName = (names: Set<string>, canonical: string) => [...names].some((name) => name === canonical || name.startsWith(`${canonical} `))

/** Expects that Tab never moves the focus out of the dialog (focus trap). */
async function expectFocusTrapped(page: Page, dialog: Locator, presses = 12): Promise<void> {
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press(i % 3 === 2 ? 'Shift+Tab' : 'Tab')
    expect(await dialog.evaluate((el) => el.contains(document.activeElement)), `focus stays in the dialog after ${i + 1} key presses`).toBe(true)
  }
}

/**
 * Closes the dialog with Escape. Escape dismisses the topmost layer first: when the focus trap left the focus on a
 * button whose tooltip is open, the first press closes the tooltip, so the key is pressed until the dialog is gone.
 */
async function closeWithEscape(page: Page, dialog: Locator): Promise<void> {
  await expect(async () => {
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden({ timeout: 1_000 })
  }).toPass({ timeout: 10_000 })
}

/** Fails on any native dialog the page opens (docs/ui.md §11 rule 7). */
function forbidNativeDialogs(page: Page): string[] {
  const dialogs: string[] = []
  page.on('dialog', (dialog) => {
    dialogs.push(`${dialog.type()}: ${dialog.message()}`)
    void dialog.dismiss()
  })
  return dialogs
}

test.describe('dashboard accessibility', () => {
  test('the crawl reached every page of the route map', { tag: ['@UI-NAV-023', '@UI-NAV-024', '@UI-NAV-025'] }, ({ crawl }) => {
    expectComplete(crawl)
    const paths = new Set(
      crawl.map((r) =>
        r.spec.path
          .split('?')[0]!
          .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')
          .replace(/\/revisions\/\d+$/, '/revisions/:n'),
      ),
    )
    expect([...paths].sort()).toEqual(
      [
        '/',
        '/account',
        '/account/access',
        '/account/credentials',
        '/admin/nodes',
        '/admin/nodes/:id',
        '/admin/tools',
        '/admin/users',
        '/editor',
        '/login',
        '/oauth/consent',
        '/scans',
        '/scans/:id',
        '/scans/new',
        '/setup',
        '/tasks',
        '/tasks/:id',
        '/tasks/:id/revisions/:n',
        '/tasks/new',
        '/templates',
      ].sort(),
    )
  })

  test('every button on every page has an accessible name', { tag: ['@UI-NAV-023'] }, ({ crawl }) => {
    expectComplete(crawl)
    const problems = crawl.flatMap((report) => namelessButtons(report.snapshot).map((line) => `${where(report)}: ${line.trim()}`))
    expect(problems).toEqual([])
    expect(crawl.reduce((n, report) => n + namesIn(report.snapshot).filter((x) => x.role === 'button').length, 0)).toBeGreaterThan(200)
  })

  test('the canonical icon-only controls show their name as tooltip', { tag: ['@UI-NAV-023'] }, ({ crawl }) => {
    expectComplete(crawl)
    const canonical = crawl.flatMap((report) =>
      report.tooltips
        .filter((t) => CANONICAL_NAMES.some((name) => t.label === name || t.label.startsWith(`${name} `)))
        .map((t) => ({ ...t, where: where(report) })),
    )
    expect(canonical.map((t) => t.label)).toEqual(expect.arrayContaining(['Refresh', 'Use dark theme', 'Follow log']))
    const mismatches = canonical
      .filter((t) => t.tooltip !== null && !tooltipMatches(t.label, t.tooltip))
      .map((t) => `${t.where}: aria-label "${t.label}", tooltip "${t.tooltip}"`)
    expect(mismatches).toEqual([])
    for (const name of ['Refresh', 'Use dark theme', 'Follow log'])
      expect(canonical.find((t) => t.label === name)?.tooltip, `the tooltip of ${name}`).toBe(name)
  })

  test('every icon-only button’s tooltip is its accessible name', { tag: ['@UI-NAV-023'] }, ({ crawl }) => {
    const mismatches = crawl.flatMap((report) =>
      report.tooltips
        .filter((t) => t.tooltip !== null && !tooltipMatches(t.label, t.tooltip))
        .map((t) => `${where(report)}: aria-label "${t.label}", tooltip "${t.tooltip}"`),
    )
    expect(mismatches).toEqual([])
  })

  test('every icon-only button has a tooltip with its name', { tag: ['@UI-NAV-023'] }, ({ crawl }) => {
    const missing = crawl.flatMap((report) => report.tooltips.filter((t) => t.tooltip === null).map((t) => `${where(report)}: ${t.label}`))
    expect(missing).toEqual([])
  })

  test('repeated controls carry their context in the name', { tag: ['@UI-NAV-023'] }, ({ crawl, world }) => {
    expectComplete(crawl)
    const names = (name: string) => new Set(namesIn(crawl.find((r) => r.spec.name === name)!.snapshot).map((x) => x.name))
    expect([...names('scans')]).toEqual(expect.arrayContaining([`Scan actions for ${world.scan.name}`, `Scan actions for ${world.pendingScan.name}`]))
    expect(
      [...names('users')].some((n) => /^User actions for \S+@\S+$/.test(n)),
      'User actions for <email>',
    ).toBe(true)
    expect(
      [...names('nodes')].some((n) => /^Node actions for \S/.test(n)),
      'Node actions for <name>',
    ).toBe(true)
    expect(
      [...names('scan workers')].some((n) => /^Show worker logs of \S/.test(n)),
      'Show worker logs of <id>',
    ).toBe(true)
    const form = [...names('task test')]
    expect(
      form.some((n) => /^Add item to \S/.test(n)),
      'Add item to <field>',
    ).toBe(true)
    expect(
      form.some((n) => /^Show value of \S/.test(n)),
      'Show value of <field>',
    ).toBe(true)
  })

  test('no two buttons in a table share a name', { tag: ['@UI-NAV-023'] }, ({ crawl }) => {
    const repeated = crawl.flatMap((report) =>
      report.facts.tables.flatMap((t) => t.repeatedButtons.map((b) => `${where(report)} table "${t.componentLabel}": ${b}`)),
    )
    expect(repeated).toEqual([])
  })

  test('every canonical control name of the contract exists', { tag: ['@UI-NAV-023'] }, async ({ crawl, viewers, adminApi, uiTenant, openapi, world }) => {
    test.setTimeout(150_000)
    expectComplete(crawl)
    const names = new Set(crawl.flatMap((report) => namesIn(report.snapshot).map((x) => x.name)))

    // The user menu holds "Sign out".
    const user = await (await viewers.context('user')).newPage()
    const dialogs = forbidNativeDialogs(user)
    await visit(user, crawl.find((r) => r.spec.name === 'overview')!.spec)
    await user.getByTestId('user-menu').click()
    for (const item of await user.getByRole('menuitem').allTextContents()) names.add(item.trim())
    await user.keyboard.press('Escape')

    // Below the lg breakpoint the sidebar is a drawer opened by "Open navigation".
    await user.setViewportSize({ width: 800, height: 900 })
    await expect(user.getByRole('button', { name: 'Open navigation' })).toBeVisible()
    names.add('Open navigation')
    await user.setViewportSize({ width: 1920, height: 1080 })

    // The upload step of the new-task wizard shows the pack command with the generic "Copy to clipboard".
    await open(user, '/tasks/new', (p) => expect(p.getByRole('button', { name: /^Upload a folder/ })).toBeVisible())
    await user.getByRole('button', { name: /^Upload a folder/ }).click()
    await expect(user.getByRole('button', { name: 'Copy to clipboard', exact: true })).toBeVisible()
    names.add('Copy to clipboard')

    // A running test run offers "Cancel test run" (the sleep example sleeps for an hour).
    const api = await tenantApi(uiTenant, openapi)
    try {
      const sleep = world.sleep!
      const run = ok(
        await api.call<TestRun>('testTask', { path: { task: sleep.task.id }, body: { taskConfig: { seconds: 3600 }, scanConfig: { times: 1 }, limit: 1 } }),
        'testTask',
      )
      await open(user, `/tasks/${sleep.task.id}?tab=test`, (p) => row(p, run.id))
      await user.locator(`tr[data-row-id="${run.id}"]`).click()
      const cancel = user.getByRole('button', { name: 'Cancel test run' })
      await expect(cancel).toBeVisible({ timeout: 30_000 })
      names.add('Cancel test run')
      await cancel.click()
      await expect
        .poll(async () => ok(await api.call<TestRun>('getTestRun', { path: { testRunId: run.id } }), 'getTestRun').state, { timeout: 60_000 })
        .toBe('cancelled')
    } finally {
      await api.request.dispose()
    }
    await user.close()

    // The node menu of a node holds "Rotate token" and "Revoke token"; the consent page offers "Admin" to admins.
    const created = ok(await adminApi.call<NodeWithToken>('createNode', { body: { name: unique('a11y-node'), pool: unique('a11y') } }), 'createNode')
    const admin = await (await viewers.context('admin')).newPage()
    dialogs.push(...forbidNativeDialogs(admin))
    try {
      const nodeMenu = admin.getByRole('button', { name: `Node actions for ${created.node.name}` })
      await open(admin, '/admin/nodes', () => expect(nodeMenu).toBeVisible({ timeout: 20_000 }), 'admin')
      await nodeMenu.click()
      for (const item of await admin.getByRole('menuitem').allTextContents()) names.add(item.trim())
      await admin.keyboard.press('Escape')
      const consent = `/oauth/consent?${new URLSearchParams({ client_id: 'authz-ui-unknown', scope: 'offline_access scantor:read scantor:write scantor:admin', redirect_uri: 'http://127.0.0.1:53682/callback' })}`
      await open(admin, consent, (p) => expect(p.getByRole('radio', { name: 'Admin', exact: true })).toBeAttached(), 'admin')
      for (const level of ['Read only', 'Read and write', 'Admin']) {
        await expect(admin.getByRole('radio', { name: level, exact: true })).toBeAttached()
        names.add(level)
      }
    } finally {
      await admin.close()
      await adminApi.deleteNode(created.node.id)
    }

    expect(CANONICAL_NAMES.filter((name) => !hasName(names, name))).toEqual([])
    expect(dialogs).toEqual([])
  })

  test('tables are labelled and the rows of resource tables carry data-row-id', { tag: ['@UI-NAV-024'] }, ({ crawl }) => {
    expectComplete(crawl)
    const tables = crawl.flatMap((report) => report.facts.tables.map((t) => ({ ...t, where: where(report) })))
    expect(tables.length).toBeGreaterThan(15)
    expect(
      tables.filter((t) => !t.componentLabel).map((t) => t.where),
      'tables without an aria-label',
    ).toEqual([])
    // The tables of resources (tasks, revisions, test runs, scans, analyses, exports, workers, nodes, users, keys, …).
    // The schema tables and the pending reasons, which lack the attribute, are the product bug of the next test.
    const resources = tables.filter((t) => !KNOWN_ROWS_WITHOUT_ID.test(t.componentLabel ?? ''))
    expect([...new Set(resources.map((t) => t.componentLabel))]).toEqual(
      expect.arrayContaining(['Tasks', 'Revisions', 'Test run history', 'Analyses', 'Exports', 'Workers', 'Nodes', 'Users', 'API keys']),
    )
    expect(resources.filter((t) => t.rowsWithoutId > 0).map((t) => `${t.where} "${t.componentLabel}": ${t.rowsWithoutId} of ${t.dataRows} rows`)).toEqual([])
    expect(
      resources.reduce((n, t) => n + t.dataRows, 0),
      'the crawl saw rows of resource tables',
    ).toBeGreaterThan(20)
  })

  test('the rows of every table carry data-row-id', { tag: ['@UI-NAV-024'] }, ({ crawl }) => {
    const tables = crawl.flatMap((report) => report.facts.tables.map((t) => ({ ...t, where: where(report) })))
    expect(tables.filter((t) => t.rowsWithoutId > 0).map((t) => `${t.where} "${t.componentLabel}": ${t.rowsWithoutId} of ${t.dataRows} rows`)).toEqual([])
  })

  test('every table exposes its label as accessible name', { tag: ['@UI-NAV-024'] }, ({ crawl }) => {
    const unnamed = crawl.flatMap((report) => report.facts.tables.filter((t) => t.name === '').map((t) => `${where(report)}: "${t.componentLabel}"`))
    expect(unnamed).toEqual([])
  })

  test('the documented test ids exist', { tag: ['@UI-NAV-024'] }, ({ crawl }) => {
    expectComplete(crawl)
    const ids = new Set(crawl.flatMap((report) => report.facts.testIds))
    // `test-run-log` and `secret-reveal` appear only after an interaction: the next test opens them.
    const documented = [
      'scan-progress',
      'scan-stats',
      'scan-health',
      'condition-workersPending',
      'build-log',
      'build-errors',
      'analysis-slideover',
      'unpublished-badge',
    ]
    expect(documented.filter((id) => !ids.has(id))).toEqual([])
  })

  test(
    'the test-run log, its analysis slideover and the secret reveal carry their test ids',
    { tag: ['@UI-NAV-024', '@UI-NAV-025'] },
    async ({ page, world, uiTenant, openapi }) => {
      const dialogs = forbidNativeDialogs(page)
      await open(page, `/tasks/${world.zoo.task.id}?tab=test`, (p) => row(p, world.zooTestRun.id))
      await page.locator(`tr[data-row-id="${world.zooTestRun.id}"]`).click()
      await expect(page.getByTestId('test-run-log')).toBeVisible()
      await page.locator('[aria-label="Test run analyses"] tbody tr[data-row-id]').first().click()
      const slideover = page.getByRole('dialog')
      await expect(slideover.getByTestId('analysis-slideover')).toBeVisible()
      await expect(slideover).toHaveAccessibleName(/^Analysis \d+$/)
      await expectFocusTrapped(page, slideover)
      await closeWithEscape(page, slideover)
      expect(await page.evaluate(() => document.activeElement?.isConnected && !document.activeElement.closest('[role="dialog"]'))).toBe(true)

      // A new API key is revealed once in the secret-reveal modal.
      const create = page.getByRole('button', { name: 'Create key' })
      await open(page, '/account/access', () => expect(create).toBeVisible())
      await create.click()
      const dialog = page.getByRole('dialog', { name: 'Create API key' })
      await expect(dialog).toBeVisible()
      const keyName = unique('a11y-key').slice(0, 32)
      await dialog.getByLabel('Name').fill(keyName)
      await dialog.getByRole('button', { name: 'Create API key' }).click()
      const reveal = page.getByTestId('secret-reveal')
      await expect(reveal).toBeVisible()
      await page.getByRole('button', { name: 'Done' }).click()
      await expect(reveal).toBeHidden()
      const api = await tenantApi(uiTenant, openapi)
      try {
        const keys = ok(await api.call<{ items: { id: string; name: string }[] }>('listApiKeys'), 'listApiKeys').items
        const key = keys.find((k) => k.name === keyName)
        expect(key, 'the key was created').toBeTruthy()
        ok(await api.call('deleteApiKey', { path: { keyId: key!.id } }), 'deleteApiKey')
      } finally {
        await api.request.dispose()
      }
      expect(dialogs).toEqual([])
    },
  )

  test('status badges always show their state as text', { tag: ['@UI-NAV-025'] }, ({ crawl }) => {
    expectComplete(crawl)
    const badges = crawl.flatMap((report) => report.facts.badges.map((b) => ({ ...b, where: where(report) })))
    expect([...new Set(badges.map((b) => b.state))]).toEqual(expect.arrayContaining(['completed', 'ready', 'failed', 'succeeded', 'online', 'pending']))
    expect(badges.filter((b) => !b.text.includes(b.state)).map((b) => `${b.where}: data-state ${b.state}, text "${b.text}"`)).toEqual([])
  })

  test('no page opens a native dialog', { tag: ['@UI-NAV-025'] }, ({ crawl }) => {
    expectComplete(crawl)
    expect(crawl.flatMap((report) => report.dialogs.map((d) => `${where(report)}: ${d}`))).toEqual([])
  })

  test('modals have a title, trap the focus and return it to their trigger', { tag: ['@UI-NAV-025'] }, async ({ page, world }) => {
    const dialogs = forbidNativeDialogs(page)

    // "Create key" on the access page.
    const create = page.getByRole('button', { name: 'Create key' })
    await open(page, '/account/access', () => expect(create).toBeVisible())
    await create.click()
    let dialog = page.getByRole('dialog', { name: 'Create API key' })
    await expect(dialog).toBeVisible()
    await expectFocusTrapped(page, dialog)
    await closeWithEscape(page, dialog)
    await expect(create).toBeFocused()

    // "Scale scan" on the pending scan.
    const scale = page.getByRole('button', { name: 'Scale scan' })
    await open(page, `/scans/${world.pendingScan.id}`, () => expect(scale).toBeEnabled({ timeout: 20_000 }))
    await scale.click()
    dialog = page.getByRole('dialog', { name: 'Scale scan' })
    await expect(dialog).toBeVisible()
    await expectFocusTrapped(page, dialog)
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toBeHidden()
    await expect(scale).toBeFocused()

    // A confirmation names its action ("Delete task", never "OK") and cancelling keeps the task.
    const remove = page.getByRole('button', { name: 'Delete task' })
    await open(page, `/tasks/${world.draft.id}`, () => expect(remove).toBeVisible())
    await remove.click()
    dialog = page.getByRole('dialog')
    await expect(dialog).toHaveAccessibleName(/\S/)
    await expect(dialog.getByRole('button', { name: 'Delete task', exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: /^(OK|Yes|Confirm)$/i })).toHaveCount(0)
    await expectFocusTrapped(page, dialog)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(remove).toBeFocused()
    await expect(page.getByTestId('unpublished-badge').first()).toBeVisible()

    // The analysis slideover of the results.
    await open(page, `/scans/${world.scan.id}?tab=results`, (p) => row(p, world.analysis.seq))
    await page.locator(`tr[data-row-id="${world.analysis.seq}"]`).click()
    const slideover = page.getByRole('dialog')
    await expect(slideover.getByTestId('analysis-slideover')).toBeVisible()
    await expect(slideover).toHaveAccessibleName(/\S/)
    await expectFocusTrapped(page, slideover)
    await closeWithEscape(page, slideover)
    expect(await page.evaluate(() => document.activeElement?.isConnected && !document.activeElement.closest('[role="dialog"]'))).toBe(true)
    expect(dialogs).toEqual([])
  })

  // product bug: the stepper's status reads "Step 0 of 4" on the first step and "Step 3 of 4" on the last
  test.fail(
    'the new-task wizard announces the position of the current step',
    {
      tag: ['@UI-NAV-026'],
      annotation: {
        type: 'issue',
        description:
          'UStepper passes a zero-based index to reka-ui StepperRoot, whose status reads "Step <modelValue> of <count>" for one-based steps: "Step 0 of 4" on step 1, "Step 3 of 4" on step 4',
      },
    },
    async ({ page }) => {
      const stepper = page.getByRole('group', { name: 'progress' })
      await open(page, '/tasks/new', () => expect(stepper.getByRole('status')).toBeAttached())
      const expectStep = async (position: number, title: string) => {
        await expect(stepper.locator('[aria-current="true"]')).toContainText(title)
        // The status is rendered with the step: a wrong text does not change later.
        await expect(stepper.getByRole('status')).toHaveText(`Step ${position} of 4`, { timeout: 2_000 })
      }
      await expectStep(1, 'Source')
      await page.getByRole('button', { name: /^From a scaffold/ }).click()
      await expectStep(2, 'Language')
      await page.getByRole('list', { name: 'Languages' }).getByRole('button').first().click()
      await expectStep(3, 'Template')
      await page.getByRole('button', { name: 'Use a custom schedule' }).click()
      await expectStep(4, 'Name')
    },
  )

  test('the wizard stepper marks the current step', { tag: ['@UI-NAV-026'] }, async ({ page }) => {
    const stepper = page.getByRole('group', { name: 'progress' })
    await open(page, '/tasks/new', () => expect(stepper.getByRole('status')).toBeAttached())
    // A polite live region announces the step change (its number is the product bug above).
    await expect(stepper.getByRole('status')).toHaveAttribute('aria-live', 'polite')
    await expect(stepper.getByRole('status')).toHaveText(/^\s*Step \d of 4\s*$/)
    await expect(stepper.locator('[aria-current="true"]')).toHaveCount(1)
    await expect(stepper.locator('[aria-current="true"]')).toContainText('Source')
    await page.getByRole('button', { name: /^From a scaffold/ }).click()
    await expect(stepper.locator('[aria-current="true"]')).toHaveCount(1)
    await expect(stepper.locator('[aria-current="true"]')).toContainText('Language')
    await expect(stepper.getByRole('button', { name: 'Language' })).toBeVisible()
  })
})
