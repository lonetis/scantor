import type { Page, Response } from '@playwright/test'
import type { JobAccepted } from '#shared/types/common'
import type { InstanceInfo } from '#shared/types/instance'
import type { Job } from '#shared/types/jobs'
import { ApiClient, ok } from '../helpers/api-client'
import { env } from '../helpers/env'
import { alertBox, createScaffoldTask, fulfillJson, openPage, patchJsonResponse, waitForJob, nodeRoutedContext, workerTenant } from '../helpers/ui-shell-tasks'
import { newApiContext } from '../helpers/users'
import { expect, test as base, unique } from '../fixtures'

// The worker's tenant under a session file of its own, and the dashboard's requests sent from Node (helpers/ui-shell-tasks.ts).
const test = base.extend({ user: [workerTenant, { scope: 'worker' }], context: nodeRoutedContext })

// The admin tools page (docs/ui.md §5.20, docs/auth.md §11): the infrastructure GUIs behind Traefik forwardAuth, the
// API links, the health report and the jobs of all users. The test stack runs Traefik; the page without it, an
// unhealthy platform and a failed job are produced by route mocks.

// The seeded admin's saved session; overriding the storage state also spares the worker's tenant (and its sign-in).
test.use({ role: 'admin', storageState: env.paths.adminState })

const TOOLS = [
  { target: 'rabbitmq', title: 'RabbitMQ management', path: '/' },
  { target: 'mongo-express', title: 'mongo-express', path: '/' },
  { target: 'rustfs', title: 'RustFS console', path: '/rustfs/console/' },
  { target: 'traefik', title: 'Traefik dashboard', path: '/dashboard/' },
] as const

function toolCard(page: Page, target: string) {
  return page.locator(`[data-row-id="${target}"]`)
}

function job(id: string, patch: Partial<Job>): Job {
  return {
    id,
    kind: 'taskDelete',
    subject: { kind: 'task', id: '7c9e6679-7425-40de-944b-e07fc1f90ae7' },
    state: 'succeeded',
    progress: { done: 1, total: 1 },
    attempts: 1,
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...patch,
  }
}

test.describe('infrastructure tools', () => {
  for (const tool of TOOLS) {
    test(`"Open ${tool.title}" sets the tools cookie and reaches the tool through forwardAuth`, { tag: ['@UI-ADMIN-013'] }, async ({ page }) => {
      await openPage(page, '/admin/tools')
      const card = toolCard(page, tool.target)
      await expect(card.getByRole('heading', { name: tool.title })).toBeVisible()
      const toolUrl = `https://${tool.target}.${env.domain}${tool.path}`
      await expect(card.locator('code')).toHaveText(toolUrl)
      const open = card.getByRole('link', { name: `Open ${tool.title}` })
      await expect(open).toHaveAttribute('href', `/api/tools/session?target=${encodeURIComponent(tool.target)}`)
      await expect(open).toHaveAttribute('target', '_blank')
      expect((await page.context().cookies(toolUrl)).some((cookie) => cookie.name === 'scantor_tools')).toBe(false)

      const responses: Response[] = []
      page.context().on('response', (response) => {
        if (new URL(response.url()).host === `${tool.target}.${env.domain}`) responses.push(response)
      })
      const [tab] = await Promise.all([page.context().waitForEvent('page'), open.click()])
      await tab.waitForURL((url) => url.host === `${tool.target}.${env.domain}`, { timeout: 30_000 })
      const cookie = (await page.context().cookies(toolUrl)).find((candidate) => candidate.name === 'scantor_tools')
      expect(cookie, 'the tools cookie').toBeDefined()
      expect(cookie!.httpOnly).toBe(true)
      expect(cookie!.secure).toBe(true)

      // forwardAuth let the request through: the tool itself answers (mongo-express asks for its own credentials).
      await expect.poll(() => responses.length).toBeGreaterThan(0)
      const first = responses[0]!
      if (tool.target === 'mongo-express') {
        expect(first.status()).toBe(401)
        expect(first.headers()['www-authenticate']).toMatch(/^Basic /)
      } else {
        expect(first.status()).toBeLessThan(400)
        expect(first.headers()['content-type'] ?? '').toMatch(/text\/html/)
      }
      if (tool.target === 'rabbitmq') await expect(tab).toHaveTitle(/RabbitMQ/)
      await tab.close()
    })
  }

  test('without Traefik the page says so and shows the bind address instead of links', { tag: ['@UI-ADMIN-013'] }, async ({ page }) => {
    await page.route(
      (url) => url.pathname === '/api/info',
      (route) =>
        patchJsonResponse<InstanceInfo>(route, (info) => ({
          ...info,
          adminTools: { enabled: false, items: info.adminTools!.items.map((item) => ({ ...item, url: null })) },
        })),
    )
    await openPage(page, '/admin/tools')
    const alert = alertBox(page, 'Traefik is not enabled')
    await expect(alert).toBeVisible()
    await expect(alert).toContainText('SCANTOR_ADMIN_BIND_ADDRESS')
    for (const tool of TOOLS) {
      const card = toolCard(page, tool.target)
      await expect(card.getByRole('heading', { name: tool.title })).toBeVisible()
      await expect(card).toContainText('Bound to SCANTOR_ADMIN_BIND_ADDRESS; use an SSH tunnel.')
      await expect(card.getByRole('link')).toHaveCount(0)
    }
    await expect(page.getByText('Opening a tool sets an admin-only cookie')).toHaveCount(0)
  })
})

test.describe('API links, health and jobs', () => {
  test('links the API reference, the OpenAPI document and the metrics', { tag: ['@UI-ADMIN-014'] }, async ({ page }) => {
    await openPage(page, '/admin/tools')
    for (const [label, href] of [
      ['API reference', '/api/docs'],
      ['OpenAPI document', '/api/docs/openapi.json'],
      ['Metrics', '/api/metrics'],
    ] as const) {
      const link = page.getByRole('link', { name: new RegExp(`^${label}`) })
      await expect(link).toHaveAttribute('href', href)
      await expect(link).toHaveAttribute('target', '_blank')
    }
    const [metrics] = await Promise.all([page.context().waitForEvent('page'), page.getByRole('link', { name: /^Metrics/ }).click()])
    await metrics.waitForLoadState('domcontentloaded')
    expect(new URL(metrics.url()).pathname).toBe('/api/metrics')
    await expect(metrics.locator('body')).toContainText('scantor_build_info')
    await metrics.close()
  })

  test('shows the health report, also when it answers 503', { tag: ['@UI-ADMIN-014'] }, async ({ page, adminApi }) => {
    const health = ok(await adminApi.getHealth(), 'getHealth')
    await openPage(page, '/admin/tools')
    const components = page.getByRole('list', { name: 'Platform components' })
    for (const [name, state] of Object.entries(health.components)) {
      await expect(components.getByRole('listitem').filter({ hasText: name })).toContainText(state)
    }
    await expect(page.getByText(`version ${health.version}`)).toBeVisible()

    // MongoDB down: the orchestrator answers 503 with the full report.
    await page.route(
      (url) => url.pathname === '/api/health',
      (route) =>
        fulfillJson(route, { status: 'degraded', version: health.version, components: { ...health.components, mongo: 'down' }, alarms: ['memory'] }, 503),
    )
    const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/health')
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    expect((await answered).status()).toBe(503)
    await expect(components.getByRole('listitem').filter({ hasText: 'mongo' })).toContainText('down')
    await expect(components.getByRole('listitem').filter({ hasText: 'rabbitmq' })).toContainText(health.components.rabbitmq)
    await expect(page.locator('section[aria-labelledby="health-heading"]').getByText('degraded', { exact: true })).toBeVisible()
    const alarms = alertBox(page, 'RabbitMQ alarms')
    await expect(alarms).toContainText('memory')
    await expect(page.getByText(/Health could not be loaded/)).toHaveCount(0)
  })

  test(
    "the jobs table lists other users' jobs, filters by kind and state and puts failed jobs first",
    { tag: ['@UI-ADMIN-014'] },
    async ({ page, user, openapi }) => {
      const context = await newApiContext({ storageState: user.storageState })
      try {
        // A job of the worker's tenant, not of the admin.
        const tenantApi = new ApiClient(context, openapi)
        const name = unique('jobs')
        await createScaffoldTask(tenantApi, name)
        const accepted = ok(await tenantApi.deleteTask(name), 'deleteTask') as JobAccepted
        expect((await waitForJob(tenantApi, accepted.job.id)).state).toBe('succeeded')

        await openPage(page, '/admin/tools')
        const table = page.getByLabel('Jobs', { exact: true })
        for (const header of ['Kind', 'Subject', 'State', 'Progress', 'Attempts', 'Error', 'Created', 'Finished']) {
          await expect(table.getByRole('columnheader', { name: header, exact: true })).toBeVisible()
        }
        const kindRequest = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/jobs' && new URL(r.url()).searchParams.get('kind') === 'taskDelete')
        await page.getByRole('combobox', { name: 'Filter jobs by kind' }).click()
        await page.getByRole('option', { name: 'taskDelete', exact: true }).click()
        await kindRequest
        const stateRequest = page.waitForRequest((r) => {
          const url = new URL(r.url())
          return url.pathname === '/api/jobs' && url.searchParams.get('kind') === 'taskDelete' && url.searchParams.get('state') === 'succeeded'
        })
        await page.getByRole('combobox', { name: 'Filter jobs by state' }).click()
        await page.getByRole('option', { name: 'succeeded', exact: true }).click()
        await stateRequest
        const row = table.locator(`tr[data-row-id="${accepted.job.id}"]`)
        await expect(row).toBeVisible()
        await expect(row.getByText('taskDelete', { exact: true })).toBeVisible()
        await expect(row.locator('[data-state="succeeded"]')).toBeVisible()
        for (const kind of await table.locator('tbody tr[data-row-id] td:first-child').allInnerTexts()) expect(kind.trim()).toBe('taskDelete')

        // Failed jobs come first, before newer jobs of any other state.
        const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
        const jobs = [
          job('11111111-1111-4111-8111-111111111111', { state: 'succeeded', createdAt: minutesAgo(10) }),
          job('22222222-2222-4222-8222-222222222222', { state: 'failed', createdAt: minutesAgo(60), error: { code: 'internal', message: 'the purge broke' } }),
          job('33333333-3333-4333-8333-333333333333', { state: 'running', createdAt: minutesAgo(5), progress: { done: 3, total: 10 }, finishedAt: null }),
        ]
        await page.route(
          (url) => url.pathname === '/api/jobs',
          (route) => fulfillJson(route, { items: jobs, nextCursor: null }),
        )
        await page.getByRole('button', { name: 'Refresh', exact: true }).click()
        const rows = table.locator('tbody tr[data-row-id]')
        await expect(rows).toHaveCount(3)
        await expect(rows.first()).toHaveAttribute('data-row-id', jobs[1]!.id)
        await expect(rows.first()).toContainText('the purge broke')
        await expect(rows.nth(1)).toHaveAttribute('data-row-id', jobs[2]!.id)
        await expect(rows.nth(1)).toContainText('3 / 10')
        await expect(rows.nth(2)).toHaveAttribute('data-row-id', jobs[0]!.id)
      } finally {
        await context.dispose()
      }
    },
  )
})
