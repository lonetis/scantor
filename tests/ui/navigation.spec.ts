import type { Locator, Page } from '@playwright/test'
import { ok } from '../helpers/api-client'
import { expectToast } from '../helpers/ui'
import {
  cancelScanAndWait,
  createCredential,
  createScaffoldTask,
  deleteCredentialsNamed,
  expectToastAnywhere,
  fulfillError,
  fulfillJson,
  isApiRequest,
  openPage,
  recordApiRequests,
  reloadPage,
  setVisibility,
  startUnplacedScan,
  nodeRoutedContext,
  workerTenant,
} from '../helpers/ui-shell-tasks'
import { expect, test as base, unique } from '../fixtures'

// The worker's tenant under a session file of its own, and the dashboard's requests sent from Node (helpers/ui-shell-tasks.ts).
const test = base.extend({ user: [workerTenant, { scope: 'worker' }], context: nodeRoutedContext })

// The dashboard shell (docs/ui.md §3, §8–§11, §14): sidebar items and badges, collapse, resize and the mobile drawer,
// the user menu, page titles, the theme, the admin guard, error toasts, polling and the live-updates banner, copy
// buttons and formatting, type-to-confirm dialogs and the UI preferences in localStorage.

const SIDEBAR = '#scantor-dashboard-sidebar-main'
/** The sidebar badges' poll interval (composables/useSidebarCounts.ts). */
const SIDEBAR_POLL_MS = 15_000

/** The wordmark (components/AppLogo.vue): the sidebar's brand while it is expanded; the collapsed S is decorative. */
function wordmark(page: Page): Locator {
  return page.locator(SIDEBAR).getByRole('img', { name: 'scantor', exact: true })
}

function mainNavigation(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Main navigation' })
}

function sidebarLink(page: Page, name: string): Locator {
  return mainNavigation(page).getByRole('link', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) })
}

function openToasts(page: Page): Locator {
  return page.getByRole('region', { name: /notifications/i }).locator('li[data-state="open"]')
}

/** The rendered width of the sidebar in px. */
async function sidebarWidth(page: Page): Promise<number> {
  return page.locator(SIDEBAR).evaluate((element) => element.getBoundingClientRect().width)
}

async function dragSidebarHandle(page: Page, deltaX: number): Promise<void> {
  const handle = page.locator(`[role="separator"][aria-controls="${SIDEBAR.slice(1)}"]`)
  const box = await handle.boundingBox()
  if (!box) throw new Error('the sidebar resize handle is not visible')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + deltaX / 2, y, { steps: 5 })
  await page.mouse.move(x + deltaX, y, { steps: 5 })
  await page.mouse.up()
}

test.describe('sidebar of a user', () => {
  test('shows the Workspace and Access groups but no Admin group', { tag: ['@UI-NAV-001'] }, async ({ page }) => {
    await openPage(page, '/')
    const nav = mainNavigation(page)
    await expect(nav.getByText('Workspace', { exact: true })).toBeVisible()
    await expect(nav.getByText('Access', { exact: true })).toBeVisible()
    for (const [name, path] of [
      ['Overview', '/'],
      ['Tasks', '/tasks'],
      ['Scans', '/scans'],
      ['Templates', '/templates'],
      ['Editor', '/editor'],
      ['CLI & MCP access', '/account/access'],
      ['Git credentials', '/account/credentials'],
    ]) {
      await expect(sidebarLink(page, name!)).toHaveAttribute('href', path!)
    }
    await expect(nav.getByText('Admin', { exact: true })).toHaveCount(0)
    for (const name of ['Nodes', 'Users', 'Admin tools']) await expect(sidebarLink(page, name)).toHaveCount(0)
  })

  test(
    '"New scan" and "New task" open their forms, also as icon buttons of the collapsed sidebar',
    { tag: ['@UI-NAV-003', '@UI-NAV-007'] },
    async ({ page }) => {
      await openPage(page, '/')
      const sidebar = page.locator(SIDEBAR)
      await sidebar.getByRole('link', { name: 'New task', exact: true }).click()
      await expect(page).toHaveURL(/\/tasks\/new$/)
      await sidebar.getByRole('link', { name: 'New scan', exact: true }).click()
      await expect(page).toHaveURL(/\/scans\/new$/)

      await openPage(page, '/')
      await expect(wordmark(page)).toBeVisible()
      await page.getByRole('button', { name: 'Collapse sidebar' }).click()
      await expect(sidebar).toHaveAttribute('data-collapsed', 'true')
      await expect(wordmark(page)).toHaveCount(0)
      await expect(sidebar.getByRole('link', { name: 'scantor overview' })).toHaveAttribute('href', '/')

      const newScan = sidebar.getByRole('link', { name: 'New scan', exact: true })
      const newTask = sidebar.getByRole('link', { name: 'New task', exact: true })
      await expect(newScan).toHaveText('')
      await expect(newTask).toHaveText('')
      await newTask.hover()
      await expect(page.getByRole('tooltip')).toHaveText('New task')
      await newTask.click()
      await expect(page).toHaveURL(/\/tasks\/new$/)
      // The open tooltip stays while the pointer rests on its trigger: move away and let it close first.
      await page.mouse.move(900, 500)
      await expect(page.getByRole('tooltip')).toHaveCount(0)
      await newScan.hover()
      await expect(page.getByRole('tooltip')).toHaveText('New scan')
      await newScan.click()
      await expect(page).toHaveURL(/\/scans\/new$/)

      // The collapse state survives a reload; expanding is remembered too.
      await reloadPage(page)
      await expect(sidebar).toHaveAttribute('data-collapsed', 'true')
      await page.getByRole('button', { name: 'Expand sidebar' }).click()
      await expect(sidebar).toHaveAttribute('data-collapsed', 'false')
      await expect(wordmark(page)).toBeVisible()
      await reloadPage(page)
      await expect(sidebar).toHaveAttribute('data-collapsed', 'false')
      await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible()
    },
  )

  test('the sidebar resizes between 14 and 24 rem, keeps its size and shows the wordmark in full at 1280 px', { tag: ['@UI-NAV-007'] }, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openPage(page, '/')
    const rem = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize))
    await expect.poll(() => sidebarWidth(page)).toBeCloseTo(16 * rem, 0)
    const brand = wordmark(page)
    await expect(brand).toBeVisible()
    // Full size: the box keeps the artwork's aspect ratio, so the header did not squeeze it (object-contain would
    // draw it smaller inside a narrower box).
    expect(
      await brand.evaluate((img: HTMLImageElement) => Math.abs(img.clientWidth - (img.clientHeight * img.naturalWidth) / img.naturalHeight) <= 1),
    ).toBe(true)

    await dragSidebarHandle(page, 300)
    await expect.poll(() => sidebarWidth(page)).toBeCloseTo(24 * rem, 0)
    await reloadPage(page)
    await expect.poll(() => sidebarWidth(page)).toBeCloseTo(24 * rem, 0)

    // Below the minimum (but above the collapse threshold) the width stops at 14 rem.
    await dragSidebarHandle(page, -(24 - 11) * rem)
    await expect(page.locator(SIDEBAR)).toHaveAttribute('data-collapsed', 'false')
    await expect.poll(() => sidebarWidth(page)).toBeCloseTo(14 * rem, 0)
    await reloadPage(page)
    await expect.poll(() => sidebarWidth(page)).toBeCloseTo(14 * rem, 0)
  })

  test(
    'the shell links the favicons and the manifest, and the wordmark follows the color mode',
    { tag: ['@UI-NAV-030'] },
    async ({ page, anonApi }) => {
      await openPage(page, '/')
      const hrefs = await page
        .locator('head link[rel="icon"], head link[rel="apple-touch-icon"], head link[rel="manifest"]')
        .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''))
      expect(hrefs).toEqual(['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png', '/site.webmanifest'])
      // Served from brand/favicons without a session, like the icons the manifest names.
      const manifest = await anonApi.request.get('/site.webmanifest')
      expect(manifest.status()).toBe(200)
      const { name, icons } = (await manifest.json()) as { name: string; icons: Array<{ src: string }> }
      expect(name).toBe('scantor')
      for (const href of [...hrefs, ...icons.map((icon) => icon.src)]) {
        expect((await anonApi.request.get(href)).status(), href).toBe(200)
      }

      const brand = wordmark(page)
      await expect(brand).toBeVisible()
      const darkSource = await brand.getAttribute('src')
      await page.getByRole('button', { name: 'Use light theme' }).click()
      await expect(brand).not.toHaveAttribute('src', darkSource ?? '')
      await expect.poll(() => brand.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)

      await page.getByRole('button', { name: 'Collapse sidebar' }).click()
      await expect(page.locator(SIDEBAR).getByTestId('scantor-logo')).toHaveAttribute('data-variant', 'mark')
      await page.getByRole('button', { name: 'Expand sidebar' }).click()
      await expect(brand).toBeVisible()
    },
  )

  test('below the lg breakpoint the sidebar is a drawer', { tag: ['@UI-NAV-008'] }, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 })
    await openPage(page, '/tasks')
    await expect(page.locator(SIDEBAR)).toBeHidden()
    await page.getByRole('button', { name: 'Open navigation' }).click()
    const drawer = page.getByRole('dialog')
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: /^Templates/ })).toBeVisible()
    await drawer.getByRole('button', { name: 'Close navigation' }).click()
    await expect(drawer).toBeHidden()

    await page.getByRole('button', { name: 'Open navigation' }).click()
    await page
      .getByRole('dialog')
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: /^Templates/ })
      .click()
    await expect(page).toHaveURL(/\/templates$/)
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('"API docs" opens /api/docs in a new tab', { tag: ['@UI-NAV-006'] }, async ({ page }) => {
    await openPage(page, '/')
    const link = page.getByRole('navigation', { name: 'Documentation' }).getByRole('link', { name: /API docs/ })
    await expect(link).toHaveAttribute('href', '/api/docs')
    await expect(link).toHaveAttribute('target', '_blank')
    const [docs] = await Promise.all([page.context().waitForEvent('page'), link.click()])
    await docs.waitForLoadState('domcontentloaded')
    expect(new URL(docs.url()).pathname).toBe('/api/docs')
    await docs.close()
  })

  test('every page title is "<Page> · scantor", and a task page uses the task name', { tag: ['@UI-NAV-010'] }, async ({ page, api, tasks }) => {
    for (const [path, title] of [
      ['/', 'Overview · scantor'],
      ['/tasks', 'Tasks · scantor'],
      ['/tasks/new', 'New task · scantor'],
      ['/scans', 'Scans · scantor'],
      ['/scans/new', 'New scan · scantor'],
      ['/templates', 'Templates · scantor'],
      ['/account', 'Account · scantor'],
      ['/account/access', 'CLI & MCP access · scantor'],
      ['/account/credentials', 'Git credentials · scantor'],
    ]) {
      await openPage(page, path!)
      await expect(page).toHaveTitle(title!)
    }
    const name = unique('title')
    tasks.track(name)
    const task = await createScaffoldTask(api, name)
    await openPage(page, `/tasks/${task.id}`)
    await expect(page).toHaveTitle(`${name} · scantor`)
  })

  test('the theme toggle switches system, light and dark; dark is the default and the choice persists', { tag: ['@UI-NAV-011'] }, async ({ page }) => {
    await openPage(page, '/')
    const html = page.locator('html')
    const system = page.getByRole('button', { name: 'Use system theme' })
    const light = page.getByRole('button', { name: 'Use light theme' })
    const dark = page.getByRole('button', { name: 'Use dark theme' })
    await expect(html).toHaveClass(/\bdark\b/)
    await expect(dark).toHaveAttribute('aria-pressed', 'true')
    await expect(light).toHaveAttribute('aria-pressed', 'false')
    await expect(system).toHaveAttribute('aria-pressed', 'false')

    await light.click()
    await expect(html).not.toHaveClass(/\bdark\b/)
    await expect(light).toHaveAttribute('aria-pressed', 'true')
    await expect(dark).toHaveAttribute('aria-pressed', 'false')
    await reloadPage(page)
    await expect(page.getByRole('button', { name: 'Use light theme' })).toHaveAttribute('aria-pressed', 'true')
    await expect(html).not.toHaveClass(/\bdark\b/)

    await page.emulateMedia({ colorScheme: 'dark' })
    await page.getByRole('button', { name: 'Use system theme' }).click()
    await expect(page.getByRole('button', { name: 'Use system theme' })).toHaveAttribute('aria-pressed', 'true')
    await expect(html).toHaveClass(/\bdark\b/)
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(html).not.toHaveClass(/\bdark\b/)
    await reloadPage(page)
    await expect(page.getByRole('button', { name: 'Use system theme' })).toHaveAttribute('aria-pressed', 'true')

    await page.getByRole('button', { name: 'Use dark theme' }).click()
    await expect(html).toHaveClass(/\bdark\b/)
    await reloadPage(page)
    await expect(page.getByRole('button', { name: 'Use dark theme' })).toHaveAttribute('aria-pressed', 'true')
  })

  for (const path of ['/admin/nodes', '/admin/nodes/00000000-0000-4000-8000-000000000000', '/admin/users', '/admin/tools']) {
    test(`a non-admin opening ${path} is sent to / with "Admins only"`, { tag: ['@UI-NAV-014'] }, async ({ page }) => {
      await openPage(page, path)
      await expect(page).toHaveURL((url) => url.pathname === '/')
      await expectToast(page, 'Admins only')
      await expect(page).toHaveTitle('Overview · scantor')
    })
  }
})

test.describe('sidebar of an admin', () => {
  test.use({ role: 'admin' })

  test('adds the Admin group with Nodes, Users and Admin tools', { tag: ['@UI-NAV-001'] }, async ({ page }) => {
    await openPage(page, '/')
    const nav = mainNavigation(page)
    await expect(nav.getByText('Admin', { exact: true })).toBeVisible()
    for (const [name, path] of [
      ['Overview', '/'],
      ['Tasks', '/tasks'],
      ['Scans', '/scans'],
      ['Templates', '/templates'],
      ['CLI & MCP access', '/account/access'],
      ['Git credentials', '/account/credentials'],
      ['Nodes', '/admin/nodes'],
      ['Users', '/admin/users'],
      ['Admin tools', '/admin/tools'],
    ]) {
      await expect(sidebarLink(page, name!)).toHaveAttribute('href', path!)
    }
  })

  test('admin page titles use the page and the node name', { tag: ['@UI-NAV-010'] }, async ({ page, adminApi }) => {
    for (const [path, title] of [
      ['/admin/nodes', 'Nodes · scantor'],
      ['/admin/users', 'Users · scantor'],
      ['/admin/tools', 'Admin tools · scantor'],
    ]) {
      await openPage(page, path!)
      await expect(page).toHaveTitle(title!)
    }
    const builtin = ok(await adminApi.listNodes(), 'listNodes').items.find((node) => node.builtIn)
    expect(builtin, 'the built-in node exists').toBeDefined()
    await openPage(page, `/admin/nodes/${builtin!.id}`)
    await expect(page).toHaveTitle(`${builtin!.name} · scantor`)
  })

  test('the Nodes badge counts offline nodes in the error color and is hidden at 0', { tag: ['@UI-NAV-005'] }, async ({ page, adminApi }) => {
    // Shared nodes must stay online (docs/testing.md §9), so the offline list of the sidebar poll is answered here.
    const nodes = ok(await adminApi.listNodes(), 'listNodes').items
    let offline: unknown[] = []
    await page.route(
      (url) => url.pathname === '/api/nodes' && url.searchParams.get('state') === 'offline',
      (route) => fulfillJson(route, { items: offline }),
    )
    // The sidebar polls every 15 s; the fake clock runs the next poll at once.
    await page.clock.install()
    await openPage(page, '/')
    const nodesLink = sidebarLink(page, 'Nodes')
    await expect(nodesLink).toBeVisible()
    await expect(nodesLink).toHaveText(/^Nodes$/)

    offline = nodes.slice(0, 2).map((node) => ({ ...node, state: 'offline' }))
    await page.clock.runFor(SIDEBAR_POLL_MS)
    await expect(nodesLink).toHaveText(/^Nodes\s*2$/)
    const badge = nodesLink.getByText('2', { exact: true }).locator('xpath=ancestor::*[contains(@class, "rounded")][1]')
    await expect(badge).toHaveClass(/text-error/)

    offline = []
    await page.clock.runFor(SIDEBAR_POLL_MS)
    await expect(nodesLink).toHaveText(/^Nodes$/)
  })
})

test.describe('Scans badge', () => {
  test('counts the own active scans, shows 200+ for a full page and is hidden at 0', { tag: ['@UI-NAV-004'] }, async ({ page }) => {
    // The sidebar's query: the caller's creating, running and paused scans, at most one page of 200.
    let active: number | 'full' = 0
    const seen: URL[] = []
    await page.route(
      (url) => url.pathname === '/api/scans' && url.searchParams.has('userId') && url.searchParams.get('limit') === '200',
      (route) => {
        seen.push(new URL(route.request().url()))
        const count = active === 'full' ? 200 : active
        const items = Array.from({ length: count }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` }))
        return fulfillJson(route, { items, nextCursor: active === 'full' ? 'next-page' : null })
      },
    )
    // The sidebar polls every 15 s; the fake clock runs the next poll at once.
    await page.clock.install()
    await openPage(page, '/tasks')
    const scansLink = sidebarLink(page, 'Scans')
    await expect(scansLink).toBeVisible()
    await expect.poll(() => seen.length).toBeGreaterThan(0)
    expect(seen[0]!.searchParams.get('state')).toBe('creating,running,paused')
    await expect(scansLink).toHaveText(/^Scans$/)

    for (const [count, label] of [
      [3, '3'],
      ['full', '200+'],
    ] as const) {
      active = count
      const polls = seen.length
      await page.clock.runFor(SIDEBAR_POLL_MS)
      await expect.poll(() => seen.length).toBeGreaterThan(polls)
      await expect(scansLink).toHaveText(new RegExp(`^Scans\\s*${label.replace('+', '\\+')}$`))
    }
    active = 0
    await page.clock.runFor(SIDEBAR_POLL_MS)
    await expect(scansLink).toHaveText(/^Scans$/)
  })

  test(
    'a running scan of the user shows in the badge, its page title and inline query errors; the badge clears after it ends',
    { tag: ['@UI-NAV-004', '@UI-NAV-010', '@UI-NAV-015'] },
    async ({ page, api, tasks }) => {
      test.setTimeout(180_000)
      const { task } = await tasks.example('echo')
      const name = unique('badge')
      const scan = await startUnplacedScan(api, `${task.name}@latest`, name)
      try {
        await page.clock.install()
        await openPage(page, '/tasks')
        const scansLink = sidebarLink(page, 'Scans')
        await expect(scansLink).toHaveText(/^Scans\s*1$/)
        await openPage(page, `/scans/${scan.id}`)
        await expect(page).toHaveTitle(`${name} · scantor`)

        // The query console shows a rejected query inline instead of a toast.
        await openPage(page, `/scans/${scan.id}?tab=query`)
        await page.getByRole('textbox', { name: 'Filter', exact: true }).fill('{"$where": "1"}')
        await page.getByRole('button', { name: 'Run query' }).click()
        await expect(page.getByText(/\(at filter\.\$where\)/)).toBeVisible()
        await expect(openToasts(page)).toHaveCount(0)

        await cancelScanAndWait(api, scan.id)
        await page.clock.runFor(SIDEBAR_POLL_MS)
        await expect(scansLink).toHaveText(/^Scans$/)
      } finally {
        await cancelScanAndWait(api, scan.id)
      }
    },
  )
})

test.describe('errors and toasts', () => {
  test('a failed API call shows a red toast titled after its error code; forms show errors inline', { tag: ['@UI-NAV-015'] }, async ({ page, api }) => {
    const names = [unique('gone'), unique('state'), unique('dupe')]
    try {
      const gone = await createCredential(api, { name: names[0]!, host: 'git.example.test', token: 'tok-gone-1234' })
      const stuck = await createCredential(api, { name: names[1]!, host: 'git.example.test', token: 'tok-state-1234' })
      await createCredential(api, { name: names[2]!, host: 'git.example.test', token: 'tok-dupe-1234' })
      await openPage(page, '/account/credentials')
      await expect(page.getByLabel('Git credentials', { exact: true }).getByText(names[0]!)).toBeVisible()

      // A real 404: the credential was deleted elsewhere in the meantime.
      ok(await api.call('deleteCredential', { path: { credentialId: gone.id } }), 'deleteCredential')
      const missing = await api.call<{ error: { message: string } }>('deleteCredential', { path: { credentialId: gone.id } })
      expect(missing.status).toBe(404)
      await page.getByRole('button', { name: `Delete credential ${names[0]}` }).click()
      await page.getByRole('button', { name: `Confirm deleting credential ${names[0]}` }).click()
      const notFound = openToasts(page).filter({ hasText: 'Not found' })
      await expect(notFound).toBeVisible()
      await expect(notFound).toContainText(missing.body.error.message)
      await expect(notFound.locator('[class*="circle-alert"]')).toHaveCount(1)

      // The title follows the error code, for example invalidState.
      await page.route(
        (url) => url.pathname === `/api/credentials/${stuck.id}`,
        (route) =>
          route.request().method() === 'DELETE'
            ? fulfillError(route, { status: 409, code: 'invalidState', message: 'the credential is busy' })
            : route.fallback(),
      )
      await page.getByRole('button', { name: `Delete credential ${names[1]}` }).click()
      await page.getByRole('button', { name: `Confirm deleting credential ${names[1]}` }).click()
      const invalid = openToasts(page).filter({ hasText: 'Not possible in the current state' })
      await expect(invalid).toBeVisible()
      await expect(invalid).toContainText('the credential is busy')
      await expect(invalid.getByRole('button', { name: 'Copy request id' })).toHaveCount(0)

      // A form shows its error inline instead of a toast.
      for (const title of ['Not found', 'Not possible in the current state']) {
        await openToasts(page).filter({ hasText: title }).getByRole('button', { name: 'Close' }).click()
      }
      await expect(openToasts(page)).toHaveCount(0)
      await page.getByRole('button', { name: 'New credential' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('textbox', { name: /^Name\*?$/ }).fill(names[2]!)
      await dialog.getByLabel('Host').fill('git.example.test')
      await dialog.getByRole('textbox', { name: 'Token' }).fill('tok-other-5678')
      await dialog.getByRole('button', { name: 'Create credential' }).click()
      await expect(dialog.getByText('A credential with this name already exists.')).toBeVisible()
      await expect(openToasts(page)).toHaveCount(0)
    } finally {
      await deleteCredentialsNamed(api, names)
    }
  })

  test('a 5xx toast offers "Copy request id", which copies the X-Request-Id', { tag: ['@UI-NAV-016'] }, async ({ page, api, env }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: env.publicUrl })
    const name = unique('fivexx')
    const requestId = `ui-test-${unique('req')}`
    try {
      const credential = await createCredential(api, { name, host: 'git.example.test', token: 'tok-5xx-1234' })
      await page.route(
        (url) => url.pathname === `/api/credentials/${credential.id}`,
        (route) =>
          route.request().method() === 'DELETE'
            ? fulfillError(route, { status: 500, code: 'internal', message: 'Unexpected server error', details: { requestId }, requestId })
            : route.fallback(),
      )
      await openPage(page, '/account/credentials')
      await page.getByRole('button', { name: `Delete credential ${name}` }).click()
      await page.getByRole('button', { name: `Confirm deleting credential ${name}` }).click()
      const toast = openToasts(page).filter({ hasText: 'Unexpected server error' })
      await expect(toast).toBeVisible()
      await toast.getByRole('button', { name: 'Copy request id' }).click()
      await expectToast(page, 'Copied')
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(requestId)
    } finally {
      await deleteCredentialsNamed(api, [name])
    }
  })

  test('an unreachable orchestrator shows one toast at most every 10 s, and background polls never toast', { tag: ['@UI-NAV-019'] }, async ({ page, api }) => {
    const name = unique('offline')
    try {
      const credential = await createCredential(api, { name, host: 'git.example.test', token: 'tok-net-1234' })
      await openPage(page, '/account/credentials')
      await expect(page.getByLabel('Git credentials', { exact: true }).getByText(name)).toBeVisible()
      await page.route(
        (url) => url.pathname === `/api/credentials/${credential.id}`,
        (route) => route.abort('connectionrefused'),
      )

      const remove = async () => {
        const failed = page.waitForEvent('requestfailed', (request) => isApiRequest(request, 'DELETE', `/api/credentials/${credential.id}`))
        await page.getByRole('button', { name: `Delete credential ${name}` }).click()
        await page.getByRole('button', { name: `Confirm deleting credential ${name}` }).click()
        await failed
      }
      await remove()
      const network = openToasts(page).filter({ hasText: 'Cannot reach the orchestrator' })
      await expect(network).toHaveCount(1)
      await network.getByRole('button', { name: 'Close' }).click()
      await expect(openToasts(page)).toHaveCount(0)

      // A second failure within 10 s stays silent.
      await remove()
      await expect(openToasts(page)).toHaveCount(0)

      // A background poll without any response never toasts.
      await openPage(page, '/tasks')
      await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
      await page.route(
        (url) => url.pathname === '/api/tasks',
        (route) => route.abort('connectionrefused'),
      )
      const pollFailed = page.waitForEvent('requestfailed', (request) => isApiRequest(request, 'GET', '/api/tasks'))
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await pollFailed
      await expect(openToasts(page)).toHaveCount(0)
    } finally {
      await deleteCredentialsNamed(api, [name])
    }
  })
})

test.describe('polling', () => {
  test('three failed polls show "Live updates paused, retrying…" until the next successful poll', { tag: ['@UI-NAV-020'] }, async ({ page, api, tasks }) => {
    const name = unique('live')
    tasks.track(name)
    const task = await createScaffoldTask(api, name)
    await openPage(page, `/tasks/${task.id}`)
    await expect(page).toHaveTitle(`${name} · scantor`)
    const banner = page.getByTestId('live-updates-paused')
    await expect(banner).toHaveCount(0)

    await page.route(`**/api/tasks/${task.id}`, (route) => fulfillError(route, { status: 503, code: 'unavailable', message: 'down for a moment' }))
    const refresh = page.getByRole('button', { name: 'Refresh', exact: true })
    for (let failure = 1; failure <= 3; failure++) {
      const response = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/tasks/${task.id}`)
      await refresh.click()
      expect((await response).status()).toBe(503)
      if (failure < 3) await expect(banner).toHaveCount(0)
    }
    await expect(banner).toBeVisible()
    await expect(banner).toHaveAttribute('role', 'status')
    await expect(banner).toHaveText('Live updates paused, retrying…')
    // Background polls never toast.
    await expect(openToasts(page)).toHaveCount(0)

    await page.unroute(`**/api/tasks/${task.id}`)
    await refresh.click()
    await expect(banner).toHaveCount(0)
  })

  test(
    'polls pause while hidden, refetch when visible, keep one request in flight and back off after failures',
    { tag: ['@UI-NAV-021'] },
    async ({ page, api, tasks }) => {
      const name = unique('poll')
      tasks.track(name)
      const task = await createScaffoldTask(api, name)
      const requests = recordApiRequests(page)
      const taskPath = `/api/tasks/${task.id}`
      const taskGets = () => requests.filter((request) => request.method === 'GET' && request.url.pathname === taskPath).length

      const refresh = page.getByRole('button', { name: 'Refresh', exact: true })
      /** Waits until the poll's tick finished (the Refresh button spins while the poll's request runs). */
      const tickDone = async (count: number) => {
        await expect.poll(taskGets).toBe(count)
        await expect(refresh).toBeEnabled()
      }

      await page.clock.install()
      await openPage(page, `/tasks/${task.id}`)
      await expect(page).toHaveTitle(`${name} · scantor`)
      await tickDone(1)
      await page.clock.pauseAt(Date.now() + 1000)

      // Every 10 s while visible.
      await page.clock.runFor(10_500)
      await tickDone(2)

      // Hidden: no poll at all; visible again: an immediate refetch.
      await setVisibility(page, 'hidden')
      await page.clock.runFor(45_000)
      expect(taskGets()).toBe(2)
      await setVisibility(page, 'visible')
      await tickDone(3)

      // One request in flight: a slow answer suppresses further ticks.
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => (release = resolve))
      await page.route(`**${taskPath}`, async (route) => {
        await held
        await route.fallback()
      })
      await page.clock.runFor(10_500)
      await expect.poll(taskGets).toBe(4)
      await expect(refresh).toBeDisabled()
      await page.clock.runFor(35_000)
      expect(taskGets()).toBe(4)
      release()
      await tickDone(4)
      await page.unroute(`**${taskPath}`)

      // Failures double the interval: 20 s, 40 s, then at most 60 s. The interval restarts when a tick ends.
      await page.route(`**${taskPath}`, (route) => fulfillError(route, { status: 503, code: 'unavailable', message: 'down' }))
      const base = taskGets()
      await page.clock.runFor(10_500)
      await tickDone(base + 1)
      await page.clock.runFor(18_000)
      expect(taskGets()).toBe(base + 1)
      await page.clock.runFor(3_000)
      await tickDone(base + 2)
      await page.clock.runFor(37_000)
      expect(taskGets()).toBe(base + 2)
      await page.clock.runFor(4_000)
      await tickDone(base + 3)
      await page.clock.runFor(56_000)
      expect(taskGets()).toBe(base + 3)
      await page.clock.runFor(5_000)
      await tickDone(base + 4)

      // The UI never long-polls with `wait`.
      expect(requests.filter((request) => request.url.searchParams.has('wait')).map((request) => request.url.href)).toEqual([])
    },
  )

  const polledPages: [string, (taskId: string) => string, (taskId: string) => (url: URL) => boolean][] = [
    ['the task page', (taskId) => `/tasks/${taskId}`, (taskId) => (url) => url.pathname === `/api/tasks/${taskId}`],
    ['the scans list', () => '/scans', () => (url) => url.pathname === '/api/scans' && url.searchParams.get('limit') === '50'],
    ['the git credentials page', () => '/account/credentials', () => (url) => url.pathname === '/api/credentials'],
    ['the tasks list', () => '/tasks', () => (url) => url.pathname === '/api/tasks'],
  ]
  for (const [label, path, matcher] of polledPages) {
    test(`"Refresh" on ${label} refetches at once and spins while loading`, { tag: ['@UI-NAV-022'] }, async ({ page, api, tasks }) => {
      const name = unique('refresh')
      tasks.track(name)
      const task = await createScaffoldTask(api, name)
      const matches = matcher(task.id)
      await openPage(page, path(task.id))
      const refresh = page.getByRole('button', { name: 'Refresh', exact: true })
      await expect(refresh).toBeEnabled()
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => (release = resolve))
      await page.route(matches, async (route) => {
        await held
        await route.fallback()
      })
      const request = page.waitForRequest((r) => r.method() === 'GET' && matches(new URL(r.url())))
      await refresh.click()
      await request
      try {
        await expect(refresh).toBeDisabled({ timeout: 5_000 })
        await expect(refresh.locator('[class*="animate-spin"]')).toHaveCount(1)
      } finally {
        release()
      }
      await expect(refresh).toBeEnabled()
    })
  }
})

test.describe('copy buttons, ids, times, sizes and confirmations', () => {
  test(
    'copy buttons copy and confirm, id chips show 8 characters, times and sizes are formatted',
    { tag: ['@UI-NAV-027'] },
    async ({ page, api, tasks, env }) => {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: env.publicUrl })
      const name = unique('copy')
      tasks.track(name)
      const created = await createScaffoldTask(api, name)
      await openPage(page, `/tasks/${created.id}`)
      await page.getByRole('button', { name: 'Check now' }).click()
      await expect.poll(async () => ok(await api.getTask(created.id), 'getTask').workspace.packSha256).not.toBeNull()
      const task = ok(await api.getTask(created.id), 'getTask')
      const packSha256 = task.workspace.packSha256!

      const chip = page.locator(`code[data-id="${packSha256}"]`)
      await expect(chip).toHaveText(packSha256.replace(/^sha256:/, '').slice(0, 8))
      await chip.hover()
      await expect(page.getByRole('tooltip')).toHaveText(packSha256)

      await page.getByRole('button', { name: 'Copy workspace pack hash' }).click()
      await expectToast(page, 'Copied')
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(packSha256)

      const size = page.locator('dt', { hasText: /^Size$/ }).locator('xpath=following-sibling::dd[1]')
      await expect(size).toHaveText(/^\d+(\.\d)? (B|KiB|MiB)$/)
      await expect(size.locator('span')).toHaveAttribute('title', `${new Intl.NumberFormat('en-US').format(task.workspace.bytes)} bytes`)

      const checked = page
        .locator('dt', { hasText: /^Checked$/ })
        .locator('xpath=following-sibling::dd[1]')
        .locator('time')
      await expect(checked).toHaveText('just now')
      const iso = await checked.getAttribute('datetime')
      expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      await checked.hover()
      await expect(page.getByRole('tooltip')).toHaveText(iso!)
    },
  )

  test('a blocked clipboard shows "Copy failed"', { tag: ['@UI-NAV-027'] }, async ({ page, api, tasks }) => {
    const name = unique('noclip')
    tasks.track(name)
    const task = await createScaffoldTask(api, name)
    // Both the Clipboard API and the legacy execCommand fallback refuse, as in a browser that blocks the clipboard.
    await page.addInitScript(() => {
      const refuse = () => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'))
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: refuse, writeText: refuse, readText: refuse, read: refuse } })
      document.execCommand = () => false
    })
    await openPage(page, `/tasks/${task.id}`)
    await page.getByRole('button', { name: 'Check now' }).click()
    await page.getByRole('button', { name: 'Copy workspace pack hash' }).click()
    await expectToastAnywhere(page, 'Copy failed', 5_000)
    await expect(openToasts(page).filter({ hasText: /^Copied/ })).toHaveCount(0)
  })

  test(
    'a type-to-confirm dialog stays disabled until the exact text, and Cancel or closing does nothing',
    { tag: ['@UI-NAV-028'] },
    async ({ page, api, tasks }) => {
      const name = unique('confirm')
      tasks.track(name)
      const task = await createScaffoldTask(api, name)
      await openPage(page, `/tasks/${task.id}`)

      await page.getByRole('button', { name: 'Delete task' }).click()
      let dialog = page.getByRole('dialog', { name: `Delete ${name}` })
      const confirm = dialog.getByRole('button', { name: 'Delete task' })
      await expect(confirm).toBeDisabled()
      const input = dialog.getByLabel(`Type ${name} to confirm`)
      await input.fill(name.slice(0, -1))
      await expect(confirm).toBeDisabled()
      await input.fill(`${name}x`)
      await expect(confirm).toBeDisabled()
      await input.fill(name)
      await expect(confirm).toBeEnabled()
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toBeHidden()

      await page.getByRole('button', { name: 'Delete task' }).click()
      dialog = page.getByRole('dialog', { name: `Delete ${name}` })
      await expect(dialog.getByLabel(`Type ${name} to confirm`)).toHaveValue('')
      await dialog.getByLabel(`Type ${name} to confirm`).fill(name)
      await dialog.getByRole('button', { name: 'Close' }).click()
      await expect(dialog).toBeHidden()

      await page.getByRole('button', { name: 'Delete task' }).click()
      await expect(page.getByRole('dialog', { name: `Delete ${name}` })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toBeHidden()

      expect((await api.getTask(task.id)).status).toBe(200)
      await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`))
    },
  )
})

test.describe('UI preferences', () => {
  const scansListRequest = (page: Page) =>
    page.waitForRequest((r) => {
      const url = new URL(r.url())
      return url.pathname === '/api/scans' && url.searchParams.get('limit') === '50'
    })

  const filters = { scans: { state: ['paused'], task: null, onlyMine: false } }
  const storedPrefs: [string, string, string | null][] = [
    ['valid preferences restore the scans filter', JSON.stringify({ v: 1, tables: {}, resultColumns: {}, queries: {}, testRunDrafts: {}, filters }), 'paused'],
    ['an unknown version is discarded', JSON.stringify({ v: 99, filters }), null],
    ['truncated JSON is discarded', '{"v":1,"filters":', null],
    ['a value that is not JSON is discarded', 'not json at all', null],
  ]
  for (const [title, raw, expected] of storedPrefs) {
    test(title, { tag: ['@UI-NAV-029'] }, async ({ page }) => {
      await page.addInitScript((value) => window.localStorage.setItem('scantor-ui', value), raw)
      const request = scansListRequest(page)
      await openPage(page, '/scans')
      expect(new URL((await request).url()).searchParams.get('state')).toBe(expected)
      await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
    })
  }

  test('changed filters are written as one versioned key', { tag: ['@UI-NAV-029'] }, async ({ page }) => {
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem('seeded')) {
        window.localStorage.setItem('scantor-ui', '{broken')
        window.sessionStorage.setItem('seeded', '1')
      }
    })
    await openPage(page, '/scans')
    await page.getByRole('button', { name: 'Filter by state' }).click()
    await page.getByRole('option', { name: 'paused' }).click()
    await page.keyboard.press('Escape')
    await expect.poll(async () => page.evaluate(() => window.localStorage.getItem('scantor-ui'))).toMatch(/"v":1/)
    const prefs = JSON.parse((await page.evaluate(() => window.localStorage.getItem('scantor-ui')))!) as { v: number; filters: { scans: { state: string[] } } }
    expect(prefs.v).toBe(1)
    expect(prefs.filters.scans.state).toEqual(['paused'])

    const request = scansListRequest(page)
    await reloadPage(page)
    expect(new URL((await request).url()).searchParams.get('state')).toBe('paused')
  })

  test('every page works with localStorage unavailable', { tag: ['@UI-NAV-029'] }, async ({ page, api, tasks }) => {
    const name = unique('nostorage')
    tasks.track(name)
    const task = await createScaffoldTask(api, name)
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('The operation is insecure.', 'SecurityError')
        },
      })
    })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    for (const [path, ready] of [
      ['/', (p: Page) => p.getByRole('link', { name: 'New task', exact: true }).first()],
      ['/tasks', (p: Page) => p.getByLabel('Tasks', { exact: true }).getByText(name)],
      [`/tasks/${task.id}`, (p: Page) => p.getByRole('button', { name: 'Check now' })],
      ['/scans', (p: Page) => p.getByRole('button', { name: 'Filter by state' })],
      ['/templates', (p: Page) => p.getByRole('button', { name: 'Refresh', exact: true })],
      ['/account', (p: Page) => p.getByRole('heading', { name: 'Profile' })],
      ['/account/credentials', (p: Page) => p.getByLabel('Git credentials', { exact: true })],
    ] as const) {
      await openPage(page, path)
      await expect(ready(page), path).toBeVisible()
    }
    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    await expect(page.locator(SIDEBAR)).toHaveAttribute('data-collapsed', 'true')
    expect(errors).toEqual([])
  })
})
