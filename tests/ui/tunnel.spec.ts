import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { env } from '../helpers/env'
import { reserve } from '../helpers/limiter'
import { writeTunnelState } from '../helpers/tunnel'
import { expectToast } from '../helpers/ui'
import { deleteApiKeysNamed, nodeRouted, openPage, submitLoginForm, workerTenant } from '../helpers/ui-shell-tasks'
import { createUser, deleteUser } from '../helpers/users'
import { expect, test as base, unique } from '../fixtures'

// The dashboard through the Cloudflare Tunnel (docs/ui.md §1, §4.1): the test stack's stand-in tunnel serves the tunnel
// URL (docs/testing.md §7.3). Whether a page came through it is getInstanceInfo's `origin`; the sidebar then shows a
// "Tunnel URL" badge, `/editor` goes to the overview with a toast, the admin tools page shows an alert in place of the
// tool grid (its API links, health and jobs stay), download controls are disabled with a tooltip, and the access page
// names the tunnel URL's MCP endpoint and SCANTOR_URL. Sessions are per origin, so the pages here carry a session of
// both origins (helpers/tunnel.ts writeTunnelState); the tunnel URL's requests are sent from Node like the public URL's.

interface TunnelStates {
  /** a storage state with the role's session on the public URL and on the tunnel URL */
  get(role: 'user' | 'admin'): Promise<string>
}

const test = base.extend<object, { tunnelStates: TunnelStates }>({
  // The worker's tenant under a session file of its own (helpers/ui-shell-tasks.ts).
  user: [workerTenant, { scope: 'worker' }],
  context: nodeRouted({ origins: [env.tunnelUrl] }),
  // Sessions on the tunnel URL, signed in once per worker and role when first needed (one limiter slot each).
  tunnelStates: [
    async ({ user }, use) => {
      const states = new Map<string, Promise<string>>()
      await use({
        get: (role) => {
          let state = states.get(role)
          if (!state) {
            const file = join(env.paths.auth, `tunnel-${role}-${unique('ui')}.json`)
            state =
              role === 'admin'
                ? writeTunnelState(file, env.admin, env.paths.adminState)
                : writeTunnelState(file, { email: user.email, password: user.password }, user.storageState)
            states.set(role, state)
          }
          return state
        },
      })
      for (const state of states.values()) {
        const file = await state.catch(() => null)
        if (file) await rm(file, { force: true })
      }
    },
    { scope: 'worker' },
  ],
  storageState: async ({ role, tunnelStates }, use) => use(await tunnelStates.get(role)),
})

function mainNavigation(page: Page) {
  return page.getByRole('navigation', { name: 'Main navigation' })
}

function sidebarLink(page: Page, name: string) {
  return mainNavigation(page).getByRole('link', { name: new RegExp(`^${name}\\b`) })
}

/** The tooltip of a disabled control, opened on its wrapper (a disabled button takes no pointer events). */
async function expectWrapperTooltip(page: Page, control: Locator, text: string): Promise<void> {
  await page.mouse.move(0, 0)
  await control.locator('xpath=..').hover()
  await expect(page.getByRole('tooltip')).toHaveText(text)
}

test.describe('signing in through the tunnel URL', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('the login form signs in on the tunnel URL, whose session stays on its host', { tag: ['@TUNNEL-011'] }, async ({ page, adminApi }) => {
    const created = await createUser(adminApi, { prefix: 'tunnel-login' })
    try {
      await openPage(page, `${env.tunnelUrl}/login`)
      await page.getByLabel('Email').fill(created.email)
      await page.getByLabel('Password').fill(created.password)
      const response = await submitLoginForm(page)
      expect(response.status()).toBe(200)
      await page.waitForURL((url) => url.origin === env.tunnelUrl && url.pathname === '/', { timeout: 15_000 })
      await expect(page.getByTestId('tunnel-badge')).toBeVisible()
      const cookies = await page.context().cookies()
      expect(cookies.filter((c) => c.name.endsWith('scantor.session_token')).map((c) => c.domain)).toEqual([new URL(env.tunnelUrl).hostname])
    } finally {
      await deleteUser(adminApi, created.id)
    }
  })

  test(
    'a passkey added through the tunnel URL has the tunnel host as relying party and signs in there',
    { tag: ['@TUNNEL-015'] },
    async ({ page, adminApi, webauthn }) => {
      const created = await createUser(adminApi, { prefix: 'tunnel-passkey' })
      try {
        await openPage(page, `${env.tunnelUrl}/login`)
        await page.getByLabel('Email').fill(created.email)
        await page.getByLabel('Password').fill(created.password)
        expect((await submitLoginForm(page)).status()).toBe(200)
        await page.waitForURL((url) => url.origin === env.tunnelUrl && url.pathname === '/', { timeout: 15_000 })

        // The passkey guard reads the tunnel session on the tunnel's instance; verify-registration checks the tunnel origin.
        await openPage(page, `${env.tunnelUrl}/account`)
        const passkeys = page.locator('section', { has: page.getByRole('heading', { name: 'Passkeys', exact: true }) })
        await passkeys.getByLabel('New passkey name').fill('Tunnel key')
        await passkeys.getByRole('button', { name: 'Add passkey' }).click()
        await expect(passkeys.getByRole('status')).toHaveText('Passkey added')
        expect((await webauthn.listCredentials()).map((credential) => credential.rpId)).toEqual([new URL(env.tunnelUrl).hostname])

        // Signed out, the passkey signs in through the tunnel URL again.
        await page.context().clearCookies()
        await openPage(page, `${env.tunnelUrl}/login`)
        const button = page.getByRole('button', { name: 'Sign in with passkey' })
        await expect(button).toBeVisible()
        await reserve('/passkey/verify-authentication')
        await button.click()
        await page.waitForURL((url) => url.origin === env.tunnelUrl && url.pathname === '/', { timeout: 15_000 })
        await expect(page.getByTestId('user-menu')).toContainText(created.email)
      } finally {
        await deleteUser(adminApi, created.id)
      }
    },
  )
})

test.describe('the dashboard through the tunnel URL', () => {
  test('the sidebar shows the "Tunnel URL" badge and hides the Editor link', { tag: ['@TUNNEL-011'] }, async ({ page }) => {
    await openPage(page, `${env.tunnelUrl}/`)
    const badge = page.getByTestId('tunnel-badge')
    await expect(badge).toBeVisible()
    await expect(badge).toHaveText('Tunnel URL')
    // Its label names the public URL, where the editor and the downloads are.
    await expect(badge).toHaveAttribute('aria-label', new RegExp(env.publicUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    await expect(sidebarLink(page, 'Tasks')).toBeVisible()
    await expect(sidebarLink(page, 'Editor')).toHaveCount(0)

    // The same user on the public URL: no badge, and the editor is there.
    await openPage(page, `${env.publicUrl}/`)
    await expect(sidebarLink(page, 'Editor')).toBeVisible()
    await expect(page.getByTestId('tunnel-badge')).toHaveCount(0)
  })

  test('/editor through the tunnel URL goes to the overview with a toast and starts no editor', { tag: ['@TUNNEL-011'] }, async ({ page }) => {
    const editorRequests: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/editor')) editorRequests.push(`${request.method()} ${url.pathname}`)
    })
    await openPage(page, `${env.tunnelUrl}/editor`)
    await page.waitForURL((url) => url.origin === env.tunnelUrl && url.pathname === '/')
    await expectToast(page, 'Not available through the tunnel URL')
    await expectToast(page, `Open ${env.publicUrl}/editor instead.`)
    expect(editorRequests).toEqual([])
  })

  test('the access page names the tunnel URL’s MCP endpoint and SCANTOR_URL', { tag: ['@TUNNEL-014'] }, async ({ page, api }) => {
    const name = unique('tunnel-key').slice(0, 32)
    try {
      await openPage(page, `${env.tunnelUrl}/account/access`)
      await expect(page.getByTestId('mcp-url')).toHaveText(env.tunnelMcpUrl)
      await expect(page.getByTestId('mcp-tunnel-url')).toHaveCount(0)
      await expect(page.getByTestId('tunnel-cli-hint')).toContainText(`SCANTOR_URL=${env.publicUrl}`)

      // A key created here comes with the tunnel URL in its snippets.
      await page.getByRole('button', { name: 'Create key' }).click()
      const form = page.getByRole('dialog', { name: 'Create API key' })
      await form.getByLabel('Name').fill(name)
      await form.getByRole('button', { name: 'Create API key' }).click()
      const reveal = page.getByRole('dialog', { name: `API key ${name}` })
      await expect(reveal).toBeVisible()
      const key = (await reveal.getByTestId('secret-value').textContent())?.trim() ?? ''
      const environment = page.getByRole('region', { name: 'Environment', exact: true }).locator('code')
      await expect(environment).toHaveText(`export SCANTOR_URL=${env.tunnelUrl}\nexport SCANTOR_TOKEN=${key}`)
      const mcpCommand = page.getByRole('region', { name: 'MCP with this key', exact: true }).locator('code')
      await expect(mcpCommand).toHaveText(`claude mcp add --transport http scantor ${env.tunnelMcpUrl} --header "Authorization: Bearer ${key}"`)
      await reveal.getByRole('button', { name: 'Done' }).click()

      // On the public URL the endpoint of the tunnel URL is listed next to the public one.
      await openPage(page, `${env.publicUrl}/account/access`)
      await expect(page.getByTestId('mcp-url')).toHaveText(env.mcpUrl)
      await expect(page.getByTestId('mcp-tunnel-url')).toHaveText(env.tunnelMcpUrl)
      await expect(page.getByText('OAuth works at this URL.')).toBeVisible()
      await expect(page.getByTestId('tunnel-cli-hint')).toHaveCount(0)
    } finally {
      await deleteApiKeysNamed(api, [name])
    }
  })

  test('download controls are disabled through the tunnel URL with a tooltip naming the public URL', { tag: ['@TUNNEL-013'] }, async ({ page, tasks }) => {
    test.setTimeout(180_000)
    // A failed revision (static check) has a page with "Download source" without a build.
    const { task, revision } = await tasks.fixture('hostile-label', { expectState: 'failed' })
    const path = `/tasks/${task.id}/revisions/${revision.number}`

    await openPage(page, `${env.tunnelUrl}${path}`)
    await expect(page.getByTestId('tunnel-badge')).toBeVisible()
    const button = page.getByRole('button', { name: 'Download source' })
    await expect(button).toBeDisabled()
    await expect(page.getByRole('link', { name: 'Download source' })).toHaveCount(0)
    await expectWrapperTooltip(page, button, `Downloads are available only at ${env.publicUrl}, not through the tunnel URL`)

    await openPage(page, `${env.publicUrl}${path}`)
    await expect(page.getByRole('link', { name: 'Download source' })).toHaveAttribute(
      'href',
      `/api/tasks/${task.id}/revisions/${revision.number}/source?redirect=true`,
    )
  })
})

test.describe('the admin through the tunnel URL', () => {
  test.use({ role: 'admin' })

  test('the admin tools page shows an alert in place of the tools and keeps its API links, health and jobs', { tag: ['@TUNNEL-012'] }, async ({ page }) => {
    await openPage(page, `${env.tunnelUrl}/admin/tools`)
    expect(new URL(page.url()).pathname).toBe('/admin/tools')
    const alert = page.getByTestId('tunnel-tools-alert')
    await expect(alert).toBeVisible()
    await expect(alert).toContainText('Infrastructure tools are not served through the tunnel URL')
    await expect(alert.getByRole('link', { name: `${env.publicUrl}/admin/tools` })).toHaveAttribute('href', `${env.publicUrl}/admin/tools`)
    for (const target of ['rabbitmq', 'mongo-express', 'rustfs', 'traefik']) await expect(page.locator(`[data-row-id="${target}"]`)).toHaveCount(0)

    for (const [label, href] of [
      ['API reference', '/api/docs'],
      ['OpenAPI document', '/api/docs/openapi.json'],
      ['Metrics', '/api/metrics'],
    ] as const) {
      await expect(page.getByRole('link', { name: new RegExp(`^${label}`) })).toHaveAttribute('href', href)
    }
    await expect(page.getByRole('list', { name: 'Platform components' }).getByRole('listitem').first()).toBeVisible()
    await expect(page.getByLabel('Filter jobs by kind')).toBeVisible()

    // The navigation keeps the Admin tools entry and hides only the editor.
    await expect(sidebarLink(page, 'Admin tools')).toHaveAttribute('href', '/admin/tools')
    await expect(sidebarLink(page, 'Editor')).toHaveCount(0)
  })
})
