import type { Health } from '#shared/types/instance'
import type { Node } from '#shared/types/nodes'
import type { ItemList } from '#shared/types/common'
import type { Task } from '#shared/types/tasks'
import { expect, test, unique } from '../fixtures'
import { ok } from '../helpers/api-client'
import { exampleTaskDir, packTask } from '../helpers/tasks'
import {
  SHARED_SETUP_TIMEOUT_MS,
  PENDING_SETTINGS,
  badges,
  deleteOwnScans,
  expectAfterRefresh,
  gotoApp,
  patchJsonResponses,
  row,
  schedulingFailedScan,
  sharedTask,
  sharedTasksOf,
  shieldFromNetworkChanges,
  startOwnScan,
  uTable,
} from '../helpers/ui-scans-kit'

// The overview page (docs/ui.md §5.4): first-run state, active scans, needs attention, recent scans and tasks,
// quick actions and, for admins, platform health. The empty first-run state needs a user without anything (a fresh
// user, no build); everything else runs on the worker's tenant and asserts on the rows of the scans and tasks a test
// created or, for the account-wide "last 5 tasks", against listTasks.

// Chromium aborts in-flight requests whenever the inner dockerd changes networks (helpers/ui-scans-kit.ts).
test.beforeEach(async ({ page }) => shieldFromNetworkChanges(page))
// The shared tasks of this spec are built before its first test in a worker, outside the tests' timeouts.
test.beforeAll(async ({ user, openapi }) => {
  test.setTimeout(SHARED_SETUP_TIMEOUT_MS)
  await sharedTasksOf(user, openapi, ['throws'])
})
test.afterEach(deleteOwnScans)

const section = (page: import('@playwright/test').Page, heading: string) =>
  page.locator('section', { has: page.getByRole('heading', { name: heading, exact: true }) })

test.describe('overview of a fresh user', () => {
  test.use({ pageUser: 'fresh' })

  test('a user without tasks and scans sees the first-run state', { tag: ['@UI-HOME-001'] }, async ({ page }) => {
    await gotoApp(page, '/')
    await expect(page.getByText('No tasks yet', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Active scans' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Recent scans' })).toHaveCount(0)
    const create = page.getByRole('link', { name: 'Create your first task' })
    await expect(create).toHaveAttribute('href', '/tasks/new')
    await create.click()
    await expect(page).toHaveURL(/\/tasks\/new$/)
  })
})

test.describe('overview of the tenant', () => {
  test(
    'recent tasks and the last ten scans next to the quick actions',
    { tag: ['@UI-HOME-002', '@UI-HOME-004'] },
    async ({ page, api, user, openapi, tasks }) => {
      const throws = await sharedTask(user, openapi, 'throws')
      // Four drafts (no build): the newest five tasks are these and the newest published task before them.
      for (let index = 0; index < 4; index++) {
        const name = unique(`overview-draft-${index}`)
        ok(await api.uploadTask(await packTask(exampleTaskDir('echo'), { name }), { publish: false }), 'uploadTask')
        tasks.track(name)
      }
      // Eleven scans that never get a worker, cancelled at once: the oldest drops out of "Recent scans".
      const scanIds: string[] = []
      for (let index = 0; index < 11; index++) {
        const scan = await startOwnScan(user, openapi, { revision: throws.revision.id, name: unique(`overview-scan-${index}`), settings: PENDING_SETTINGS })
        scanIds.push(scan.id)
        expect([200, 409]).toContain((await api.cancelScan(scan.id)).status)
      }
      // The fifth is the newest of the tenant's other tasks (a shared task of this worker).
      const newestTasks = ok(await api.call<ItemList<Task>>('listTasks', { query: { limit: 5 } }), 'listTasks').items
      expect(newestTasks.slice(0, 4).every((task) => task.latestRevision === null)).toBe(true)
      expect(newestTasks).toHaveLength(5)

      await gotoApp(page, '/')
      // Recent tasks: language, latest revision with its state, or "no revision" and the "Unpublished changes" badge.
      const recentTasks = section(page, 'Recent tasks')
      await expect(recentTasks.locator('li[data-row-id]')).toHaveCount(5)
      expect(await recentTasks.locator('li[data-row-id]').evaluateAll((items) => items.map((item) => item.getAttribute('data-row-id')))).toEqual(
        newestTasks.map((task) => task.id),
      )
      for (const task of newestTasks) {
        const taskRow = row(recentTasks, task.id)
        await expect(taskRow.getByRole('link', { name: task.name, exact: true })).toHaveAttribute('href', `/tasks/${task.id}`)
        await expect(taskRow).toContainText(task.language)
        if (task.latestRevision) {
          await expect(taskRow).toContainText(`@${task.latestRevision.number}`)
          await expect(badges(taskRow)).toHaveText(task.latestRevision.state)
        } else {
          await expect(taskRow).toContainText('no revision')
        }
        await expect(taskRow.getByTestId('unpublished-badge')).toHaveCount(task.workspace.dirty ? 1 : 0)
      }
      await expect(recentTasks.getByTestId('unpublished-badge').first()).toHaveText('Unpublished changes')
      await expect(recentTasks.getByRole('link', { name: 'All tasks' })).toHaveAttribute('href', '/tasks')

      // Recent scans: the ten newest, each linking to its revision.
      const recentScans = uTable(page, 'Recent scans')
      await expectAfterRefresh(page, async () => {
        for (const scanId of scanIds.slice(1)) await expect(row(recentScans, scanId)).toBeVisible({ timeout: 2000 })
      })
      await expect(row(recentScans, scanIds[0]!)).toHaveCount(0)
      await expect(recentScans.locator('tbody tr[data-row-id]')).toHaveCount(10)
      await expect(row(recentScans, scanIds[10]!).getByRole('link', { name: throws.revision.ref })).toBeVisible()
      await expect(section(page, 'Recent scans').getByRole('link', { name: 'All scans' })).toHaveAttribute('href', '/scans')
      // None of them is active any more, and no other scan of the tenant runs.
      await expect(section(page, 'Active scans').getByText('No scan is running.')).toBeVisible()

      // Quick actions.
      const quick = section(page, 'Quick actions')
      await expect(quick.getByRole('link', { name: 'New task' })).toHaveAttribute('href', '/tasks/new')
      await expect(quick.getByRole('link', { name: 'New scan' })).toHaveAttribute('href', '/scans/new')
      await expect(quick.getByRole('link', { name: 'CLI & MCP access' })).toHaveAttribute('href', '/account/access')
    },
  )

  test(
    'active scans and the scans that need attention link to their pages',
    { tag: ['@UI-HOME-002', '@UI-HOME-003'] },
    async ({ page, api, user, openapi }) => {
      const [throws, failed] = await Promise.all([sharedTask(user, openapi, 'throws'), schedulingFailedScan(user, openapi)])
      // An active scan with a condition: its workers can never be placed (workersPending).
      const pending = await startOwnScan(user, openapi, { revision: throws.revision.id, name: unique('overview-pending'), settings: PENDING_SETTINGS })
      await expect
        .poll(async () => ok(await api.getScan(pending.id), 'getScan').conditions.map((condition) => condition.type), { timeout: 60_000 })
        .toContain('workersPending')

      await gotoApp(page, '/')
      const active = section(page, 'Active scans')
      const card = row(active, pending.id)
      await expect(card).toBeVisible()
      await expect(card).toContainText(pending.name!)
      await expect(card).toContainText(throws.revision.ref)
      await expect(badges(card)).toHaveText(/^(running|creating)$/)
      await expect(card.getByRole('progressbar', { name: `Progress of ${pending.name}` })).toBeVisible()
      await expect(card).toContainText('0 / min')
      await expect(card).toContainText(/1\s*conditions/)
      await expect(row(active, failed.id)).toHaveCount(0)

      // Needs attention: the active scan with its condition count and the failed scan with its reason, once each.
      const attention = section(page, 'Needs attention')
      await expect(row(attention, pending.id)).toHaveCount(1)
      await expect(row(attention, pending.id)).toContainText('1 condition needs attention')
      await expect(row(attention, failed.id)).toHaveCount(1)
      await expect(badges(row(attention, failed.id))).toHaveText('failed')
      await expect(row(attention, failed.id)).toContainText(failed.stateReason!.message)
      // Admins only.
      await expect(page.getByRole('heading', { name: 'Platform health' })).toHaveCount(0)

      await row(attention, failed.id).getByRole('link', { name: failed.name! }).click()
      await expect(page).toHaveURL(new RegExp(`/scans/${failed.id}$`))
      await page.goBack()
      await card.click()
      await expect(page).toHaveURL(new RegExp(`/scans/${pending.id}$`))
    },
  )
})

test.describe('overview of an admin', () => {
  test.use({ role: 'admin' })

  test('platform health shows the components, alarms, node counts and free capacity', { tag: ['@UI-HOME-005'] }, async ({ page, adminApi }) => {
    // Other runs place workers and add nodes concurrently: the expected summary is computed from the very listNodes
    // answer the page rendered.
    let rendered: Node[] = []
    await page.route('**/api/nodes', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const response = await route.fetch()
      const body = (await response.json()) as ItemList<Node>
      if (response.status() === 200) rendered = body.items
      await route.fulfill({ response, json: body })
    })
    await gotoApp(page, '/')
    const health = section(page, 'Platform health')
    await expect(health).toBeVisible()
    const components = health.getByRole('list', { name: 'Components' })
    const current = ok(await adminApi.getHealth(), 'getHealth')
    for (const component of ['mongo', 'rabbitmq', 's3', 'registry'] as const) {
      await expect(components.getByRole('listitem').filter({ hasText: component })).toContainText(current.components[component])
    }
    const nodesLink = health.getByRole('link', { name: /^Nodes:/ })
    await expect(nodesLink).toHaveAttribute('href', '/admin/nodes')
    await expect(async () => {
      expect(rendered.length).toBeGreaterThan(0)
      const expected = summarize(rendered)
      await expect(nodesLink).toHaveText(`Nodes: ${expected.online} online · ${expected.offline} offline · ${expected.total} total`, { timeout: 1000 })
      await expect(health).toContainText(`free capacity: ${expected.freeCapacity} ${expected.freeCapacity === 1 ? 'worker' : 'workers'}`, { timeout: 1000 })
    }).toPass({ timeout: 30_000 })
    // The answer the page shows is the platform's: the built-in node is among the nodes.
    expect(rendered.map((node) => node.name)).toEqual(
      expect.arrayContaining(
        ok(await adminApi.listNodes(), 'listNodes')
          .items.filter((node) => node.builtIn)
          .map((node) => node.name),
      ),
    )
    await expect(health.getByText('RabbitMQ alarms')).toHaveCount(0)

    // A memory alarm (the shared stack must not be driven into one): the health answer is patched in the browser.
    await patchJsonResponses(
      page,
      '**/api/health',
      (body) => ({ ...(body as unknown as Health), status: 'degraded', alarms: ['memory'] }) as unknown as Record<string, unknown>,
    )
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(health.getByText('RabbitMQ alarms')).toBeVisible()
    await expect(health.getByText('memory', { exact: true })).toBeVisible()
  })
})

/** The overview's node summary (docs/ui.md §5.4): free capacity over online, uncordoned nodes. */
function summarize(nodes: Node[]): { online: number; offline: number; total: number; freeCapacity: number } {
  const online = nodes.filter((node) => node.state === 'online')
  const capacity = (node: Node) => {
    const reported = node.info?.maxWorkers ?? 0
    return node.maxWorkers === null ? reported : Math.min(reported, node.maxWorkers)
  }
  return {
    online: online.length,
    offline: nodes.filter((node) => node.state === 'offline').length,
    total: nodes.length,
    freeCapacity: online.filter((node) => !node.cordoned).reduce((sum, node) => sum + Math.max(0, capacity(node) - node.activeWorkers), 0),
  }
}
